/**
 * What a paired camera may do.
 *
 * The camera app has no API key compiled in, only its own device token. Every
 * route it calls before and during a broadcast must accept that token — a route
 * that wants the API key leaves the start button greyed out for every club.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { initServices, devices } from "../state.js";
import type { Device } from "../devices.js";
import restreamerRoutes from "../routes/restreamer-routes.js";
import broadcastRoutes from "../routes/broadcast-routes.js";

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  let stored: Device[] = [];
  const minio = {
    readDeviceIndex: vi.fn(async () => stored),
    writeDeviceIndex: vi.fn(async (d: Device[]) => { stored = d; }),
  };
  const oscManager = {
    getCachedState: () => ({ state: "stopped", info: null }),
    getState: () => "stopped",
  };
  initServices({} as never, minio as never, oscManager as never);

  const { code } = devices.createPairingCode();
  token = (await devices.pair(code, "Testkamera"))!.token;

  app = Fastify();
  await app.register(restreamerRoutes);
  await app.register(broadcastRoutes);
});

afterAll(async () => {
  await app.close();
});

describe("a paired camera", () => {
  it("can see the broadcast engine's state", async () => {
    const res = await app.inject({
      url: "/api/restreamer/status",
      headers: { "x-device-token": token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("stopped");
  });

  it("can tell viewers a match is coming", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/broadcast",
      headers: { "x-device-token": token },
      payload: { status: "upcoming", message: "Test IF vs Gäst" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("is turned away once revoked, with an answer the app recognises", async () => {
    const [device] = await devices.list();
    await devices.revoke(device.id);

    const res = await app.inject({
      url: "/api/restreamer/status",
      headers: { "x-device-token": token },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("not_paired");
  });

  it("still lets the API key in, for scripts", async () => {
    const res = await app.inject({
      url: "/api/restreamer/status",
      headers: { "x-api-key": "test-api-key" },
    });
    expect(res.statusCode).toBe(200);
  });
});
