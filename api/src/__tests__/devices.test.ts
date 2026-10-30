/**
 * Camera pairing.
 *
 * The property that matters: a camera's permission can be taken away on its
 * own. A shared key cannot do that, which is why this exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeviceRegistry, hashToken, generatePairingCode, type Device } from "../devices.js";
import { pairingLink } from "../routes/device-routes.js";

function mockMinio() {
  let stored: Device[] = [];
  return {
    readDeviceIndex: vi.fn(async () => stored),
    writeDeviceIndex: vi.fn(async (d: Device[]) => { stored = JSON.parse(JSON.stringify(d)); }),
    get stored() { return stored; },
  };
}

describe("pairing codes", () => {
  it("avoids characters that are misread aloud", () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePairingCode()).not.toMatch(/[OI01]/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, generatePairingCode));
    expect(seen.size).toBe(500);
  });
});

describe("DeviceRegistry", () => {
  let minio: ReturnType<typeof mockMinio>;
  let registry: DeviceRegistry;

  beforeEach(() => {
    minio = mockMinio();
    registry = new DeviceRegistry(minio as never);
  });

  it("exchanges a code for a token and registers the camera", async () => {
    const { code } = registry.createPairingCode();
    const result = await registry.pair(code, "Boris iPhone");

    expect(result).not.toBeNull();
    expect(result!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result!.device.name).toBe("Boris iPhone");
    expect(await registry.verify(result!.token)).not.toBeNull();
  });

  it("stores only a hash, so a leaked registry grants nothing", async () => {
    const { code } = registry.createPairingCode();
    const { token } = (await registry.pair(code, "Kamera"))!;

    const persisted = JSON.stringify(minio.stored);
    expect(persisted).not.toContain(token);
    expect(minio.stored[0].tokenHash).toBe(hashToken(token));
  });

  it("burns the code — a second camera cannot reuse it", async () => {
    const { code } = registry.createPairingCode();
    expect(await registry.pair(code, "Första")).not.toBeNull();
    expect(await registry.pair(code, "Andra")).toBeNull();
  });

  it("accepts a code typed in lower case or with stray spaces", async () => {
    const { code } = registry.createPairingCode();
    const result = await registry.pair(`  ${code.toLowerCase()} `, "Kamera");
    expect(result).not.toBeNull();
  });

  it("refuses an expired code", async () => {
    vi.useFakeTimers();
    try {
      const { code } = registry.createPairingCode();
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(await registry.pair(code, "Kamera")).toBeNull();
      expect(registry.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a code that was never issued", async () => {
    expect(await registry.pair("ABCD-2345", "Kamera")).toBeNull();
  });

  it("revokes one camera without touching the others", async () => {
    const a = (await registry.pair(registry.createPairingCode().code, "A"))!;
    const b = (await registry.pair(registry.createPairingCode().code, "B"))!;

    expect(await registry.revoke(a.device.id)).toBe(true);

    expect(await registry.verify(a.token)).toBeNull();
    expect(await registry.verify(b.token)).not.toBeNull();
  });

  it("reports an unknown id rather than silently succeeding", async () => {
    expect(await registry.revoke("nosuchdevice")).toBe(false);
  });

  it("never exposes the hash when listing", async () => {
    await registry.pair(registry.createPairingCode().code, "Kamera");
    const list = await registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("tokenHash");
  });

  it("survives a restart — devices are persisted, pairings are not lost", async () => {
    const { token } = (await registry.pair(registry.createPairingCode().code, "Kamera"))!;

    const afterRestart = new DeviceRegistry(minio as never);
    expect(await afterRestart.verify(token)).not.toBeNull();
  });

  it("rejects an empty or unknown token", async () => {
    await registry.pair(registry.createPairingCode().code, "Kamera");
    expect(await registry.verify("")).toBeNull();
    expect(await registry.verify("f".repeat(64))).toBeNull();
  });
});

describe("the pairing QR code", () => {
  it("is a link the camera app opens, carrying the address and code intact", () => {
    const link = new URL(pairingLink("https://club.apps.osaas.io:8443", "ABCD-2345"));
    expect(link.protocol).toBe("courtside-camera:");
    expect(link.searchParams.get("url")).toBe("https://club.apps.osaas.io:8443");
    expect(link.searchParams.get("code")).toBe("ABCD-2345");
  });
});
