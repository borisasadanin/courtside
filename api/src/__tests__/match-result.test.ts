/**
 * Match results (ABL-039).
 *
 * The camera reports the score right after the match and the admin can set or
 * correct it at any time. What matters most is who may write when: a camera
 * coming back a day later must not overwrite the admin's correction.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { initServices, devices } from "../state.js";
import { createAdminToken, createViewerToken } from "../auth.js";
import { mutableConfig } from "../config.js";
import type { Device } from "../devices.js";
import type { VodEntry } from "../types.js";

const HOUR = 60 * 60 * 1000;

function entry(id: string, stoppedMsAgo?: number): VodEntry {
  const now = Date.now();
  return {
    id,
    matchTitle: "Test IF vs Gäst",
    location: "Hallen",
    homeTeam: "Test IF",
    awayTeam: "Gäst",
    matchDate: new Date(now).toISOString().slice(0, 10),
    cameraName: "Läktaren",
    hlsUrl: `/api/vod/${id}/playlist.m3u8`,
    createdAt: new Date(now - 2 * HOUR).toISOString(),
    ...(stoppedMsAgo !== undefined && { stoppedAt: new Date(now - stoppedMsAgo).toISOString(), durationSeconds: 3600 }),
  };
}

let vods: VodEntry[] = [];
let app: FastifyInstance;
let camera: Record<string, string>;
let admin: Record<string, string>;

beforeAll(async () => {
  let storedDevices: Device[] = [];
  const minio = {
    readDeviceIndex: vi.fn(async () => storedDevices),
    writeDeviceIndex: vi.fn(async (d: Device[]) => { storedDevices = d; }),
    readVodIndex: vi.fn(async () => structuredClone(vods)),
    updateVodEntry: vi.fn(async (id: string, update: Partial<VodEntry>) => {
      const i = vods.findIndex((v) => v.id === id);
      if (i === -1) return false;
      // Through JSON, as in storage: a field set to undefined disappears.
      vods[i] = JSON.parse(JSON.stringify({ ...vods[i], ...update }));
      return true;
    }),
  };
  initServices({} as never, minio as never, {} as never);

  const { code } = devices.createPairingCode();
  camera = { "x-device-token": (await devices.pair(code, "Testkamera"))!.token };
  admin = { "x-admin-token": createAdminToken() };

  const { default: vodRoutes } = await import("../routes/vod.js");
  app = Fastify();
  await app.register(vodRoutes);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vods = [entry("justnow", 60_000), entry("yesterday", 25 * HOUR), entry("live")];
});

function put(id: string, headers: Record<string, string>, payload: unknown) {
  return app.inject({ method: "PUT", url: `/api/vod/${id}/result`, headers, payload: payload as object });
}

const stored = (id: string) => vods.find((v) => v.id === id)!.result;

describe("the camera", () => {
  it("reports the score right after the match", async () => {
    const res = await put("justnow", camera, { home: 72, away: 65 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ home: 72, away: 65, setBy: "camera" });
    expect(stored("justnow")).toMatchObject({ home: 72, away: 65, setBy: "camera" });
  });

  it("may report before the stop has reached the index", async () => {
    const res = await put("live", camera, { home: 0, away: 0 });
    expect(res.statusCode).toBe(200);
    expect(stored("live")).toMatchObject({ home: 0, away: 0 });
  });

  it("cannot change a result more than a day after the match", async () => {
    const res = await put("yesterday", camera, { home: 1, away: 2 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("result_locked");
    expect(stored("yesterday")).toBeUndefined();
  });

  it("cannot remove a result", async () => {
    vods[0].result = { home: 1, away: 2, setBy: "camera", setAt: new Date().toISOString() };
    const res = await app.inject({ method: "DELETE", url: "/api/vod/justnow/result", headers: camera });
    expect(res.statusCode).toBe(401);
    expect(stored("justnow")).toBeDefined();
  });

  it("cannot claim to be the admin", async () => {
    await put("justnow", camera, { home: 3, away: 4, setBy: "admin" });
    expect(stored("justnow")?.setBy).toBe("camera");
  });
});

describe("the admin", () => {
  it("sets a result long after the match", async () => {
    const res = await put("yesterday", admin, { home: 50, away: 48 });
    expect(res.statusCode).toBe(200);
    expect(stored("yesterday")).toMatchObject({ home: 50, away: 48, setBy: "admin" });
  });

  it("corrects what the camera reported", async () => {
    await put("justnow", camera, { home: 72, away: 65 });
    await put("justnow", admin, { home: 72, away: 66 });
    expect(stored("justnow")).toMatchObject({ home: 72, away: 66, setBy: "admin" });
  });

  it("removes a result", async () => {
    await put("justnow", admin, { home: 1, away: 1 });
    const res = await app.inject({ method: "DELETE", url: "/api/vod/justnow/result", headers: admin });
    expect(res.statusCode).toBe(204);
    expect(stored("justnow")).toBeUndefined();
    expect(vods[0]).not.toHaveProperty("result");
  });

  it("gets 404 for a recording that does not exist", async () => {
    expect((await put("nope", admin, { home: 1, away: 1 })).statusCode).toBe(404);
    const res = await app.inject({ method: "DELETE", url: "/api/vod/nope/result", headers: admin });
    expect(res.statusCode).toBe(404);
  });
});

describe("validation", () => {
  it.each([
    { home: -1, away: 0 },
    { home: 1000, away: 0 },
    { home: 1.5, away: 0 },
    { home: "72", away: 65 },
    { home: 72 },
    {},
  ])("refuses %j", async (payload) => {
    const res = await put("justnow", admin, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_result");
    expect(stored("justnow")).toBeUndefined();
  });
});

describe("without the right credentials", () => {
  it("refuses an anonymous request", async () => {
    expect((await put("justnow", {}, { home: 1, away: 1 })).statusCode).toBe(401);
  });

  it("refuses a viewer", async () => {
    const before = mutableConfig.VIEWER_PIN;
    mutableConfig.VIEWER_PIN = "1234";
    try {
      const viewer = { authorization: `Bearer ${createViewerToken()}` };
      expect((await put("justnow", viewer, { home: 1, away: 1 })).statusCode).toBe(401);
    } finally {
      mutableConfig.VIEWER_PIN = before;
    }
  });
});
