/**
 * ABL-051: two teams broadcast separate matches from two phones into one
 * installation. Each camera's reports apply to its own match, and the page's
 * status never lets one match ending or pausing hide the other.
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
import type { Device } from "../devices.js";
import { mutableConfig } from "../config.js";
import { viewers } from "../viewer-tracking.js";
import { resetBroadcastState } from "../broadcast-state.js";
import streamRoutes from "../routes/streams.js";
import broadcastRoutes from "../routes/broadcast-routes.js";

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
  let stored: Device[] = [];
  return {
    addVodEntry: vi.fn().mockResolvedValue(undefined),
    updateVodEntry: vi.fn().mockResolvedValue(undefined),
    readVodIndex: vi.fn().mockResolvedValue([]),
    writeVodIndex: vi.fn().mockResolvedValue(undefined),
    writeStreamMetaIndex: vi.fn().mockResolvedValue(undefined),
    readStreamMetaIndex: vi.fn().mockResolvedValue({}),
    uploadBuffer: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(null),
    readDeviceIndex: vi.fn(async () => stored),
    writeDeviceIndex: vi.fn(async (d: Device[]) => { stored = d; }),
  };
}

describe("parallel matches", () => {
  let app: FastifyInstance;
  let cameraA: Record<string, string>;
  let cameraB: Record<string, string>;

  async function pair(name: string): Promise<Record<string, string>> {
    const { code } = devices.createPairingCode();
    const { token } = (await devices.pair(code, name))!;
    return { "x-device-token": token };
  }

  const status = async () => (await app.inject({ url: "/api/broadcast" })).json();
  const report = (camera: Record<string, string>, payload: Record<string, string>) =>
    app.inject({ method: "PATCH", url: "/api/broadcast", headers: camera, payload });
  const start = async (camera: Record<string, string>, name: string): Promise<string> => {
    const res = await app.inject({ method: "POST", url: "/api/streams", headers: camera, payload: { name } });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  };
  const pause = (camera: Record<string, string>, id: string) =>
    app.inject({ method: "PATCH", url: `/api/streams/${id}/pause`, headers: camera });
  const resume = (camera: Record<string, string>, id: string) =>
    app.inject({ method: "PATCH", url: `/api/streams/${id}/resume`, headers: camera });
  const stop = (camera: Record<string, string>, id: string) =>
    app.inject({ method: "DELETE", url: `/api/streams/${id}`, headers: camera });

  beforeEach(async () => {
    streamMeta.clear();
    viewers.clear();
    vi.clearAllMocks();
    resetBroadcastState();
    (mutableConfig as { VIEWER_PIN: string }).VIEWER_PIN = "";

    initServices(restreamerStub() as never, storageStub() as never, osc as never);
    cameraA = await pair("P12-kameran");
    cameraB = await pair("F14-kameran");

    app = Fastify({ logger: false });
    await app.register(streamRoutes);
    await app.register(broadcastRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("keeps the page live while one match ends and the other goes on", async () => {
    const a = await start(cameraA, "P12");
    const b = await start(cameraB, "F14");

    expect((await stop(cameraA, a)).statusCode).toBe(204);
    expect((await status()).status).toBe("live");

    const list = (await app.inject({ url: "/api/streams" })).json();
    expect(list.find((s: { id: string }) => s.id === a).status).toBe("stopped");
    expect(list.find((s: { id: string }) => s.id === b).status).toBe("waiting");

    await stop(cameraB, b);
    expect((await status()).status).toBe("ended");
  });

  it("keeps the page live while one match pauses, and says paused only when both are", async () => {
    const a = await start(cameraA, "P12");
    const b = await start(cameraB, "F14");

    await pause(cameraA, a);
    expect((await status()).status).toBe("live");

    await pause(cameraB, b);
    expect((await status()).status).toBe("paused");

    await resume(cameraA, a);
    expect((await status()).status).toBe("live");
  });

  it("keeps a match announced during another one until its camera starts it", async () => {
    const a = await start(cameraA, "P12");
    await report(cameraB, { status: "upcoming", message: "F14 vs Hammarby" });

    let state = await status();
    expect(state.status).toBe("live");
    expect(state.upcoming.map((u: { message: string }) => u.message)).toEqual(["F14 vs Hammarby"]);

    // The live match ending used to overwrite the announcement with "ended"
    await stop(cameraA, a);
    state = await status();
    expect(state.status).toBe("upcoming");
    expect(state.message).toBe("F14 vs Hammarby");

    await start(cameraB, "F14");
    state = await status();
    expect(state.status).toBe("live");
    expect(state.upcoming).toEqual([]);
  });

  it("lets an older app announce its match the way it always has", async () => {
    const res = await report(cameraA, { status: "upcoming", message: "P12 vs AIK" });
    expect(res.statusCode).toBe(200);
    // What the app decodes: status, message, updatedAt
    expect(res.json()).toMatchObject({ status: "upcoming", message: "P12 vs AIK" });
    expect(typeof res.json().updatedAt).toBe("string");

    await start(cameraA, "P12");
    expect((await status()).status).toBe("live");
  });

  it("does not let an older app's \"ended\" or \"idle\" hide another camera's live match", async () => {
    await start(cameraB, "F14");

    expect((await report(cameraA, { status: "ended" })).json().status).toBe("live");
    expect((await report(cameraA, { status: "idle" })).json().status).toBe("live");
    expect((await status()).status).toBe("live");
  });

  it("still turns away an unknown status", async () => {
    const res = await report(cameraA, { status: "halftime" });
    expect(res.statusCode).toBe(400);
  });
});
