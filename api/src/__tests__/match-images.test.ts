/**
 * Match covers and live pictures (ABL-045).
 *
 * Nobody takes these pictures, so what matters is that the right one is chosen
 * on its own, that the live picture never loads the broadcast (one FFmpeg run
 * per stream a minute, none while the last is still running), and that every
 * picture stays behind the viewer PIN.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { initServices, collectors, streamMeta } from "../state.js";
import { createAdminToken, createViewerToken } from "../auth.js";
import {
  matchCover,
  pickCoverSegment,
  saveCoverFrame,
  takeLivePictures,
  livePictureUrl,
  withLivePictures,
  recordingStopped,
  forgetLivePicture,
  LIVE_PICTURE_EVERY_MS,
} from "../match-images.js";
import { extractSegmentFrame } from "../mp4-converter.js";
import type { HighlightClip, StreamPublicInfo, VodEntry } from "../types.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function vod(id: string, extra: Partial<VodEntry> = {}): VodEntry {
  return {
    id,
    matchTitle: "Hemma vs Borta",
    location: "Hallen",
    homeTeam: "Hemma",
    awayTeam: "Borta",
    matchDate: "2026-11-01",
    cameraName: "Läktaren",
    hlsUrl: `/api/vod/${id}/playlist.m3u8`,
    createdAt: "2026-11-01T10:00:00.000Z",
    stoppedAt: "2026-11-01T11:30:00.000Z",
    ...extra,
  };
}

function clip(id: string, streamId: string, minute: number, thumbnail = true): HighlightClip {
  return {
    id,
    streamId,
    hlsUrl: `/api/clips/${id}/playlist.m3u8`,
    thumbnailUrl: thumbnail ? `/api/clips/${id}/media/${id}.jpg` : undefined,
    durationSeconds: 8,
    createdAt: `2026-11-01T10:${String(minute).padStart(2, "0")}:00.000Z`,
  };
}

/** Just enough of MinioClient, over a Map of keys. */
function fakeMinio() {
  const objects = new Map<string, Buffer | string>();
  let vods: VodEntry[] = [];
  let clips: HighlightClip[] = [];
  return {
    objects,
    get vods() { return vods; },
    seed(v: VodEntry[], c: HighlightClip[]) { vods = v; clips = c; },
    readVodIndex: async () => structuredClone(vods),
    readClipsIndex: async () => structuredClone(clips),
    updateVodEntry: vi.fn(async (id: string, update: Partial<VodEntry>) => {
      const i = vods.findIndex((e) => e.id === id);
      if (i === -1) return false;
      vods[i] = JSON.parse(JSON.stringify({ ...vods[i], ...update }));
      return true;
    }),
    readFile: async (key: string) => (objects.has(key) ? String(objects.get(key)) : null),
    downloadBuffer: async (key: string) => {
      if (!objects.has(key)) throw new Error(`NoSuchKey ${key}`);
      return Buffer.from(objects.get(key)!);
    },
    uploadBuffer: vi.fn(async (key: string, body: Buffer | string) => { objects.set(key, body); }),
    deleteObject: vi.fn(async (key: string) => { objects.delete(key); }),
    presignGet: async (key: string) => `https://storage.example.com/${key}?sig=x`,
  };
}

let minio: ReturnType<typeof fakeMinio>;

beforeEach(() => {
  minio = fakeMinio();
  initServices({} as never, minio as never, {} as never);
  collectors.clear();
  streamMeta.clear();
});

