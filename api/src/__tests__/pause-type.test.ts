/**
 * ABL-001: a timeout pauses the broadcast like a period break, but only a
 * period break moves the match on to the next period.
 *
 * ABL-005: either way, the Restreamer process stands by through the pause.
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

import { streamMeta, initServices } from "../state.js";
import { config, mutableConfig } from "../config.js";
import { uploadPauseSegments } from "../pause-segments.js";
import { viewers } from "../viewer-tracking.js";
import streamRoutes from "../routes/streams.js";

const osc = {
  getState: vi.fn().mockReturnValue("running"),
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
    updateVodEntry: vi.fn().mockResolvedValue(undefined),
    readVodIndex: vi.fn().mockResolvedValue([]),
    writeVodIndex: vi.fn().mockResolvedValue(undefined),
    writeStreamMetaIndex: vi.fn().mockResolvedValue(undefined),
    uploadBuffer: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(null),
  };
}

const auth = { "x-api-key": config.API_KEY };
const jsonAuth = { ...auth, "content-type": "application/json" };

describe("pause types", () => {
  let app: FastifyInstance;
  let restreamer: ReturnType<typeof restreamerStub>;
  let streamId: string;

  const pause = (payload?: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/streams/${streamId}/pause`,
      headers: payload ? jsonAuth : auth,
      ...(payload ? { payload } : {}),
    });
  const resume = () => app.inject({ method: "PATCH", url: `/api/streams/${streamId}/resume`, headers: auth });
  const get = () => app.inject({ method: "GET", url: `/api/streams/${streamId}` });

  beforeEach(async () => {
    streamMeta.clear();
    viewers.clear();
    vi.clearAllMocks();
    (mutableConfig as { VIEWER_PIN: string }).VIEWER_PIN = "";

    restreamer = restreamerStub();
    initServices(restreamer as never, storageStub() as never, osc as never);

    app = Fastify({ logger: false });
    await app.register(streamRoutes);
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/api/streams", headers: jsonAuth, payload: { name: "Kamera 1" } });
    streamId = res.json().id;
  });

  afterEach(async () => {
    await app.close();
  });

  it("starts a new stream in period 1", () => {
    expect(streamMeta.get(streamId)?.periodNumber).toBe(1);
  });

  it("treats a pause without a body as a period break, as before", async () => {
    const res = await pause();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "paused", pauseType: "period" });
    expect(streamMeta.get(streamId)?.pauseType).toBe("period");
  });

  it("pauses a timeout the same way as a period break", async () => {
    const res = await pause({ type: "timeout" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "paused", pauseType: "timeout" });
    const meta = streamMeta.get(streamId)!;
    expect(meta.pausedAt).toBeTruthy();
    expect(meta.completedParts).toEqual([1]);
    expect(uploadPauseSegments).toHaveBeenCalledWith(expect.anything(), streamId, 1);
    expect(osc.streamPaused).toHaveBeenCalled();
  });

  it("keeps the period after a timeout and moves on after a period break", async () => {
    await pause({ type: "timeout" });
    await resume();
    expect(streamMeta.get(streamId)).toMatchObject({ periodNumber: 1, partNumber: 2 });

    await pause({ type: "period" });
    const res = await resume();
    expect(res.json()).toMatchObject({ partNumber: 3, period: 2 });
    expect(streamMeta.get(streamId)?.pauseType).toBeUndefined();
  });

  it("counts period → timeout → period as period 3, part 4", async () => {
    for (const type of ["period", "timeout", "period"]) {
      await pause({ type });
      await resume();
    }
    expect(streamMeta.get(streamId)).toMatchObject({ periodNumber: 3, partNumber: 4 });
  });

  it("rejects an unknown pause type and leaves the stream live", async () => {
    const res = await pause({ type: "nonsens" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_pause_type");
    expect(streamMeta.get(streamId)?.pausedAt).toBeUndefined();
    expect(restreamer.deleteProcess).not.toHaveBeenCalled();
  });

  it("still refuses a second pause", async () => {
    await pause({ type: "timeout" });
    const res = await pause({ type: "period" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_paused");
    expect(streamMeta.get(streamId)?.pauseType).toBe("timeout");
  });

  it("tells viewers which pause it is, and nothing once the match is back", async () => {
    await pause({ type: "timeout" });
    expect((await get()).json()).toMatchObject({ status: "paused", pauseType: "timeout", period: 1 });

    await resume();
    const body = (await get()).json();
    expect(body.status).not.toBe("paused");
    expect(body).not.toHaveProperty("pauseType");
    expect(body.period).toBe(1);
  });

  it("shows the pause type in the stream list too", async () => {
    await pause({ type: "timeout" });
    const list = (await app.inject({ method: "GET", url: "/api/streams" })).json();
    expect(list.find((s: { id: string }) => s.id === streamId)).toMatchObject({ status: "paused", pauseType: "timeout" });
  });

  it("puts the period back if the stream cannot be resumed", async () => {
    await pause({ type: "period" });
    restreamer.switchPart.mockRejectedValueOnce(new Error("restreamer down"));

    const res = await resume();

    expect(res.statusCode).toBe(500);
    expect(streamMeta.get(streamId)).toMatchObject({ periodNumber: 1, partNumber: 1, pauseType: "period" });
    expect(streamMeta.get(streamId)?.pausedAt).toBeTruthy();
  });
});

describe("standby through a pause", () => {
  let app: FastifyInstance;
  let restreamer: ReturnType<typeof restreamerStub>;
  let streamId: string;
  const logged: string[] = [];

  beforeEach(async () => {
    streamMeta.clear();
    viewers.clear();
    vi.clearAllMocks();
    logged.length = 0;
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
    (mutableConfig as { VIEWER_PIN: string }).VIEWER_PIN = "";

    restreamer = restreamerStub();
    initServices(restreamer as never, storageStub() as never, osc as never);

    const logger = {
      level: "info",
      info: (msg: unknown) => logged.push(String(msg)),
      warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
      child() { return this; },
    };
    app = Fastify({ loggerInstance: logger as never }) as unknown as FastifyInstance;
    await app.register(streamRoutes);
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/api/streams", headers: jsonAuth, payload: { name: "Kamera 1" } });
    streamId = res.json().id;
  });

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  const process = (id: string, exec = "finished", ageS = 3600) => ({
    config: { id: `${config.PROCESS_PREFIX}${id}` },
    state: { exec },
    created_at: Math.floor(Date.now() / 1000) - ageS,
  });

  it("keeps the Restreamer process when pausing", async () => {
    await app.inject({ method: "PATCH", url: `/api/streams/${streamId}/pause`, headers: auth });

    expect(restreamer.deleteProcess).not.toHaveBeenCalled();
  });

  it("resumes by pointing the kept process at the next part", async () => {
    await app.inject({ method: "PATCH", url: `/api/streams/${streamId}/pause`, headers: auth });
    await app.inject({ method: "PATCH", url: `/api/streams/${streamId}/resume`, headers: auth });

    expect(restreamer.switchPart).toHaveBeenCalledWith(streamId, 2);
    expect(restreamer.createProcess).toHaveBeenCalledTimes(1); // only when the stream was created
    expect(restreamer.deleteProcess).not.toHaveBeenCalled();
  });

  it("leaves a paused stream's process alone, however long the pause", async () => {
    await app.inject({ method: "PATCH", url: `/api/streams/${streamId}/pause`, headers: auth });
    restreamer.listManagedProcesses.mockResolvedValue([process(streamId)]);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(restreamer.deleteProcess).not.toHaveBeenCalled();
    expect(streamMeta.get(streamId)?.stoppedAt).toBeUndefined();
  });

  it("removes a process no stream owns", async () => {
    restreamer.listManagedProcesses.mockResolvedValue([process(streamId, "running", 60), process("ghost", "running")]);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(restreamer.deleteProcess).toHaveBeenCalledWith("ghost");
    expect(restreamer.deleteProcess).not.toHaveBeenCalledWith(streamId);
  });

  it("removes the process of a stopped stream the stop route could not delete", async () => {
    restreamer.deleteProcess.mockRejectedValueOnce(new Error("restreamer busy"));
    await app.inject({ method: "DELETE", url: `/api/streams/${streamId}`, headers: auth });
    restreamer.deleteProcess.mockClear();
    restreamer.listManagedProcesses.mockResolvedValue([process(streamId, "running")]);
    vi.setSystemTime(Date.now() + 3 * 60 * 1000);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(restreamer.deleteProcess).toHaveBeenCalledWith(streamId);
  });

  it("logs how long it took for the match to be live again after a resume", async () => {
    await app.inject({ method: "PATCH", url: `/api/streams/${streamId}/pause`, headers: auth });
    await app.inject({ method: "PATCH", url: `/api/streams/${streamId}/resume`, headers: auth });
    restreamer.getProcess.mockResolvedValue(process(streamId, "running"));
    restreamer.isHlsLive.mockResolvedValue(true);
    vi.setSystemTime(Date.now() + 4000);

    await app.inject({ method: "GET", url: `/api/streams/${streamId}` });
    await app.inject({ method: "GET", url: `/api/streams/${streamId}` });

    const timings = logged.filter((l) => l.includes("live again"));
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatch(/live again 4\d{3} ms/);
  });
});
