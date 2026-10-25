import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock @osaas/client-core so OscInstanceManager can be constructed
// without a real OSC_ACCESS_TOKEN
vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));

import { OscInstanceManager } from "../osc-manager.js";

// We test the public pause-related methods on OscInstanceManager,
// verifying the counting logic without needing real OSC infrastructure.

describe("OscInstanceManager pause tracking", () => {
  let manager: OscInstanceManager;

  beforeEach(() => {
    manager = new OscInstanceManager({
      instanceName: "test-instance",
      gracePeriodMs: 1000,
      logger: { info: () => {}, error: () => {} },
    });
  });

  it("streamPaused decrements active count", () => {
    manager.streamStarted();
    manager.streamStarted();
    expect(manager.getActiveStreamCount()).toBe(2);

    manager.streamPaused();
    expect(manager.getActiveStreamCount()).toBe(1);
  });

  it("streamResumed increments active count", () => {
    manager.streamStarted();
    manager.streamPaused();
    expect(manager.getActiveStreamCount()).toBe(0);

    manager.streamResumed();
    expect(manager.getActiveStreamCount()).toBe(1);
  });

  it("pausedStreamEnded does not affect active count", () => {
    manager.streamStarted();
    manager.streamPaused();
    expect(manager.getActiveStreamCount()).toBe(0);

    manager.pausedStreamEnded();
    expect(manager.getActiveStreamCount()).toBe(0);
  });

  it("active count never goes below 0", () => {
    manager.streamPaused();
    expect(manager.getActiveStreamCount()).toBe(0);

    manager.streamPaused();
    expect(manager.getActiveStreamCount()).toBe(0);
  });
});

// ABL-005: the instance stands by through a pause, however long it is.
describe("OscInstanceManager standby during a pause", () => {
  let manager: OscInstanceManager;
  // Reach the internals the background poll would otherwise drive.
  let internals: {
    state: string;
    cachedInfo: unknown;
    ctx: { getServiceAccessToken: () => Promise<string> };
    backgroundHealthCheck: () => Promise<string>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new OscInstanceManager({
      instanceName: "test-instance",
      gracePeriodMs: 60 * 60 * 1000,
      logger: { info: () => {}, error: () => {} },
    });
    internals = manager as unknown as typeof internals;
    internals.state = "running";
    internals.cachedInfo = { url: "https://restreamer.example.com", rtmpHost: "rtmp.example.com" };
    internals.ctx = { getServiceAccessToken: async () => "sat" };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never starts the shutdown timer while a stream is paused", () => {
    manager.streamStarted();
    manager.streamPaused();
    manager.syncActiveCount(0); // what the cleanup timer reports during a pause

    vi.advanceTimersByTime(5 * 60 * 60 * 1000);

    expect(manager.getState()).toBe("running");
  });

  it("still shuts down an hour after the last stream is stopped", () => {
    manager.streamStarted();
    manager.streamPaused();
    manager.pausedStreamEnded();

    expect(manager.getState()).toBe("stopping");
  });

  it("starts the instance again if it is lost during a pause", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unreachable")));
    const ensureRunning = vi.spyOn(manager, "ensureRunning").mockResolvedValue({ url: "u", rtmpHost: "r" });
    manager.streamStarted();
    manager.streamPaused();

    for (let i = 0; i < 3; i++) await internals.backgroundHealthCheck();

    expect(ensureRunning).toHaveBeenCalledTimes(1);
  });

  it("leaves a lost instance alone when nothing is waiting for it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unreachable")));
    const ensureRunning = vi.spyOn(manager, "ensureRunning");

    for (let i = 0; i < 3; i++) await internals.backgroundHealthCheck();

    expect(manager.getState()).toBe("stopped");
    expect(ensureRunning).not.toHaveBeenCalled();
  });
});