describe("the cover of a match", () => {
  const clips = [clip("c2", "m1", 20), clip("c1", "m1", 5), clip("x1", "other", 1), clip("c0", "m1", 1, false)];

  it("is the first highlight that has a picture", () => {
    expect(matchCover(vod("m1"), clips)).toEqual({ url: "/api/clips/c1/media/c1.jpg", source: "highlight" });
  });

  it("is the highlight the admin chose, over the first one", () => {
    expect(matchCover(vod("m1", { coverClipId: "c2" }), clips)?.source).toBe("chosen");
    expect(matchCover(vod("m1", { coverClipId: "c2" }), clips)?.url).toBe("/api/clips/c2/media/c2.jpg");
  });

  it("falls back when the chosen highlight is gone, or from another match", () => {
    expect(matchCover(vod("m1", { coverClipId: "deleted" }), clips)?.url).toBe("/api/clips/c1/media/c1.jpg");
    expect(matchCover(vod("m1", { coverClipId: "x1" }), clips)?.url).toBe("/api/clips/c1/media/c1.jpg");
  });

  it("is the frame from the recording when there are no highlights, behind the PIN", () => {
    expect(matchCover(vod("m2", { frameCover: true }), clips)).toEqual({ url: "/api/media/m2/cover.jpg", source: "frame" });
  });

  it("is nothing when there is neither", () => {
    expect(matchCover(vod("m2"), clips)).toBeUndefined();
  });
});

describe("where the cover frame is taken", () => {
  const segs = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `s${i}.ts`, duration: 2 }));

  it("is two minutes into the first period", () => {
    expect(pickCoverSegment(segs(1200))?.filename).toBe("s60.ts");
  });

  it("is the middle of a part shorter than four minutes", () => {
    expect(pickCoverSegment(segs(30))?.filename).toBe("s15.ts");
    expect(pickCoverSegment(segs(1))?.filename).toBe("s0.ts");
  });

  it("is nowhere in an empty part", () => {
    expect(pickCoverSegment([])).toBeUndefined();
  });
});

describe("saving the cover frame", () => {
  const timeline = (n: number) =>
    JSON.stringify(Array.from({ length: n }, (_, i) => ({ filename: `seg${i}.ts`, duration: 2, savedAt: i })));

  it("grabs a frame from part 1, stores it beside the video and notes it on the match", async () => {
    minio.seed([vod("m1")], []);
    minio.objects.set("m1/p1.timeline.json", timeline(200));
    minio.objects.set("m1/p1_seg60.ts", "segment-60");
    const grab = vi.fn(async (ts: Buffer) => Buffer.from(`jpeg of ${ts}`));

    expect(await saveCoverFrame("m1", 2, log, grab)).toBe(true);
    expect(String(minio.objects.get("m1/cover.jpg"))).toBe("jpeg of segment-60");
    expect(minio.vods[0].frameCover).toBe(true);
  });

  it("uses the next part when part 1 has no video", async () => {
    minio.seed([vod("m1")], []);
    minio.objects.set("m1/p2.timeline.json", timeline(10));
    minio.objects.set("m1/p2_seg5.ts", "segment-5");
    expect(await saveCoverFrame("m1", 2, log, async (ts) => ts)).toBe(true);
    expect(String(minio.objects.get("m1/cover.jpg"))).toBe("segment-5");
  });

  it("gives up quietly when FFmpeg fails", async () => {
    minio.seed([vod("m1")], []);
    minio.objects.set("m1/p1.timeline.json", timeline(10));
    minio.objects.set("m1/p1_seg5.ts", "x");
    expect(await saveCoverFrame("m1", 1, log, async () => { throw new Error("ffmpeg"); })).toBe(false);
    expect(minio.objects.has("m1/cover.jpg")).toBe(false);
    expect(minio.vods[0].frameCover).toBeUndefined();
  });
});

