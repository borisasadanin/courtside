import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock @osaas/client-core so OscInstanceManager can be constructed
// without a real OSC_ACCESS_TOKEN
vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {
    async getServiceAccessToken() { return "sat"; }
  },
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));

import { OscInstanceManager } from "../osc-manager.js";

// An instance nobody streams to is shut down after the grace period, however
// it was started: a match that ended, or the start button in the camera app.

const GRACE_MS = 60_000;
const INFO = { url: "https://restreamer.example.com", rtmpHost: "rtmp.example.com:1935" };

describe("OscInstanceManager idle shutdown", () => {
  let manager: OscInstanceManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new OscInstanceManager({
      instanceName: "test-instance",
      gracePeriodMs: GRACE_MS,
      logger: { info: () => {}, error: () => {} },
    });
    const internals = manager as unknown as Record<string, unknown>;
    internals.startInstance = vi.fn().mockResolvedValue(INFO);
    internals.verifyRtmpEnabled = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shuts down an instance started by hand when nobody streams", async () => {
    await manager.ensureRunning();
    expect(manager.getState()).toBe("stopping");
    expect(manager.getShutdownInSeconds()).toBe(GRACE_MS / 1000);

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(manager.getState()).toBe("stopped");
    expect(manager.getShutdownInSeconds()).toBeNull();
  });

  it("counts down while the grace period runs", async () => {
    await manager.ensureRunning();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(manager.getShutdownInSeconds()).toBe(40);
  });

  it("keeps the instance up once a stream starts", async () => {
    await manager.ensureRunning();
    manager.streamStarted();
    expect(manager.getState()).toBe("running");
    expect(manager.getShutdownInSeconds()).toBeNull();

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(manager.getState()).toBe("running");
  });

  it("starts the full period again when started during the countdown", async () => {
    await manager.ensureRunning();
    await vi.advanceTimersByTimeAsync(40_000);
    await manager.ensureRunning();
    expect(manager.getShutdownInSeconds()).toBe(GRACE_MS / 1000);

    await vi.advanceTimersByTimeAsync(40_000);
    expect(manager.getState()).toBe("stopping");
  });

  it("counts down after the last stream ends", async () => {
    await manager.ensureRunning();
    manager.streamStarted();
    manager.streamEnded();
    expect(manager.getState()).toBe("stopping");

    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(manager.getState()).toBe("stopped");
  });

  it("keeps the instance up for a paused stream", async () => {
    await manager.ensureRunning();
    manager.streamStarted();
    manager.streamPaused();

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(manager.getState()).toBe("running");
  });

  it("follows the stream count from the cleanup round", async () => {
    await manager.ensureRunning();
    manager.syncActiveCount(1);
    expect(manager.getState()).toBe("running");
    expect(manager.getShutdownInSeconds()).toBeNull();

    manager.syncActiveCount(0);
    expect(manager.getState()).toBe("stopping");
  });
});
