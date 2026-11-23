/**
 * Sponsor clips, phase 1 (#87): storage, transcoding and the API.
 *
 * What matters: a clip goes uploading → queued → processing → ready (or
 * failed) without any request waiting for ffmpeg; a file over 200 MB is
 * caught even though the browser uploaded it straight to storage; viewers
 * only ever see ready clips, in the admin's order, per slot; and period
 * breaks are counted without the timeouts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, readFile as readLocal, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import {
  SponsorRegistry,
  SponsorError,
  SPONSORS_KEY,
  DEFAULT_BREAK_SECONDS,
  MAX_UPLOAD_BYTES,
  originalKey,
  slotForPeriodBreak,
  periodBreakNumber,
} from "../sponsors.js";
import { SponsorTranscodeQueue, failureText, parseSourceInfo, playlistDuration, probeSource, transcodeSponsorClip, type TranscodeResult } from "../sponsor-transcode.js";
import { initServices, sponsors, sponsorQueue, streamMeta } from "../state.js";
import { defaultHomeTeam } from "../club-config.js";
import { createAdminToken, createViewerToken } from "../auth.js";
import sponsorRoutes from "../routes/sponsor-routes.js";

vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));

/** Storage as the sponsor code sees it, kept in a map. */
function memoryStorage() {
  const files = new Map<string, { body: Buffer | string; type: string }>();
  return {
    files,
    readFileIfExists: vi.fn(async (key: string) => files.get(key)?.body.toString() ?? null),
    readFile: vi.fn(async (key: string) => files.get(key)?.body.toString() ?? null),
    uploadBuffer: vi.fn(async (key: string, body: Buffer | string, type: string) => {
      files.set(key, { body, type });
    }),
    deleteObject: vi.fn(async (key: string) => {
      files.delete(key);
    }),
    deletePrefix: vi.fn(async (prefix: string) => {
      let n = 0;
      for (const key of [...files.keys()]) if (key.startsWith(prefix) && files.delete(key)) n++;
      return n;
    }),
    presignGet: vi.fn(async (key: string) => `https://storage.example.com/${key}?sig=get`),
    downloadToFile: vi.fn(async (key: string, path: string) => {
      const f = files.get(key);
      if (!f) throw new Error(`NoSuchKey ${key}`);
      await writeFile(path, f.body);
    }),
    presignPut: vi.fn(async (key: string, type: string) => `https://storage.example.com/${key}?sig=put&type=${encodeURIComponent(type)}`),
    objectSize: vi.fn(async (key: string) => {
      const f = files.get(key);
      return f ? Buffer.byteLength(f.body) : null;
    }),
  };
}

const quietLog = { info: () => {}, warn: () => {} };

/** A transcode that produces two segments without running ffmpeg. */
function fakeTranscode(durationSeconds = 8): (url: string) => Promise<TranscodeResult> {
  return async () => ({
    durationSeconds,
    files: [
      { name: "seg_00000.ts", body: Buffer.from("a"), contentType: "video/mp2t" },
      { name: "seg_00001.ts", body: Buffer.from("b"), contentType: "video/mp2t" },
      {
        name: "index.m3u8",
        body: Buffer.from("#EXTM3U\n#EXTINF:4.0,\nseg_00000.ts\n#EXTINF:4.0,\nseg_00001.ts\n#EXT-X-ENDLIST\n"),
        contentType: "application/vnd.apple.mpegurl",
      },
      { name: "thumb.jpg", body: Buffer.from("jpg"), contentType: "image/jpeg" },
    ],
  });
}

describe("period breaks (#95)", () => {
  it("are counted without the timeouts", () => {
    expect(periodBreakNumber(undefined)).toBe(0);
    expect(periodBreakNumber([{ n: 1, type: "timeout" }, { n: 2, type: "timeout" }, { n: 3, type: "period" }])).toBe(1);
    expect(periodBreakNumber([
      { n: 1, type: "period" }, { n: 2, type: "timeout" }, { n: 3, type: "period" }, { n: 4, type: "period" },
    ])).toBe(3);
  });

  it("map to a slot: 1–3, then overtime for every one after", () => {
    expect(slotForPeriodBreak(1)).toBe("p1");
    expect(slotForPeriodBreak(2)).toBe("p2");
    expect(slotForPeriodBreak(3)).toBe("p3");
    expect(slotForPeriodBreak(4)).toBe("ot");
    expect(slotForPeriodBreak(7)).toBe("ot");
    expect(slotForPeriodBreak(0)).toBeNull();
  });
});

