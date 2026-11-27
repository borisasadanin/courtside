/**
 * The sponsor on shared clips (#121, phase 2: #158, #160, #161).
 *
 * What matters: a club clip's page names the sponsor of "shared-clip" for
 * its match's team, and nothing changes while the surface is off; a guest
 * clip never gets a sponsor; the page's "seen" lands on "shared-clip" and
 * nowhere else, with a cap per clip; and the link preview shows the logo
 * without drawtext, with a new URL for a new logo.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { initServices, guestSpaces, matches, sponsors, sponsorStats, streamMeta, teams } from "../state.js";
import { buildReport, readSeasonFiles } from "../sponsor-report.js";
import { renderClipShareImage } from "../share-image.js";
import type { HighlightClip, VodEntry } from "../types.js";
import clipRoutes from "../routes/clip-routes.js";
import guestRoutes from "../routes/guest-routes.js";
import { memoryStorage } from "./sponsor-fakes.js";

vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));
vi.mock("../stream-meta-store.js", () => ({ saveStreamMetaSoon: vi.fn() }));

const require = createRequire(import.meta.url);
const ffmpeg: string = require("ffmpeg-static");

/** A real 1×1 PNG, so ffmpeg has a logo to read. */
const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A JPEG thumbnail made by ffmpeg. */
async function thumbnail(width = 640, height = 360): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "clip-thumb-test-"));
  try {
    const out = join(dir, "thumb.jpg");
    await promisify(execFile)(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=blue:s=${width}x${height}`, "-frames:v", "1", out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Width and height from a baseline JPEG's SOF0 marker. */
function jpegSize(jpg: Buffer): { width: number; height: number } {
  expect(jpg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  for (let i = 2; i < jpg.length - 9;) {
    if (jpg[i] !== 0xff) { i++; continue; }
    const marker = jpg[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) return { height: jpg.readUInt16BE(i + 5), width: jpg.readUInt16BE(i + 7) };
    i += 2 + jpg.readUInt16BE(i + 2);
  }
  throw new Error("No SOF marker");
}

const STREAM = "stream01";
const crawler = { host: "club.example.com", "x-forwarded-proto": "https", "user-agent": "WhatsApp/2.23" };

let app: FastifyInstance;
let storage: ReturnType<typeof memoryStorage> & { clips: HighlightClip[] };
let clip: HighlightClip;
let ownTeamId: string;

function clipEntry(id: string, streamId = STREAM): HighlightClip {
  return {
    id,
    streamId,
    hlsUrl: `/api/clips/${id}/playlist.m3u8`,
    mp4Url: `/api/clips/${id}/media/${id}.mp4`,
    thumbnailUrl: `/api/clips/${id}/media/${id}.jpg`,
    durationSeconds: 8,
    createdAt: "2026-11-01T14:30:00.000Z",
    label: "Trepoängare",
  };
}

function recording(id: string, matchId: string): Partial<VodEntry> {
  return {
    id, matchId, matchTitle: "P12 vs Hornets", homeTeam: "P12", awayTeam: "Hornets", matchDate: "2026-11-01",
    location: "", hlsUrl: `/api/vod/${id}/playlist.m3u8`, createdAt: "2026-11-01T14:00:00.000Z",
  };
}

async function setup(opts: { maxSeenPerClip?: number } = {}) {
  streamMeta.clear();
  const base = memoryStorage();
  const clips: HighlightClip[] = [];
  storage = Object.assign(base, {
    clips,
    readClipsIndex: vi.fn(async () => clips.map((c) => ({ ...c }))),
    clipThumbnailKey: (streamId: string, clipId: string) => `clips/${streamId}/${clipId}.jpg`,
  });
  initServices({} as never, storage as never, {} as never);
  const own = await teams.create({ name: "P12", own: true });
  const opponent = await teams.create({ name: "Hornets" });
  ownTeamId = own.id;
  const match = await matches.create({ date: "2026-11-01", ownTeamId: own.id, opponentId: opponent.id });
  storage.vods.push(recording(STREAM, match.id));
  clip = clipEntry("75d86aa9afa2fd7a");
  clips.push(clip);
  storage.files.set(`clips/${STREAM}/${clip.id}.jpg`, { body: await thumbnail(), type: "image/jpeg" });
  app = Fastify();
  await app.register(clipRoutes, opts);
  await app.register(guestRoutes);
  return match;
}

/** A Platinum sponsor for the whole club, or for some teams, with a logo. */
async function platinum(name: string, teamIds: string[] = []) {
  const x = await sponsors.createSponsor({ name, packageId: "platinum", teamIds, url: "https://example.com" });
  return sponsors.setLogo(x.id, LOGO);
}

afterEach(async () => {
  await app?.close();
});

// --- #158 ---

describe("GET /api/clips/:id/public (#158)", () => {
  beforeEach(() => setup());

  it("names the club's sponsor of shared clips, once switched on", async () => {
    const ica = await platinum("ICA");
    const off = (await app.inject({ url: `/api/clips/${clip.id}/public` })).json();
    // Off: exactly the answer as before.
    const { mp4Url: _download, ...before } = clip;
    expect(off).toEqual(before);

    await sponsors.setSurfaces({ "shared-clip": true });
    const on = (await app.inject({ url: `/api/clips/${clip.id}/public` })).json();
    expect(on.sponsor).toEqual({
      id: ica.id,
      name: "ICA",
      logoUrl: `/api/sponsor-logos/${ica.id}?v=${encodeURIComponent(ica.updatedAt)}`,
      url: "https://example.com/",
    });
    expect(on).not.toHaveProperty("mp4Url");
  });

  it("gives the match's own team's sponsor, and none from another team", async () => {
    await sponsors.setSurfaces({ "shared-clip": true });
    const f14 = await teams.create({ name: "F14", own: true });
    await platinum("Bilfirman", [f14.id]);
    expect((await app.inject({ url: `/api/clips/${clip.id}/public` })).json()).not.toHaveProperty("sponsor");
    await platinum("Banken", [ownTeamId]);
    expect((await app.inject({ url: `/api/clips/${clip.id}/public` })).json().sponsor.name).toBe("Banken");
  });

  it("finds the team while the stream is still on, too", async () => {
    await sponsors.setSurfaces({ "shared-clip": true });
    await platinum("Banken", [ownTeamId]);
    const live = clipEntry("aaaaaaaaaaaaaaaa", "stream02");
    storage.clips.push(live);
    streamMeta.set("stream02", { name: "x", createdAt: "2026-11-01T14:00:00.000Z", partNumber: 1, periodNumber: 1, completedParts: [], homeTeam: "P12" });
    expect((await app.inject({ url: `/api/clips/${live.id}/public` })).json().sponsor.name).toBe("Banken");
  });

  it("never gives a guest clip a sponsor", async () => {
    await sponsors.setSurfaces({ "shared-clip": true });
    await platinum("ICA");
    const spaceId = await guestSpaces.spaceIdFor(STREAM);
    // Made now, so the space has not expired.
    const guest = { id: "bbbbbbbbbbbbbbbb", mp4Url: "/api/guest/clips/bbbbbbbbbbbbbbbb/media/x.mp4", durationSeconds: 6, createdAt: new Date().toISOString() };
    await guestSpaces.addClip({ streamId: STREAM, homeTeam: "P12", awayTeam: "Hornets", matchDate: "2026-11-01" }, spaceId, guest);

    // Not one of the club's clips, so not on the club's route …
    expect((await app.inject({ url: `/api/clips/${guest.id}/public` })).statusCode).toBe(404);
    // … and its own route has no sponsor.
    const res = await app.inject({ url: `/api/guest/clips/${guest.id}/public` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("sponsor");
    expect(JSON.stringify(res.json())).not.toContain("ICA");
    // Nor can its page count a sponsor.
    expect((await app.inject({ method: "POST", url: `/api/clips/${guest.id}/sponsor-seen`, payload: { viewerId: "viewer-0001" } })).statusCode).toBe(404);
  });

  it("has no sponsor with the surface switched off for the sponsor", async () => {
    await sponsors.setSurfaces({ "shared-clip": true });
    const ica = await platinum("ICA");
    await sponsors.patchSponsor(ica.id, { off: ["shared-clip"] });
    expect((await app.inject({ url: `/api/clips/${clip.id}/public` })).json()).not.toHaveProperty("sponsor");
  });
});

// --- #160 ---

describe("POST /api/clips/:id/sponsor-seen (#160)", () => {
  const seen = (viewerId: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/api/clips/${clip.id}/sponsor-seen`, payload: { viewerId, ...extra } });

  it("counts on shared-clip for the clip's match, whatever surface the body names", async () => {
    const match = await setup();
    await sponsors.setSurfaces({ "shared-clip": true, corner: true });
    const ica = await platinum("ICA");
    expect((await seen("viewer-0001", { surface: "corner", sponsorId: "aaaaaaaaaaaa", kind: "start" })).statusCode).toBe(204);
    expect((await seen("viewer-0001")).statusCode).toBe(204);

    const counts = sponsorStats.counts(match.id)!;
    expect(Object.keys(counts.sponsors)).toEqual([ica.id]);
    expect(Object.keys(counts.sponsors[ica.id].surfaces)).toEqual(["shared-clip"]);
    expect(counts.sponsors[ica.id].surfaces["shared-clip"].replay).toMatchObject({ viewers: 1, seen: 1, starts: 0 });
  });

  it("refuses a missing viewer, an unknown clip and a clip without a sponsor", async () => {
    await setup();
    await platinum("ICA");
    expect((await seen("viewer-0001")).statusCode).toBe(404);
    await sponsors.setSurfaces({ "shared-clip": true });
    expect((await seen("")).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/clips/nosuchclip/sponsor-seen", payload: { viewerId: "viewer-0001" } })).statusCode).toBe(404);
    expect((await seen("viewer-0001")).statusCode).toBe(204);
  });

  it("has a cap per clip", async () => {
    const match = await setup({ maxSeenPerClip: 2 });
    await sponsors.setSurfaces({ "shared-clip": true });
    const ica = await platinum("ICA");
    for (const v of ["viewer-0001", "viewer-0002", "viewer-0003", "viewer-0004"]) expect((await seen(v)).statusCode).toBe(204);
    expect(sponsorStats.counts(match.id)!.sponsors[ica.id].surfaces["shared-clip"].replay!.seen).toBe(2);
  });

  it("shows up in the sponsor's report as Delade klipp", async () => {
    const match = await setup();
    await sponsors.setSurfaces({ "shared-clip": true });
    const ica = await platinum("ICA");
    await seen("viewer-0001");
    await seen("viewer-0002");
    await sponsorStats.flush(match.id);
    const report = buildReport(await readSeasonFiles(storage, "2026"), { id: ica.id, name: "ICA" }, "2026");
    expect(report.matches).toHaveLength(1);
    expect(report.matches[0].surfaces).toEqual([expect.objectContaining({ id: "shared-clip", label: "Delade klipp" })]);
    expect(report.matches[0].surfaces[0].replay).toMatchObject({ viewers: 2, seen: 2 });
  });
});

