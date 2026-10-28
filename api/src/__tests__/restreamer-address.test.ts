/**
 * The Restreamer address is whatever OSC reports for the instance, not the one
 * built from tenant and region — OSC can place the instance in another region
 * (configured "prod", instance in "prod-se").
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { RestreamerClient } from "../restreamer.js";
import { SegmentCollector } from "../segment-collector.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Restreamer address", () => {
  it("serves HLS from the instance's real address once it is known", () => {
    const client = new RestreamerClient("https://t-r.datarhei-restreamer.auto.prod.osaas.io", "pat", "");

    client.useInstanceUrl("https://t-r.datarhei-restreamer.auto.prod-se.osaas.io/");

    expect(client.baseUrlValue).toBe("https://t-r.datarhei-restreamer.auto.prod-se.osaas.io");
    expect(client.hlsUrl("abc", 2)).toBe("https://t-r.datarhei-restreamer.auto.prod-se.osaas.io/memfs/abc_p2.m3u8");
  });

  it("lets a collector follow an address that becomes known after it started", async () => {
    let base = "https://guessed.example";
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);
    const collector = new SegmentCollector("abc", () => base, {} as never, logger as never, 2);

    base = "https://real.example";
    await collector.pollOnce();

    expect(fetchMock.mock.calls[0][0]).toBe("https://real.example/memfs/abc_p2.m3u8");
  });
});