describe("sponsor registry (#88)", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let registry: SponsorRegistry;

  beforeEach(() => {
    storage = memoryStorage();
    registry = new SponsorRegistry(storage);
  });

  it("starts with no clips and the default break lengths", async () => {
    expect(await registry.read()).toEqual({ clips: [], breakSeconds: DEFAULT_BREAK_SECONDS });
    expect(DEFAULT_BREAK_SECONDS).toEqual({ p1: 120, p2: 900, p3: 120, ot: 120 });
  });

  it("refuses empty, oversized and non-video files before handing out a link", async () => {
    await expect(registry.create("ICA", 0, "video/mp4")).rejects.toMatchObject({ status: 400 });
    await expect(registry.create("ICA", MAX_UPLOAD_BYTES + 1, "video/mp4")).rejects.toMatchObject({ status: 413 });
    await expect(registry.create("ICA", 1000, "image/png")).rejects.toMatchObject({ status: 415 });
    await expect(registry.create("  ", 1000, "video/mp4")).rejects.toBeInstanceOf(SponsorError);
  });

  it("keeps clips, order, slots and break lengths in storage", async () => {
    const a = await registry.create("ICA Maxi", 1000, "video/mp4");
    const b = await registry.create("Bilfirman", 2000, "video/quicktime");
    expect(a.status).toBe("uploading");
    expect(a.slots).toEqual([]);

    await registry.reorder([b.id, a.id]);
    // Given in any order, stored in column order.
    await registry.setSlots(a.id, ["end", "start", "p2"]);
    await registry.setBreakSeconds({ p2: 600 });

    const again = await new SponsorRegistry(storage).read();
    expect(again.clips.map((c) => c.name)).toEqual(["Bilfirman", "ICA Maxi"]);
    expect(again.clips[1].slots).toEqual(["start", "p2", "end"]);
    expect(again.breakSeconds).toEqual({ ...DEFAULT_BREAK_SECONDS, p2: 600 });
    expect(storage.files.has(SPONSORS_KEY)).toBe(true);
  });

  it("refuses an order that leaves out or repeats a clip, and unknown slots and breaks", async () => {
    const a = await registry.create("A", 1, "video/mp4");
    const b = await registry.create("B", 1, "video/mp4");
    await expect(registry.reorder([a.id])).rejects.toMatchObject({ status: 409 });
    await expect(registry.reorder([a.id, a.id])).rejects.toMatchObject({ status: 409 });
    await expect(registry.reorder([a.id, b.id, "x"])).rejects.toMatchObject({ status: 409 });
    await expect(registry.setSlots(a.id, ["halftime"])).rejects.toMatchObject({ status: 400 });
    await expect(registry.setBreakSeconds({ start: 60 })).rejects.toMatchObject({ status: 400 });
    await expect(registry.setBreakSeconds({ p1: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(registry.setBreakSeconds({ p1: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(registry.setBreakSeconds({ p1: 3601 })).rejects.toMatchObject({ status: 400 });
    await expect(registry.setBreakSeconds({ p1: 1.5 })).rejects.toMatchObject({ status: 400 });
  });

  it("gives viewers only ready clips, per slot, in play order", async () => {
    const a = await registry.create("A", 1, "video/mp4");
    const b = await registry.create("B", 1, "video/mp4");
    const c = await registry.create("C", 1, "video/mp4");
    for (const clip of [a, b, c]) await registry.setSlots(clip.id, ["start", "ot"]);
    await registry.patch(a.id, { status: "ready" });
    await registry.patch(c.id, { status: "ready" });
    await registry.reorder([c.id, b.id, a.id]);

    const playlist = await registry.playlist();
    expect(playlist.start?.map((x) => x.name)).toEqual(["C", "A"]);
    expect(playlist.ot?.map((x) => x.name)).toEqual(["C", "A"]);
    expect(playlist.p1).toBeUndefined();
  });

  it("removes a clip together with its files", async () => {
    const a = await registry.create("A", 1, "video/mp4");
    storage.files.set(`sponsors/${a.id}/seg_00000.ts`, { body: "x", type: "video/mp2t" });
    expect(await registry.remove(a.id)).toBe(true);
    expect([...storage.files.keys()].some((k) => k.startsWith(`sponsors/${a.id}/`))).toBe(false);
    expect(await registry.remove(a.id)).toBe(false);
  });

  it("after a restart fails the clip that was processing and hands back the queued ones", async () => {
    const a = await registry.create("A", 1, "video/mp4");
    const b = await registry.create("B", 1, "video/mp4");
    const c = await registry.create("C", 1, "video/mp4");
    await registry.patch(a.id, { status: "processing" });
    await registry.patch(b.id, { status: "queued" });

    // C is still uploading: kept while its link may be in use, failed once it has run out.
    const restarted = new SponsorRegistry(storage);
    expect((await restarted.recoverAfterRestart()).map((x) => x.id)).toEqual([b.id]);
    expect((await restarted.get(c.id))?.status).toBe("uploading");
    const after = await restarted.get(a.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("Avbröts av en omstart – ladda upp igen.");

    await restarted.recoverAfterRestart(Date.parse(c.createdAt) + 16 * 60 * 1000);
    expect((await restarted.get(c.id))?.status).toBe("failed");
  });
});

describe("abandoned uploads", () => {
  it("fails an upload that was never confirmed and removes what arrived", async () => {
    const storage = memoryStorage();
    const registry = new SponsorRegistry(storage);
    const old = await registry.create("Gammal", 3, "video/mp4");
    const fresh = await registry.create("Ny", 3, "video/mp4");
    storage.files.set(originalKey(old.id), { body: "raw", type: "video/mp4" });
    const later = Date.parse(old.createdAt) + 3 * 60 * 60 * 1000 + 1000;
    // createdAt of "fresh" is moved forward so only "old" is stale.
    await registry.patch(fresh.id, { createdAt: new Date(later).toISOString() } as never);
    expect(await registry.expireAbandonedUploads(later)).toBe(1);
    expect((await registry.get(old.id))?.status).toBe("failed");
    expect((await registry.get(old.id))?.error).toMatch(/aldrig klar/);
    expect((await registry.get(fresh.id))?.status).toBe("uploading");
    expect(storage.files.has(originalKey(old.id))).toBe(false);
    expect(await registry.expireAbandonedUploads(later)).toBe(0);
  });
});

describe("transcode queue (#92)", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let registry: SponsorRegistry;

  beforeEach(() => {
    storage = memoryStorage();
    registry = new SponsorRegistry(storage);
  });

  async function uploaded(name: string) {
    const clip = await registry.create(name, 3, "video/mp4");
    storage.files.set(originalKey(clip.id), { body: `raw ${name}`, type: "video/mp4" });
    await registry.patch(clip.id, { status: "queued" });
    return clip;
  }

  it("stores the HLS files, records the length and deletes the original", async () => {
    const clip = await uploaded("A");
    const queue = new SponsorTranscodeQueue(registry, storage, quietLog, fakeTranscode(8));
    queue.enqueue(clip.id);
    await queue.idle();

    const done = await registry.get(clip.id);
    expect(done?.status).toBe("ready");
    expect(done?.durationSeconds).toBe(8);
    expect(storage.files.has(`sponsors/${clip.id}/index.m3u8`)).toBe(true);
    expect(storage.files.has(`sponsors/${clip.id}/thumb.jpg`)).toBe(true);
    expect(storage.files.has(originalKey(clip.id))).toBe(false);
  });

  it("gives ffmpeg a local copy of the original, never a link, and removes it after (#117)", async () => {
    const clip = await uploaded("A");
    let seen = "";
    let path = "";
    const queue = new SponsorTranscodeQueue(registry, storage, quietLog, async (input) => {
      path = input;
      seen = await readLocal(input, "utf8");
      return fakeTranscode()(input);
    });
    queue.enqueue(clip.id);
    await queue.idle();
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(seen).toBe("raw A");
    expect(storage.presignGet).not.toHaveBeenCalled();
    await expect(access(path)).rejects.toThrow();
  });

  it("fails with a reason when the original cannot be fetched", async () => {
    const clip = await uploaded("A");
    storage.files.delete(originalKey(clip.id));
    const queue = new SponsorTranscodeQueue(registry, storage, quietLog, fakeTranscode());
    queue.enqueue(clip.id);
    await queue.idle();
    expect((await registry.get(clip.id))?.error).toMatch(/Orsak: NoSuchKey/);
  });

  it("runs one clip at a time, in the order they came", async () => {
    const a = await uploaded("A");
    const b = await uploaded("B");
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const slow = async (url: string) => {
      running++;
      most = Math.max(most, running);
      order.push(await readLocal(url, "utf8"));
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return fakeTranscode()(url);
    };
    const queue = new SponsorTranscodeQueue(registry, storage, quietLog, slow);
    queue.enqueue(a.id);
    queue.enqueue(b.id);
    queue.enqueue(a.id);
    await queue.idle();
    expect(most).toBe(1);
    expect(order).toHaveLength(2);
    expect(order).toEqual(["raw A", "raw B"]);
    expect((await registry.get(b.id))?.status).toBe("ready");
  });

  it("marks a clip failed when ffmpeg fails, and goes on with the next", async () => {
    const a = await uploaded("A");
    const b = await uploaded("B");
    const transcode = vi.fn()
      .mockRejectedValueOnce(new Error("ffmpeg exited with 1"))
      .mockImplementation(fakeTranscode());
    const queue = new SponsorTranscodeQueue(registry, storage, quietLog, transcode);
    queue.enqueue(a.id);
    queue.enqueue(b.id);
    await queue.idle();
    expect((await registry.get(a.id))).toMatchObject({ status: "failed", error: expect.stringMatching(/Orsak: ffmpeg exited with 1$/) });
    expect(storage.files.has(originalKey(a.id))).toBe(false);
    expect((await registry.get(b.id))?.status).toBe("ready");
  });

  it("leaves nothing behind when the clip is deleted while it transcodes", async () => {
    const a = await uploaded("A");
    const queue = new SponsorTranscodeQueue(registry, storage, quietLog, async (url) => {
      await registry.remove(a.id);
      return fakeTranscode()(url);
    });
    queue.enqueue(a.id);
    await queue.idle();
    expect([...storage.files.keys()].filter((k) => k.startsWith("sponsors/"))).toEqual([]);
  });

  it("puts queued clips back in line after a restart", async () => {
    const a = await uploaded("A");
    const queue = new SponsorTranscodeQueue(new SponsorRegistry(storage), storage, quietLog, fakeTranscode());
    await queue.resume();
    await queue.idle();
    expect((await new SponsorRegistry(storage).get(a.id))?.status).toBe("ready");
  });
});

describe("transcoding with ffmpeg (#91)", () => {
  const require = createRequire(import.meta.url);
  const ffmpeg: string = require("ffmpeg-static");
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "sponsor-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sums a playlist's segment lengths", () => {
    expect(playlistDuration("#EXTM3U\n#EXTINF:4.000000,\na.ts\n#EXTINF:1.2,\nb.ts\n")).toBe(5.2);
  });

  it("turns a 1440p60 film into 1080p HLS with a thumbnail", async () => {
    const input = join(dir, "in.mp4");
    await promisify(execFile)(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=2560x1440:rate=60",
      "-f", "lavfi", "-i", "sine=frequency=440",
      "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", input,
    ]);

    const result = await transcodeSponsorClip(input);
    expect(result.durationSeconds).toBeGreaterThan(4.5);
    expect(result.durationSeconds).toBeLessThan(5.5);
    const names = result.files.map((f) => f.name);
    expect(names).toContain("index.m3u8");
    expect(names).toContain("thumb.jpg");
    expect(names.filter((n) => /^seg_\d{5}\.ts$/.test(n)).length).toBeGreaterThanOrEqual(2);

    // ffmpeg prints the stream's size and rate when given a file it cannot write anywhere.
    const seg = join(dir, "seg.ts");
    await import("node:fs/promises").then((fs) => fs.writeFile(seg, result.files.find((f) => f.name === "seg_00000.ts")!.body));
    const probe = await promisify(execFile)(ffmpeg, ["-hide_banner", "-i", seg]).catch((e) => e as { stderr: string });
    expect(probe.stderr).toMatch(/h264.*1920x1080/);
    expect(probe.stderr).toMatch(/30 fps/);
    expect(probe.stderr).toMatch(/aac/);
  }, 60_000);

  it("cuts a long clip at 30 s and gives a clip without sound a silent track", async () => {
    const input = join(dir, "mute.mp4");
    await promisify(execFile)(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30",
      "-t", "40", "-c:v", "libx264", "-preset", "ultrafast", input,
    ]);
    expect(await probeSource(input)).toEqual({ hasAudio: false, hdr: false });

    const result = await transcodeSponsorClip(input);
    expect(result.durationSeconds).toBeGreaterThan(29.5);
    expect(result.durationSeconds).toBeLessThanOrEqual(30.1);
    const seg = join(dir, "mute-seg.ts");
    await import("node:fs/promises").then((fs) => fs.writeFile(seg, result.files.find((f) => f.name === "seg_00000.ts")!.body));
    const probe = await promisify(execFile)(ffmpeg, ["-hide_banner", "-i", seg]).catch((e) => e as { stderr: string });
    expect(probe.stderr).toMatch(/Audio: aac.*48000 Hz, stereo/);
  }, 120_000);

  it("tone maps an HLG clip, as an iPhone films, to ordinary BT.709", async () => {
    const input = join(dir, "hlg.mp4");
    await promisify(execFile)(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
      "-t", "2", "-vf", "format=yuv420p10le",
      "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "high10",
      "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc",
      input,
    ]);
    expect(await probeSource(input)).toEqual({ hasAudio: false, hdr: "hlg" });

    const result = await transcodeSponsorClip(input);
    const seg = join(dir, "hlg-seg.ts");
    await import("node:fs/promises").then((fs) => fs.writeFile(seg, result.files.find((f) => f.name === "seg_00000.ts")!.body));
    const probe = await promisify(execFile)(ffmpeg, ["-hide_banner", "-i", seg]).catch((e) => e as { stderr: string });
    // 8-bit BT.709, not the 10-bit BT.2020 HLG that went in
    expect(probe.stderr).toMatch(/yuv420p\(tv, bt709[,)]/);
  }, 60_000);

  it("reads HDR and sound from ffmpeg's listing", () => {
    const iphone = [
      "  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 3840x2160, 60 fps",
      "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 191 kb/s",
    ].join("\n");
    expect(parseSourceInfo(iphone)).toEqual({ hasAudio: true, hdr: "hlg" });
    const hdr10 = "  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160";
    expect(parseSourceInfo(hdr10)).toEqual({ hasAudio: false, hdr: "pq" });
    const sdr = "  Stream #0:0: Video: h264 (High), yuv420p(tv, bt709, progressive), 1920x1080";
    expect(parseSourceInfo(sdr)).toEqual({ hasAudio: false, hdr: false });
  });

  it("tells the admin ffmpeg's last line, not the whole output (#117)", () => {
    const err = new Error("ffmpeg avslutades med 1:\n  Stream mapping: ...\n\nhttps://x: Failed to resolve hostname x\n");
    expect(failureText(err)).toBe(
      "Klippet kunde inte bearbetas. Prova att exportera det som MP4 och ladda upp igen. Orsak: https://x: Failed to resolve hostname x",
    );
  });

  it("leaves the temporary path out of the reason", () => {
    const err = new Error("ffmpeg avslutades med 1:\n/tmp/sponsor-in-1234/original: Invalid data found when processing input");
    expect(failureText(err)).toMatch(/Orsak: Invalid data found when processing input$/);
  });

  it("fails clearly on a file that is not a video", async () => {
    const input = join(dir, "broken.mp4");
    await import("node:fs/promises").then((fs) => fs.writeFile(input, "inte en video"));
    await expect(transcodeSponsorClip(input)).rejects.toThrow(/ffmpeg avslutades/);
  });
});

describe("sponsor routes (#89, #90, #93, #94, #96)", () => {
  let app: FastifyInstance;
  let storage: ReturnType<typeof memoryStorage>;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;

  beforeAll(async () => {
    admin = { "x-admin-token": createAdminToken() };
    viewer = { authorization: `Bearer ${createViewerToken()}` };
  });

  beforeEach(async () => {
    storage = memoryStorage();
    initServices({} as never, storage as never, {} as never);
    // The real queue, but with a transcode that needs no ffmpeg.
    (sponsorQueue as unknown as { transcode: unknown }).transcode = fakeTranscode(12);
    app = Fastify();
    await app.register(sponsorRoutes);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function upload(name = "ICA Maxi", body = "film") {
    const res = await app.inject({
      method: "POST", url: "/api/admin/sponsors/uploads", headers: admin,
      payload: { name, sizeBytes: body.length, contentType: "video/mp4" },
    });
    expect(res.statusCode).toBe(201);
    const { clip, upload } = res.json();
    expect(upload).toMatchObject({ method: "PUT", headers: { "Content-Type": "video/mp4" } });
    expect(upload.url).toContain(originalKey(clip.id));
    // The browser PUTs straight to storage.
    storage.files.set(originalKey(clip.id), { body, type: "video/mp4" });
    return clip.id as string;
  }

  it("is closed to viewers and to anyone without a PIN", async () => {
    expect((await app.inject({ url: "/api/admin/sponsors" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/admin/sponsors", headers: viewer })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/sponsors/play?surface=start" })).statusCode).toBe(401);
    const list = await app.inject({ url: "/api/admin/sponsors", headers: admin });
    expect(list.json()).toEqual({ clips: [], breakSeconds: DEFAULT_BREAK_SECONDS, maxUploadBytes: MAX_UPLOAD_BYTES });
  });

  it("takes a clip from upload to ready without waiting for the transcode", async () => {
    const id = await upload();
    const done = await app.inject({ method: "POST", url: `/api/admin/sponsors/${id}/uploaded`, headers: admin });
    expect(done.statusCode).toBe(202);
    expect(done.json().clip.status).toBe("queued");

    await sponsorQueue.idle();
    const list = (await app.inject({ url: "/api/admin/sponsors", headers: admin })).json();
    expect(list.clips[0]).toMatchObject({
      id, status: "ready", durationSeconds: 12,
      hlsUrl: `/api/sponsors/${id}/index.m3u8`, thumbnailUrl: `/api/sponsors/${id}/thumb.jpg`,
    });

    const again = await app.inject({ method: "POST", url: `/api/admin/sponsors/${id}/uploaded`, headers: admin });
    expect(again.statusCode).toBe(409);
  });

  it("says so when the file never reached storage", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/sponsors/uploads", headers: admin,
      payload: { name: "A", sizeBytes: 10, contentType: "video/mp4" },
    });
    const id = res.json().clip.id;
    const done = await app.inject({ method: "POST", url: `/api/admin/sponsors/${id}/uploaded`, headers: admin });
    expect(done.statusCode).toBe(409);
    expect((await sponsors.get(id))?.status).toBe("uploading");
  });

  it("catches a file over 200 MB that was uploaded anyway, and deletes it", async () => {
    const id = await upload();
    storage.objectSize.mockResolvedValueOnce(MAX_UPLOAD_BYTES + 1);
    const done = await app.inject({ method: "POST", url: `/api/admin/sponsors/${id}/uploaded`, headers: admin });
    expect(done.statusCode).toBe(413);
    expect(done.json().clip.status).toBe("failed");
    expect(storage.files.has(originalKey(id))).toBe(false);
  });

  it("refuses a file over 200 MB before handing out a link", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/sponsors/uploads", headers: admin,
      payload: { name: "A", sizeBytes: MAX_UPLOAD_BYTES + 1, contentType: "video/mp4" },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/200 MB/);
  });

  it("renames, chooses slots, orders, sets break lengths and deletes", async () => {
    const a = await upload("A");
    const b = await upload("B");

    const renamed = await app.inject({ method: "PATCH", url: `/api/admin/sponsors/${a}`, headers: admin, payload: { name: "ICA" } });
    expect(renamed.json().clip.name).toBe("ICA");

    const slotted = await app.inject({ method: "PATCH", url: `/api/admin/sponsors/${a}`, headers: admin, payload: { slots: ["p1", "start"] } });
    expect(slotted.json().clip.slots).toEqual(["start", "p1"]);

    const ordered = await app.inject({ method: "PUT", url: "/api/admin/sponsors/order", headers: admin, payload: { ids: [b, a] } });
    expect(ordered.json().clips.map((c: { id: string }) => c.id)).toEqual([b, a]);
    const badOrder = await app.inject({ method: "PUT", url: "/api/admin/sponsors/order", headers: admin, payload: { ids: [b] } });
    expect(badOrder.statusCode).toBe(409);

    const breaks = await app.inject({ method: "PATCH", url: "/api/admin/sponsors/breaks", headers: admin, payload: { p2: 600 } });
    expect(breaks.json().breakSeconds.p2).toBe(600);

    const missing = await app.inject({ method: "PATCH", url: "/api/admin/sponsors/aaaaaaaaaaaa", headers: admin, payload: { name: "X" } });
    expect(missing.statusCode).toBe(404);

    expect((await app.inject({ method: "DELETE", url: `/api/admin/sponsors/${a}`, headers: admin })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/sponsors/${a}`, headers: admin })).statusCode).toBe(404);
  });

  it("gives viewers the ready clips per slot, and their media behind the PIN", async () => {
    const a = await upload("A");
    const b = await upload("B");
    await sponsors.setSlots(a, ["start", "end"]);
    await sponsors.setSlots(b, ["start"]);
    await app.inject({ method: "POST", url: `/api/admin/sponsors/${a}/uploaded`, headers: admin });
    await sponsorQueue.idle();

    // B was never confirmed, so it is not ready and not shown.
    const play = (q: string) => app.inject({ url: `/api/sponsors/play?${q}`, headers: viewer });
    const clipA = { id: a, name: "A", durationSec: 12, hlsUrl: `/api/sponsors/${a}/index.m3u8` };
    expect((await play("surface=start")).json()).toEqual({ surface: "start", teamName: defaultHomeTeam, clips: [clipA] });
    expect((await play("surface=end")).json()).toMatchObject({ clips: [clipA] });
    expect((await play("surface=p2")).json()).toMatchObject({ surface: "p2", clips: [] });
    expect((await play("surface=halftime")).statusCode).toBe(400);
    // The banner names the home team of the stream that is broadcasting.
    streamMeta.set("s1", { homeTeam: "Älta U14" } as never);
    expect((await play("surface=start&stream=s1")).json()).toMatchObject({ teamName: "Älta U14" });
    streamMeta.delete("s1");

    const manifest = await app.inject({ url: `/api/sponsors/${a}/index.m3u8`, headers: viewer });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.body).toContain(`/api/sponsors/${a}/seg_00000.ts`);
    expect((await app.inject({ url: `/api/sponsors/${a}/index.m3u8` })).statusCode).toBe(401);
    // The admin previews with the admin PIN alone, also as a Bearer token,
    // which is the one header storage's CORS lets through a redirect.
    expect((await app.inject({ url: `/api/sponsors/${a}/index.m3u8`, headers: admin })).statusCode).toBe(200);
    const bearer = { authorization: `Bearer ${admin["x-admin-token"]}` };
    expect((await app.inject({ url: `/api/sponsors/${a}/seg_00000.ts`, headers: bearer })).statusCode).toBe(302);

    const seg = await app.inject({ url: `/api/sponsors/${a}/seg_00001.ts`, headers: viewer });
    expect(seg.statusCode).toBe(302);
    expect(seg.headers.location).toContain(`sponsors/${a}/seg_00001.ts`);

    // Not the original, nothing outside the clip, nothing of a clip that is not ready.
    expect((await app.inject({ url: `/api/sponsors/${a}/original`, headers: viewer })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/sponsors/${a}/..%2Fconfig.json`, headers: viewer })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/sponsors/${b}/index.m3u8`, headers: viewer })).statusCode).toBe(404);
  });
});
