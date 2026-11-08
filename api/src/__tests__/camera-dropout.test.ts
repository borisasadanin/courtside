/**
 * A camera that loses its connection mid-match must not lose the match.
 *
 * - While the camera keeps asking about its stream, cleanup leaves it alone,
 *   however long the process waits for a camera to send again.
 * - A camera that is gone ends its stream after STREAM_IDLE_LIMIT_MS, counted
 *   from its last sign of life, and the recording is finished like a stop.
 * - An app restarted during a pause gets its stream back resumed.
 * - A stop that arrives twice ends the stream once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));

vi.mock("../pause-segments.js", () => ({
  uploadPauseSegments: vi.fn().mockResolvedValue(undefined),
}));

import { streamMeta, initServices, devices } from "../state.js";
import { config, mutableConfig } from "../config.js";
import { viewers } from "../viewer-tracking.js";
import streamRoutes, { STREAM_IDLE_LIMIT_MS, lastSignOfLife } from "../routes/streams.js";

const osc = {
  getState: vi.fn().mockReturnValue("running"),
  isUp: () => true,
  getInfo: vi.fn().mockReturnValue({ url: "https://restreamer.example.com", rtmpHost: "rtmp.example.com" }),
  ensureRunning: vi.fn(),
  streamStarted: vi.fn(),
  streamEnded: vi.fn(),
  streamPaused: vi.fn(),
  streamResumed: vi.fn(),
  pausedStreamEnded: vi.fn(),
  syncActiveCount: vi.fn(),
};

function restreamerStub() {
  return {
    rtmpHost: "rtmp.example.com",
    createProcess: vi.fn().mockResolvedValue({}),
    deleteProcess: vi.fn().mockResolvedValue(undefined),
    switchPart: vi.fn().mockResolvedValue("switched"),
    listManagedProcesses: vi.fn().mockResolvedValue([]),
    getProcess: vi.fn().mockResolvedValue(null),
    isHlsLive: vi.fn().mockResolvedValue(false),
    rtmpUrl: (id: string) => `rtmp://rtmp.example.com/live/${id}`,
    hlsUrl: (id: string) => `https://restreamer.example.com/memfs/${id}.m3u8`,
  };
}

function storageStub() {
  return {
    addVodEntry: vi.fn().mockResolvedValue(undefined),
    updateVodEntry: vi.fn().mockResolvedValue(true),
    readVodIndex: vi.fn().mockResolvedValue([]),
    writeVodIndex: vi.fn().mockResolvedValue(undefined),
    writeStreamMetaIndex: vi.fn().mockResolvedValue(undefined),
    uploadBuffer: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(null),
    fileExists: vi.fn().mockResolvedValue(false),
  };
}

const auth = { "x-api-key": config.API_KEY };
const jsonAuth = { ...auth, "content-type": "application/json" };
const MINUTE = 60_000;

describe("a camera that drops out mid-match", () => {
  let app: FastifyInstance;
  let restreamer: ReturnType<typeof restreamerStub>;
  let storage: ReturnType<typeof storageStub>;
  let streamId: string;

  const process = (id: string, exec = "finished") => ({
    config: { id: `${config.PROCESS_PREFIX}${id}` },
    state: { exec },
    created_at: Math.floor(Date.now() / 1000) - 3600,
  });
  /** What the app does every ten seconds while it is open. */
  const cameraPolls = () =>
    app.inject({ method: "GET", url: `/api/streams/${streamId}`, headers: { "x-device-token": "camera" } });

  beforeEach(async () => {
    streamMeta.clear();
    viewers.clear();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
    (mutableConfig as { VIEWER_PIN: string }).VIEWER_PIN = "";

    restreamer = restreamerStub();
    storage = storageStub();
    initServices(restreamer as never, storage as never, osc as never);
    // The paired camera's token checks out
    vi.spyOn(devices, "verify").mockResolvedValue({ id: "phone-1" } as never);

    app = Fastify({ logger: false });
    await app.register(streamRoutes);
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/streams",
      headers: jsonAuth,
      payload: { name: "Kamera 1", deviceId: "phone-1" },
    });
    streamId = res.json().id;
  });

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the stream while the camera keeps asking, however long it cannot send", async () => {
    // Live for a while, then the connection drops
    restreamer.listManagedProcesses.mockResolvedValue([process(streamId, "running")]);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    restreamer.listManagedProcesses.mockResolvedValue([process(streamId, "failed")]);

    for (let t = 0; t < 30 * MINUTE; t += 10_000) {
      expect((await cameraPolls()).statusCode).toBe(200);
      await vi.advanceTimersByTimeAsync(10_000);
    }

    expect(streamMeta.get(streamId)?.stoppedAt).toBeUndefined();
    expect(restreamer.deleteProcess).not.toHaveBeenCalled();
  });

  it("does not end a stream a minute into a drop, as it used to", async () => {
    restreamer.listManagedProcesses.mockResolvedValue([process(streamId, "running")]);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    restreamer.listManagedProcesses.mockResolvedValue([process(streamId, "finished")]);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);

    expect(streamMeta.get(streamId)?.stoppedAt).toBeUndefined();
  });

  it("ends a stream whose camera is gone, and finishes its recording", async () => {
    restreamer.listManagedProcesses.mockResolvedValue([process(streamId, "running")]);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    const lastRunning = Date.now();
    restreamer.listManagedProcesses.mockResolvedValue([process(streamId, "finished")]);

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_LIMIT_MS - 2 * MINUTE);
    expect(streamMeta.get(streamId)?.stoppedAt).toBeUndefined();

    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    const meta = streamMeta.get(streamId)!;
    expect(meta.stoppedAt).toBeTruthy();
    expect(Date.parse(meta.stoppedAt!) - lastRunning).toBeGreaterThan(STREAM_IDLE_LIMIT_MS);
    expect(storage.updateVodEntry).toHaveBeenCalledWith(streamId, expect.objectContaining({ stoppedAt: meta.stoppedAt }));
    expect(restreamer.deleteProcess).toHaveBeenCalledWith(streamId);
  });

  it("resumes the stream for an app restarted during a pause", async () => {
    await app.inject({ method: "PATCH", url: `/api/streams/${streamId}/pause`, headers: auth });

    const res = await app.inject({
      method: "POST",
      url: "/api/streams",
      headers: jsonAuth,
      payload: { name: "Kamera 1", deviceId: "phone-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(streamId);
    expect(restreamer.switchPart).toHaveBeenCalledWith(streamId, 2);
    expect(osc.streamResumed).toHaveBeenCalled();
    expect(osc.streamStarted).toHaveBeenCalledTimes(1); // only when it was created
    expect(streamMeta.get(streamId)).toMatchObject({ partNumber: 2, periodNumber: 2 });
    expect(streamMeta.get(streamId)?.pausedAt).toBeUndefined();
  });

  it("keeps the pause if the returning camera's stream cannot be resumed", async () => {
    await app.inject({ method: "PATCH", url: `/api/streams/${streamId}/pause`, headers: auth });
    restreamer.switchPart.mockRejectedValueOnce(new Error("restreamer busy"));

    const res = await app.inject({
      method: "POST",
      url: "/api/streams",
      headers: jsonAuth,
      payload: { name: "Kamera 1", deviceId: "phone-1" },
    });

    expect(res.statusCode).toBe(409);
    expect(streamMeta.get(streamId)?.pausedAt).toBeTruthy();
    expect(streamMeta.get(streamId)?.partNumber).toBe(1);
  });

  it("does not mark a long match that is still live as ended", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * MINUTE).toISOString();
    storage.readVodIndex.mockResolvedValue([
      { id: streamId, createdAt: twoHoursAgo },
      { id: "crashed", createdAt: twoHoursAgo },
    ]);

    await vi.advanceTimersByTimeAsync(11_000); // the finalizer's first run

    expect(storage.updateVodEntry).not.toHaveBeenCalledWith(streamId, expect.anything());
    expect(storage.updateVodEntry).toHaveBeenCalledWith("crashed", { stoppedAt: twoHoursAgo });
  });

  it("ends a stream once when the stop arrives twice", async () => {
    await app.inject({ method: "DELETE", url: `/api/streams/${streamId}`, headers: auth });
    await app.inject({ method: "DELETE", url: `/api/streams/${streamId}`, headers: auth });

    expect(osc.streamEnded).toHaveBeenCalledTimes(1);
    expect(storage.updateVodEntry).toHaveBeenCalledTimes(1);
  });
});

describe("lastSignOfLife", () => {
  it("is the latest of created, running and camera seen", () => {
    const meta = { name: "k", createdAt: new Date(1000).toISOString(), partNumber: 1, periodNumber: 1, completedParts: [] };
    expect(lastSignOfLife(meta)).toBe(1000);
    expect(lastSignOfLife({ ...meta, lastRunningAt: 5000, cameraSeenAt: 3000 })).toBe(5000);
    expect(lastSignOfLife({ ...meta, lastRunningAt: 5000, cameraSeenAt: 9000 })).toBe(9000);
  });
});
