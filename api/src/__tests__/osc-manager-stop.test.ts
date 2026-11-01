import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {
    async getServiceAccessToken() {
      return "sat";
    }
  },
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));

import { removeInstance } from "@osaas/client-core";
import { OscInstanceManager } from "../osc-manager.js";

describe("OscInstanceManager.forceStop", () => {
  let manager: OscInstanceManager;

  beforeEach(() => {
    vi.mocked(removeInstance).mockReset();
    manager = new OscInstanceManager({
      instanceName: "test-instance",
      logger: { info: () => {}, error: () => {} },
    });
    // A running instance, as after a start.
    const m = manager as unknown as { state: string; cachedInfo: unknown };
    m.state = "running";
    m.cachedInfo = { url: "https://restreamer.example", rtmpHost: "1.2.3.4:1935" };
  });

  it("is stopped once OSC has removed the instance", async () => {
    vi.mocked(removeInstance).mockResolvedValue(undefined);
    await manager.forceStop();
    expect(manager.getState()).toBe("stopped");
    expect(manager.getInfo()).toBeNull();
  });

  it("says so when OSC would not remove it, and stays running", async () => {
    vi.mocked(removeInstance).mockRejectedValue(new Error("OSC said no"));
    await expect(manager.forceStop()).rejects.toThrow("OSC said no");
    expect(manager.getState()).toBe("running");
    expect(manager.getInfo()).not.toBeNull();
  });
});
