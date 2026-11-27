/**
 * What viewers saw of the sponsors (#121, phase 0): counted in memory (#138).
 *
 * What matters: a viewer is counted once per match, "complete" and "sound"
 * never outnumber the starts, only a sponsor that is really on that surface
 * for that match is counted, the caps hold, and the viewer's id is never in
 * an answer or a log line.
 *
 * Saved (#139): every five minutes and when a stream stops, counts only, in
 * the season the match was played; a restart adds to what was saved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { Writable } from "node:stream";
import { initServices, sponsors, sponsorStats, streamMeta } from "../state.js";
import { createViewerToken } from "../auth.js";
import { SPONSORS_KEY } from "../sponsors.js";
import sponsorRoutes from "../routes/sponsor-routes.js";
import {
  SponsorStats,
  seasonOf,
  seasonRange,
  statsKey,
  type MatchInfo,
  type StatEvent,
} from "../sponsor-stats.js";
import { endStream } from "../routes/streams.js";
import { V081_FILE, memoryStorage } from "./sponsor-fakes.js";

vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));
vi.mock("../stream-meta-store.js", () => ({ saveStreamMetaSoon: vi.fn() }));
// The cover frame needs ffmpeg and a recording: not what is tested here.
vi.mock("../match-images.js", () => ({
  recordingStopped: vi.fn(async () => {}),
  forgetLivePicture: vi.fn(),
  withLivePictures: vi.fn(async (x: unknown) => x),
}));

const MATCH: MatchInfo = { key: "m1", date: "2026-11-20" };
const ev = (viewerId: string, kind: StatEvent["kind"], extra: Partial<StatEvent> = {}): StatEvent => ({
  viewerId, kind, sponsorId: "a1b2c3d4e5f6", surface: "start", mode: "live", ...extra,
});

describe("counting in memory (#138)", () => {
  it("counts a viewer once per match, and the starts, completes and sounds", () => {
    const stats = new SponsorStats();
    stats.record(MATCH, ev("viewer-aaaa", "start"));
    stats.record(MATCH, ev("viewer-aaaa", "sound"));
    stats.record(MATCH, ev("viewer-aaaa", "complete"));
    stats.record(MATCH, ev("viewer-bbbb", "start"));
    stats.record(MATCH, ev("viewer-bbbb", "complete"));
    // The same viewer again in the next break: one viewer, two starts.
    stats.record(MATCH, ev("viewer-aaaa", "start", { surface: "p1" }));

    const c = stats.counts("m1")!.sponsors.a1b2c3d4e5f6;
    expect(c.surfaces.start.live).toEqual({ viewers: 2, starts: 2, completes: 2, sounds: 1, seen: 0 });
    expect(c.surfaces.p1.live).toEqual({ viewers: 1, starts: 1, completes: 0, sounds: 0, seen: 0 });
    expect(c.viewers).toEqual({ live: 2 });
  });

  it("keeps live and replay apart", () => {
    const stats = new SponsorStats();
    stats.record(MATCH, ev("viewer-aaaa", "start"));
    stats.record(MATCH, ev("viewer-aaaa", "start", { mode: "replay" }));
    const c = stats.counts("m1")!.sponsors.a1b2c3d4e5f6;
    expect(c.surfaces.start.live?.starts).toBe(1);
    expect(c.surfaces.start.replay?.starts).toBe(1);
    expect(c.viewers).toEqual({ live: 1, replay: 1 });
  });

  it("never counts more completes or sounds than starts, nor a complete without a start", () => {
    const stats = new SponsorStats();
    expect(stats.record(MATCH, ev("viewer-aaaa", "complete"))).toBe("ignored");
    stats.record(MATCH, ev("viewer-aaaa", "start"));
    for (let i = 0; i < 5; i++) {
      stats.record(MATCH, ev("viewer-aaaa", "complete"));
      stats.record(MATCH, ev("viewer-aaaa", "sound"));
    }
    expect(stats.counts("m1")!.sponsors.a1b2c3d4e5f6.surfaces.start.live).toMatchObject({ starts: 1, completes: 1, sounds: 1 });
  });

  it("does not let one viewer's reloads make a crowd", () => {
    const stats = new SponsorStats();
    for (let i = 0; i < 50; i++) stats.record(MATCH, ev("viewer-aaaa", "start"));
    expect(stats.counts("m1")!.sponsors.a1b2c3d4e5f6.surfaces.start.live?.starts).toBe(10);
  });

  it("holds no more viewer ids per match than the cap", () => {
    const stats = new SponsorStats({ maxEntriesPerMatch: 10 });
    for (let i = 0; i < 20; i++) stats.record(MATCH, ev(`viewer-${String(i).padStart(4, "0")}`, "start"));
    expect(stats.entries("m1")).toBeLessThanOrEqual(10);
    // Each new viewer takes two places: the surface and the sponsor's reach.
    expect(stats.counts("m1")!.sponsors.a1b2c3d4e5f6.surfaces.start.live?.viewers).toBe(5);
    expect(stats.record(MATCH, ev("viewer-new0", "start"))).toBe("full");
    // Viewers already in are still counted.
    expect(stats.record(MATCH, ev("viewer-0000", "complete"))).toBe("counted");
  });

  it("holds no more matches than the cap while their counts are unsaved", () => {
    const stats = new SponsorStats({ maxMatches: 3 });
    for (let i = 0; i < 5; i++) stats.record({ key: `m${i}`, date: "2026-11-20" }, ev("viewer-aaaa", "start"));
    expect(stats.size).toBe(3);
    expect(stats.counts("m4")).toBeNull();
  });

  it("gives counts only: no viewer id anywhere in them", () => {
    const stats = new SponsorStats();
    stats.record(MATCH, ev("secret-viewer-id", "start"));
    expect(JSON.stringify(stats.counts("m1"))).not.toContain("secret-viewer-id");
  });
});

describe("POST /api/sponsors/events (#138)", () => {
  let app: FastifyInstance;
  let storage: ReturnType<typeof memoryStorage>;
  let logLines: string[];
  const viewer = () => ({ authorization: `Bearer ${createViewerToken()}` });
  const ICA = "a1b2c3d4e5f6"; // ready, on start, p2 and end
  const PIZZA = "112233445566"; // still transcoding: on no surface

  beforeEach(async () => {
    storage = memoryStorage();
    storage.files.set(SPONSORS_KEY, { body: V081_FILE, type: "application/json" });
    initServices({} as never, storage as never, {} as never);
    await sponsors.ready();
    streamMeta.clear();
    streamMeta.set("s1", { name: "Kamera 1", createdAt: "2026-11-20T17:00:00.000Z", partNumber: 1, periodNumber: 1, completedParts: [], homeTeam: "Älta P12", awayTeam: "AIK" });
    logLines = [];
    const stream = new Writable({ write(chunk, _enc, done) { logLines.push(chunk.toString()); done(); } });
    app = Fastify({ logger: { level: "trace", stream } });
    await app.register(rateLimit, { global: false });
    await app.register(sponsorRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const send = (payload: Record<string, unknown>, headers: Record<string, string> = viewer()) =>
    app.inject({ method: "POST", url: "/api/sponsors/events", headers, payload });
  const event = (extra: Record<string, unknown> = {}) => ({
    viewerId: "viewer-secret-1234", stream: "s1", sponsorId: ICA, surface: "start", kind: "start", mode: "live", ...extra,
  });

  it("wants the viewer PIN", async () => {
    expect((await send(event(), {})).statusCode).toBe(401);
  });

  it("counts a sponsor that is on the surface, under the stream's key", async () => {
    expect((await send(event())).statusCode).toBe(204);
    expect((await send(event({ kind: "complete" }))).statusCode).toBe(204);
    expect((await send(event({ kind: "sound" }))).statusCode).toBe(204);
    expect((await send(event({ viewerId: "viewer-other-5678" }))).statusCode).toBe(204);
    expect(sponsorStats.counts("s1")!.sponsors[ICA].surfaces.start.live).toEqual({ viewers: 2, starts: 2, completes: 1, sounds: 1, seen: 0 });
  });

  it("counts under the match's key when the stream has one", async () => {
    streamMeta.get("s1")!.matchId = "abcd1234";
    expect((await send(event())).statusCode).toBe(204);
    expect(sponsorStats.counts("abcd1234")).not.toBeNull();
    expect(sponsorStats.counts("s1")).toBeNull();
  });

  it("refuses a sponsor or surface that does not apply, and made-up matches", async () => {
    expect((await send(event({ surface: "p1" }))).statusCode).toBe(404); // ICA is not in p1
    expect((await send(event({ sponsorId: PIZZA }))).statusCode).toBe(404);
    expect((await send(event({ sponsorId: "ffffffffffff" }))).statusCode).toBe(404);
    expect((await send(event({ surface: "scoreboard" }))).statusCode).toBe(400);
    expect((await send(event({ surface: "corner", kind: "seen" }))).statusCode).toBe(404); // not released
    expect((await send(event({ kind: "seen" }))).statusCode).toBe(400); // a clip is not "seen"
    expect((await send(event({ stream: "nope0000" }))).statusCode).toBe(404);
    expect((await send(event({ stream: undefined, match: "nope0000" }))).statusCode).toBe(404);
    expect((await send(event({ viewerId: "x" }))).statusCode).toBe(400);
    expect((await send(event({ mode: "dvr" }))).statusCode).toBe(400);
    expect((await send(event({ kind: "click" }))).statusCode).toBe(400);
    expect(sponsorStats.size).toBe(0);
  });

  it("counts a replay by its recording", async () => {
    storage.vods.push({ id: "s1", createdAt: "2026-11-20T17:00:00.000Z", homeTeam: "Älta P12" });
    streamMeta.clear();
    expect((await send(event({ stream: undefined, vod: "s1", mode: "replay" }))).statusCode).toBe(204);
    expect(sponsorStats.counts("s1")!.sponsors[ICA].surfaces.start.replay?.starts).toBe(1);
  });

  it("never puts the viewer's id in an answer or a log line", async () => {
    const answers = [
      await send(event()),
      await send(event({ surface: "p1" })),
      await send(event({ stream: "nope0000" })),
      await send(event(), {}),
    ];
    for (const res of answers) expect(res.body).not.toContain("viewer-secret-1234");
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("")).not.toContain("viewer-secret-1234");
  });

  it("takes what the player sends for the clips it got, and saves it (#140)", async () => {
    // As sponsors.js does: the clips of a surface, then an event per clip with its sponsor's id.
    const play = (await app.inject({ url: "/api/sponsors/play?surface=start&stream=s1", headers: viewer() })).json();
    expect(play.clips.map((c: { sponsorId: string }) => c.sponsorId)).toEqual([ICA, "0f9e8d7c6b5a"]);
    for (const clip of play.clips) {
      for (const kind of ["start", "sound", "complete"]) {
        expect((await send(event({ sponsorId: clip.sponsorId, kind }))).statusCode).toBe(204);
      }
    }
    await sponsorStats.flush();
    const file = JSON.parse(storage.files.get("stats/sponsors/2026/s1.json")!.body.toString());
    expect(file.match).toEqual({ key: "s1", date: "2026-11-20", homeTeam: "Älta P12", awayTeam: "AIK" });
    for (const clip of play.clips) {
      expect(file.sponsors[clip.sponsorId].surfaces.start.live).toEqual({ viewers: 1, starts: 1, completes: 1, sounds: 1, seen: 0 });
    }
    expect(storage.files.get("stats/sponsors/2026/s1.json")!.body.toString()).not.toContain("viewer-secret-1234");
  });

  it("is rate-limited per viewer, not per address", async () => {
    let limited = 0;
    for (let i = 0; i < 125; i++) if ((await send(event())).statusCode === 429) limited++;
    expect(limited).toBe(5);
    // Another viewer behind the same proxy is still let through.
    expect((await send(event({ viewerId: "viewer-other-5678" }))).statusCode).toBe(204);
  });
});

describe("seasons (#139)", () => {
  it("starts on 1 August: 31 July is the season before", () => {
    expect(seasonOf("2026-07-31")).toBe("2025");
    expect(seasonOf("2026-08-01")).toBe("2026");
    expect(seasonOf("2027-01-15")).toBe("2026");
    expect(seasonRange("2026")).toEqual({ from: "2026-08-01", to: "2027-07-31" });
  });

  it("follows the admin's season start, by month and day, every year", () => {
    expect(seasonOf("2026-08-14", "2025-08-15")).toBe("2025");
    expect(seasonOf("2026-08-15", "2025-08-15")).toBe("2026");
    expect(seasonRange("2026", "2025-08-15")).toEqual({ from: "2026-08-15", to: "2027-08-14" });
  });
});

describe("saving the counts (#139)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const KEY = statsKey("2026", "m1");
  const saved = (storage: ReturnType<typeof memoryStorage>, key = KEY) => JSON.parse(storage.files.get(key)!.body.toString());

  it("writes the file after five minutes, with counts and no id", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-20T18:00:00Z") });
    const storage = memoryStorage();
    const stats = new SponsorStats({ storage });
    stats.start();
    stats.record(MATCH, ev("viewer-secret-1234", "start"));
    stats.record(MATCH, ev("viewer-secret-1234", "complete"));

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59 * 1000);
    expect(storage.files.has(KEY)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.files.has(KEY)).toBe(true);

    const file = saved(storage);
    expect(file.match).toEqual(MATCH);
    expect(file.sponsors.a1b2c3d4e5f6.surfaces.start.live).toEqual({ viewers: 1, starts: 1, completes: 1, sounds: 0, seen: 0 });
    expect(storage.files.get(KEY)!.body.toString()).not.toContain("viewer-secret-1234");

    // Nothing new: nothing written again.
    storage.uploadBuffer.mockClear();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
    stats.stop();
  });

  it("files a match in the season it was played", async () => {
    const storage = memoryStorage();
    const stats = new SponsorStats({ storage, seasonStart: () => "2025-08-15" });
    stats.record({ key: "july", date: "2026-07-31" }, ev("viewer-aaaa", "start"));
    stats.record({ key: "aug1", date: "2026-08-01" }, ev("viewer-aaaa", "start"));
    stats.record({ key: "aug15", date: "2026-08-15" }, ev("viewer-aaaa", "start"));
    await stats.flush();
    expect([...storage.files.keys()].sort()).toEqual([
      "stats/sponsors/2025/aug1.json",
      "stats/sponsors/2025/july.json",
      "stats/sponsors/2026/aug15.json",
    ]);
  });

  it("adds to what was saved before a restart, and loses nothing", async () => {
    const storage = memoryStorage();
    const before = new SponsorStats({ storage });
    before.record(MATCH, ev("viewer-aaaa", "start"));
    before.record(MATCH, ev("viewer-bbbb", "start"));
    before.record(MATCH, ev("viewer-bbbb", "sound"));
    await before.flush();

    // The process restarts: the ids are gone, the counts are not.
    const after = new SponsorStats({ storage });
    after.record(MATCH, ev("viewer-cccc", "start"));
    after.record(MATCH, ev("viewer-cccc", "start", { mode: "replay" }));
    await after.flush();
    after.record(MATCH, ev("viewer-dddd", "start"));
    await after.flush();

    const file = saved(storage);
    expect(file.sponsors.a1b2c3d4e5f6.surfaces.start.live).toEqual({ viewers: 4, starts: 4, completes: 0, sounds: 1, seen: 0 });
    expect(file.sponsors.a1b2c3d4e5f6.surfaces.start.replay).toEqual({ viewers: 1, starts: 1, completes: 0, sounds: 0, seen: 0 });
    expect(file.sponsors.a1b2c3d4e5f6.viewers).toEqual({ live: 4, replay: 1 });
  });

  it("never overwrites saved counts it could not read", async () => {
    const storage = memoryStorage();
    storage.files.set(KEY, { body: JSON.stringify({ version: 1, match: MATCH, updatedAt: "", sponsors: { a1b2c3d4e5f6: { viewers: { live: 7 }, surfaces: { start: { live: { viewers: 7, starts: 7, completes: 0, sounds: 0, seen: 0 } } } } } }), type: "application/json" });
    storage.readFileIfExists.mockRejectedValueOnce(new Error("storage down"));
    const stats = new SponsorStats({ storage });
    stats.record(MATCH, ev("viewer-aaaa", "start"));
    await expect(stats.flush()).rejects.toThrow("storage down");
    expect(saved(storage).sponsors.a1b2c3d4e5f6.surfaces.start.live.starts).toBe(7);

    // Next time it reads them and adds.
    await stats.flush();
    expect(saved(storage).sponsors.a1b2c3d4e5f6.surfaces.start.live.starts).toBe(8);
  });

  it("writes when the stream stops, under its match", async () => {
    const storage = memoryStorage();
    initServices({ deleteProcess: vi.fn(async () => {}) } as never, storage as never, {} as never);
    streamMeta.clear();
    const meta = { name: "Kamera 1", createdAt: "2026-11-20T17:00:00.000Z", partNumber: 0, periodNumber: 1, completedParts: [], matchId: "abcd1234" };
    streamMeta.set("s1", meta);
    sponsorStats.record({ key: "abcd1234", date: "2026-11-20" }, ev("viewer-aaaa", "start"));

    await endStream("s1", meta, { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never, "camera");
    await vi.waitFor(() => expect(storage.files.has(statsKey("2026", "abcd1234"))).toBe(true));
    expect(saved(storage, statsKey("2026", "abcd1234")).sponsors.a1b2c3d4e5f6.surfaces.start.live.starts).toBe(1);
  });

  it("lets go of a saved match that has been quiet for hours", async () => {
    let now = Date.parse("2026-11-20T18:00:00Z");
    const storage = memoryStorage();
    const stats = new SponsorStats({ storage, now: () => now });
    stats.record(MATCH, ev("viewer-aaaa", "start"));
    await stats.flush();
    expect(stats.size).toBe(1);
    now += 4 * 60 * 60 * 1000;
    await stats.flush();
    expect(stats.size).toBe(0);
    expect(saved(storage).sponsors.a1b2c3d4e5f6.surfaces.start.live.starts).toBe(1);
  });
});