describe("the live picture", () => {
  let segments: { key: string }[];

  function liveStream(id: string) {
    segments = [{ key: `${id}/p1_seg1.ts` }];
    collectors.set(id, { getSegmentTimeline: () => segments } as never);
    streamMeta.set(id, { name: "Läktaren kamera", createdAt: "", partNumber: 1, periodNumber: 1, completedParts: [] });
    minio.objects.set(`${id}/p1_seg1.ts`, "seg1");
    minio.objects.set(`${id}/p1_seg2.ts`, "seg2");
  }

  beforeEach(() => {
    forgetLivePicture("live1");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("is taken from the newest segment and stored beside the video", async () => {
    liveStream("live1");
    await takeLivePictures(log, async (ts) => Buffer.from(`jpeg of ${ts}`));
    expect(String(minio.objects.get("live1/live.jpg"))).toBe("jpeg of seg1");
    expect(livePictureUrl("live1")).toBe(`/api/media/live1/live.jpg?t=${Date.now()}`);
  });

  it("is taken at most once a minute", async () => {
    liveStream("live1");
    const grab = vi.fn(async (ts: Buffer) => ts);
    await takeLivePictures(log, grab);
    segments.push({ key: "live1/p1_seg2.ts" });

    vi.setSystemTime(Date.now() + LIVE_PICTURE_EVERY_MS - 1000);
    await takeLivePictures(log, grab);
    expect(grab).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1000);
    await takeLivePictures(log, grab);
    expect(grab).toHaveBeenCalledTimes(2);
    expect(String(minio.objects.get("live1/live.jpg"))).toBe("seg2");
  });

  it("is skipped while the previous run has not finished", async () => {
    liveStream("live1");
    let finish!: () => void;
    const slow = vi.fn(() => new Promise<Buffer>((resolve) => { finish = () => resolve(Buffer.from("late")); }));
    const first = takeLivePictures(log, slow);

    vi.setSystemTime(Date.now() + 5 * LIVE_PICTURE_EVERY_MS);
    await takeLivePictures(log, slow);
    expect(slow).toHaveBeenCalledTimes(1);

    finish();
    await first;
    expect(String(minio.objects.get("live1/live.jpg"))).toBe("late");
  });

  it("is not taken again from a stream that has stalled", async () => {
    liveStream("live1");
    const grab = vi.fn(async (ts: Buffer) => ts);
    await takeLivePictures(log, grab);
    vi.setSystemTime(Date.now() + 2 * LIVE_PICTURE_EVERY_MS);
    await takeLivePictures(log, grab);
    expect(grab).toHaveBeenCalledTimes(1);
  });

  it("is shown on the card of a live stream, never on a stopped one", async () => {
    liveStream("live1");
    await takeLivePictures(log, async (ts) => ts);
    const card = (status: StreamPublicInfo["status"]): StreamPublicInfo =>
      ({ id: "live1", name: "x", hlsUrl: "", createdAt: "", status, viewers: 0 });
    expect(withLivePictures([card("live")])[0].posterUrl).toMatch(/^\/api\/media\/live1\/live\.jpg\?t=\d+$/);
    expect(withLivePictures([card("stopped")])[0].posterUrl).toBeUndefined();
    expect(withLivePictures([{ ...card("live"), id: "other" }])[0].posterUrl).toBeUndefined();
  });

  it("goes when the recording stops, and the cover frame is saved", async () => {
    liveStream("live1");
    minio.seed([vod("live1")], []);
    await takeLivePictures(log, async (ts) => ts);
    minio.objects.set("live1/p1.timeline.json", JSON.stringify([{ filename: "seg1.ts", duration: 2, savedAt: 0 }]));
    // The real FFmpeg would choke on the fake segment; the cover is best-effort either way.
    await recordingStopped("live1", 1, log);
    expect(minio.objects.has("live1/live.jpg")).toBe(false);
    expect(livePictureUrl("live1")).toBeUndefined();
  });

  it("is not taken from a stream that has stopped", async () => {
    liveStream("live1");
    streamMeta.get("live1")!.stoppedAt = new Date().toISOString();
    const grab = vi.fn(async (ts: Buffer) => ts);
    await takeLivePictures(log, grab);
    expect(grab).not.toHaveBeenCalled();
  });
});

describe("FFmpeg on a real segment", () => {
  const require = createRequire(import.meta.url);
  const ffmpeg: string = require("ffmpeg-static");

  /** Width and height from a baseline JPEG's SOF0 marker. */
  function jpegSize(jpeg: Buffer): [number, number] {
    for (let i = 2; i < jpeg.length - 9; i++) {
      if (jpeg[i] === 0xff && jpeg[i + 1] === 0xc0) return [jpeg.readUInt16BE(i + 7), jpeg.readUInt16BE(i + 5)];
    }
    throw new Error("no SOF0");
  }

  it("turns one 1080p segment into a small JPEG", async () => {
    const { stdout } = await promisify(execFile)(ffmpeg, [
      "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=25",
      "-t", "1", "-c:v", "libx264", "-preset", "ultrafast",
      "-f", "mpegts", "pipe:1",
    ], { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 });

    const live = await extractSegmentFrame(stdout, 640);
    expect(live.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegSize(live)).toEqual([640, 360]);
    expect(jpegSize(await extractSegmentFrame(stdout, 1280))).toEqual([1280, 720]);
  }, 20_000);
});

describe("routes", () => {
  let app: FastifyInstance;
  const admin = () => ({ "x-admin-token": createAdminToken() });
  const viewer = () => ({ authorization: `Bearer ${createViewerToken()}` });

  beforeAll(async () => {
    app = Fastify();
    for (const mod of ["../routes/vod.js", "../routes/media.js"]) {
      const { default: routes } = await import(mod);
      await app.register(routes);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    minio.seed(
      [vod("m1"), vod("m2", { frameCover: true }), vod("m3")],
      [clip("c1", "m1", 5), clip("c2", "m1", 20), clip("c3", "m2", 1, false)],
    );
  });

  it("lists each recording with its cover", async () => {
    const res = await app.inject({ url: "/api/vod", headers: viewer() });
    const covers = Object.fromEntries(res.json().map((v: { id: string; cover?: unknown }) => [v.id, v.cover ?? null]));
    expect(covers).toEqual({
      m1: { url: "/api/clips/c1/media/c1.jpg", source: "highlight" },
      m2: { url: "/api/media/m2/cover.jpg", source: "frame" },
      m3: null,
    });
  });

  it("lets the admin choose a highlight as the cover, and go back to automatic", async () => {
    let res = await app.inject({ method: "PUT", url: "/api/vod/m1/cover", headers: admin(), payload: { clipId: "c2" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().cover).toEqual({ url: "/api/clips/c2/media/c2.jpg", source: "chosen" });
    expect(minio.vods[0].coverClipId).toBe("c2");

    res = await app.inject({ method: "PUT", url: "/api/vod/m1/cover", headers: admin(), payload: { clipId: null } });
    expect(res.json().cover.source).toBe("highlight");
    expect(minio.vods[0].coverClipId).toBeUndefined();
  });

  it("refuses a clip of another match, or one without a picture", async () => {
    for (const clipId of ["c1", "c3", "nosuch"]) {
      const res = await app.inject({ method: "PUT", url: "/api/vod/m2/cover", headers: admin(), payload: { clipId } });
      expect(res.statusCode, clipId).toBe(400);
    }
    const res = await app.inject({ method: "PUT", url: "/api/vod/m1/cover", headers: admin(), payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("leaves choosing the cover to the admin", async () => {
    for (const headers of [{}, viewer()]) {
      const res = await app.inject({ method: "PUT", url: "/api/vod/m1/cover", headers, payload: { clipId: "c2" } });
      expect(res.statusCode).toBe(401);
    }
    expect(minio.vods[0].coverClipId).toBeUndefined();
  });

  it("keeps the cover frame and the live picture behind the viewer PIN", async () => {
    for (const url of ["/api/media/m2/cover.jpg", "/api/media/live1/live.jpg?t=1762000000000"]) {
      expect((await app.inject({ url })).statusCode, url).toBe(401);
      const res = await app.inject({ url, headers: viewer() });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location).toBe(`https://storage.example.com/${url.split("?")[0].slice("/api/media/".length)}?sig=x`);
    }
  });
});