// --- #161 ---

describe("the shared clip's link preview (#161)", () => {
  beforeEach(() => setup());

  async function ogImage(): Promise<string> {
    const res = await app.inject({ url: `/c/${clip.id}`, headers: crawler });
    return /<meta property="og:image" content="([^"]+)">/.exec(res.body)![1];
  }

  it("is the thumbnail as before without a sponsor", async () => {
    await platinum("ICA");
    expect(await ogImage()).toBe(`https://club.example.com${clip.thumbnailUrl}`);
  });

  it("shows the logo once switched on, with a new URL for a new logo", async () => {
    const ica = await platinum("ICA");
    await sponsors.setSurfaces({ "shared-clip": true });
    const first = await ogImage();
    expect(first).toMatch(new RegExp(`^https://club\\.example\\.com/api/clips/${clip.id}/share\\.jpg\\?v=[a-f0-9]{12}$`));

    const url = new URL(first);
    const res = await app.inject({ url: url.pathname + url.search });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(jpegSize(res.rawPayload)).toEqual({ width: 1200, height: 676 });
    expect(storage.downloadBuffer).toHaveBeenCalledWith(`config/sponsor-logos/${ica.id}`);

    await sponsors.setLogo(ica.id, LOGO);
    const second = await ogImage();
    expect(second).not.toBe(first);
    // Under an old version: the current picture, kept only briefly.
    expect((await app.inject({ url: url.pathname + url.search })).headers["cache-control"]).toBe("public, max-age=300");

    await sponsors.setSurfaces({ "shared-clip": false });
    expect(await ogImage()).toBe(`https://club.example.com${clip.thumbnailUrl}`);
  });

  it("gives the thumbnail as it is when the sponsor's logo cannot be read", async () => {
    const ica = await platinum("ICA");
    await sponsors.setSurfaces({ "shared-clip": true });
    storage.files.delete(`config/sponsor-logos/${ica.id}`);
    const url = new URL(await ogImage());
    const res = await app.inject({ url: url.pathname });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(Buffer.from(storage.files.get(`clips/${STREAM}/${clip.id}.jpg`)!.body))).toBe(true);
  });
});

describe("drawing the clip preview without drawtext (#161)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "courtside-fake-ffmpeg-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses only filters the host's ffmpeg has", async () => {
    const bin = join(dir, "ffmpeg");
    const calls = `${bin}.calls`;
    writeFileSync(calls, "");
    writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${calls}"
case "$*" in
  *drawtext*) echo "No such filter: 'drawtext'" >&2 ; exit 1 ;;
esac
exec "${ffmpeg}" "$@"
`);
    chmodSync(bin, 0o755);
    const jpg = await renderClipShareImage(await thumbnail(1280, 720), { bytes: Buffer.from(LOGO.split(",")[1], "base64"), type: "image/png" }, { ffmpeg: bin });
    expect(jpegSize(jpg)).toEqual({ width: 1200, height: 676 });
    const args = readFileSync(calls, "utf8");
    expect(args).toContain("overlay");
    expect(args).not.toContain("drawtext");
    expect(args).not.toMatch(/fontfile|\.ttf/);
  });
});
