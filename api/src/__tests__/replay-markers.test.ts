/**
 * ABL-046: the replay marks where each highlight starts and where each period
 * begins. For that a clip remembers its first segment, and a recording
 * remembers what kind of pause each pause was.
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

vi.mock("../mp4-converter.js", () => ({
  convertSegmentsToMp4: vi.fn().mockRejectedValue(new Error("no ffmpeg in tests")),
  extractThumbnail: vi.fn(),
}));

import { streamMeta, collectors, initServices } from "../state.js";
import { config, mutableConfig } from "../config.js";
import { viewers } from "../viewer-tracking.js";
import { createClip } from "../clip-service.js";
import { SegmentCollector } from "../segment-collector.js";
import streamRoutes from "../routes/streams.js";
import vodRoutes from "../routes/vod.js";
import type { VodEntry } from "../types.js";

const logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
  child() { return this; },
  level: "silent",
} as never;

function clipStorage() {
  const uploads = new Map<string, string>();
  return {
    uploads,
    uploadBuffer: vi.fn(async (key: string, data: string | Buffer) => { uploads.set(key, String(data)); }),
    downloadBuffer: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    clipManifestKey: (s: string, c: string) => `clips/${s}/${c}.m3u8`,
    clipMp4Key: (s: string, c: string) => `clips/${s}/${c}.mp4`,
    clipThumbnailKey: (s: string, c: string) => `clips/${s}/${c}.jpg`,
  };
}

describe("a clip's start in the recording", () => {
  beforeEach(() => {
    // The collector's final poll finds nothing new: Restreamer is not there.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the first segment of the clip, named as in the recording", async () => {
    const pressedAt = Date.now() - 60_000;
    const recovered = Array.from({ length: 10 }, (_, i) => ({
      filename: `abc_${String(i).padStart(5, "0")}.ts`,
      duration: 2,
      savedAt: pressedAt - 16_000 + i * 2_000,
    }));
    const storage = clipStorage();
    const collector = new SegmentCollector("stream01", "http://restreamer.invalid", storage as never, logger, 2, recovered);

    const clip = await createClip(collector, pressedAt, storage as never, logger);

    // 8 s of 2 s segments, counted back from the newest: segments 6–9
    expect(clip.startSegment).toBe("p2_abc_00006.ts");
    const clipManifest = storage.uploads.get(`clips/stream01/${clip.id}.m3u8`)!;
    expect(clipManifest.split("\n").find((l) => l && !l.startsWith("#"))).toBe(clip.startSegment);

    // The part manifest the replay is stitched from names the same segment
    await collector.pause();
    expect(storage.uploads.get("stream01/p2.m3u8")!.split("\n")).toContain(clip.startSegment);
  });
});

describe("pause types on the recording", () => {
  let app: FastifyInstance;
  let streamId: string;
  let vod: VodEntry[];

  const auth = { "x-api-key": config.API_KEY };
  const jsonAuth = { ...auth, "content-type": "application/json" };
  const pause = (type?: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/streams/${streamId}/pause`,
      headers: type ? jsonAuth : auth,
      ...(type ? { payload: { type } } : {}),
    });
  const resume = () => app.inject({ method: "PATCH", url: `/api/streams/${streamId}/resume`, headers: auth });

  beforeEach(async () => {
    streamMeta.clear();
    viewers.clear();
    vi.clearAllMocks();
    (mutableConfig as { VIEWER_PIN: string }).VIEWER_PIN = "";
    vod = [];

    const storage = {
      addVodEntry: vi.fn(async (entry: VodEntry) => { vod.push(entry); }),
      updateVodEntry: vi.fn(async (id: string, update: Partial<VodEntry>) => {
        const i = vod.findIndex((e) => e.id === id);
        if (i === -1) return false;
        vod[i] = { ...vod[i], ...update };
        return true;
      }),
      readVodIndex: vi.fn(async () => vod),
      readClipsIndex: vi.fn().mockResolvedValue([]),
      writeStreamMetaIndex: vi.fn().mockResolvedValue(undefined),
      readStreamMetaIndex: vi.fn().mockResolvedValue({}),
      uploadBuffer: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(null),
    };
    const restreamer = {
      rtmpHost: "rtmp.example.com",
      createProcess: vi.fn().mockResolvedValue({}),
      deleteProcess: vi.fn().mockResolvedValue(undefined),
      switchPart: vi.fn().mockResolvedValue("switched"),
      listManagedProcesses: vi.fn().mockResolvedValue([]),
      rtmpUrl: (id: string) => `rtmp://rtmp.example.com/live/${id}`,
      hlsUrl: (id: string) => `https://restreamer.example.com/memfs/${id}.m3u8`,
    };
    const osc = {
      getState: vi.fn().mockReturnValue("running"),
      isUp: () => true,
      getInfo: vi.fn().mockReturnValue({ url: "https://restreamer.example.com", rtmpHost: "rtmp.example.com" }),
      streamStarted: vi.fn(), streamEnded: vi.fn(), streamPaused: vi.fn(), streamResumed: vi.fn(),
      pausedStreamEnded: vi.fn(), syncActiveCount: vi.fn(), ensureRunning: vi.fn(),
    };
    initServices(restreamer as never, storage as never, osc as never);

    app = Fastify({ logger: false });
    await app.register(streamRoutes);
    await app.register(vodRoutes);
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/api/streams", headers: jsonAuth, payload: { name: "Kamera 1" } });
    streamId = res.json().id;
  });

  afterEach(async () => {
    for (const c of collectors.values()) await c.stop().catch(() => {});
    collectors.clear();
    await app.close();
  });

  it("numbers each pause like its pause segments and keeps its type", async () => {
    await pause("period");
    await resume();
    await pause("timeout");
    await resume();
    await pause(); // an older camera sends no type: a period break

    const expected = [
      { n: 1, type: "period" },
      { n: 2, type: "timeout" },
      { n: 3, type: "period" },
    ];
    expect(streamMeta.get(streamId)?.pauses).toEqual(expected);
    await vi.waitFor(() => expect(vod[0].pauses).toEqual(expected));
  });

  it("hands the pauses to the website with the recording", async () => {
    await pause("timeout");
    await vi.waitFor(() => expect(vod[0].pauses).toHaveLength(1));
    vod[0].stoppedAt = new Date().toISOString();

    const one = (await app.inject({ method: "GET", url: `/api/vod/${streamId}` })).json();
    expect(one.pauses).toEqual([{ n: 1, type: "timeout" }]);
    const list = (await app.inject({ method: "GET", url: "/api/vod" })).json();
    expect(list[0].pauses).toEqual([{ n: 1, type: "timeout" }]);
  });

  it("does not record a pause that was refused", async () => {
    await pause("nonsens");
    await pause("timeout");
    await pause("period"); // already paused

    expect(streamMeta.get(streamId)?.pauses).toEqual([{ n: 1, type: "timeout" }]);
  });
});
