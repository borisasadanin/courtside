/**
 * Stopping the broadcast engine. Any paired camera may press stop, so the
 * backend refuses while someone is streaming or a match is paused: one camera
 * must not cut off another's match.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { initServices } from "../state.js";
import restreamerRoutes from "../routes/restreamer-routes.js";

let app: FastifyInstance;
const oscManager = {
  getActiveStreamCount: vi.fn(() => 0),
  getPausedStreamCount: vi.fn(() => 0),
  forceStop: vi.fn(async () => {}),
};

beforeAll(async () => {
  initServices({} as never, {} as never, oscManager as never);
  app = Fastify();
  await app.register(restreamerRoutes);
});

beforeEach(() => {
  oscManager.getActiveStreamCount.mockReturnValue(0);
  oscManager.getPausedStreamCount.mockReturnValue(0);
  oscManager.forceStop.mockClear();
});

afterAll(async () => {
  await app.close();
});

function stop() {
  return app.inject({
    method: "DELETE",
    url: "/api/restreamer/stop",
    headers: { "x-api-key": "test-api-key" },
  });
}

describe("DELETE /api/restreamer/stop", () => {
  it("stops the engine when nobody is using it", async () => {
    const res = await stop();
    expect(res.statusCode).toBe(204);
    expect(oscManager.forceStop).toHaveBeenCalledOnce();
  });

  it("refuses while a stream is live", async () => {
    oscManager.getActiveStreamCount.mockReturnValue(1);
    const res = await stop();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "streams_active", activeStreams: 1, pausedStreams: 0 });
    expect(res.json().message).toContain("en sändning pågår");
    expect(oscManager.forceStop).not.toHaveBeenCalled();
  });

  it("refuses while a match is paused", async () => {
    oscManager.getPausedStreamCount.mockReturnValue(2);
    const res = await stop();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "streams_active", activeStreams: 0, pausedStreams: 2 });
    expect(res.json().message).toContain("2 matcher är pausade");
    expect(oscManager.forceStop).not.toHaveBeenCalled();
  });
});
