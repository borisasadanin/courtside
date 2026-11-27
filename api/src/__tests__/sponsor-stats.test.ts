/**
 * What viewers saw of the sponsors (#121, phase 0): counted in memory (#138).
 *
 * What matters: a viewer is counted once per match, "complete" and "sound"
 * never outnumber the starts, only a sponsor that is really on that surface
 * for that match is counted, the caps hold, and the viewer's id is never in
 * an answer or a log line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { Writable } from "node:stream";
import { initServices, sponsors, sponsorStats, streamMeta } from "../state.js";
import { createViewerToken } from "../auth.js";
import { SPONSORS_KEY } from "../sponsors.js";
import sponsorRoutes from "../routes/sponsor-routes.js";
import { SponsorStats, type MatchInfo, type StatEvent } from "../sponsor-stats.js";
import { V081_FILE, memoryStorage } from "./sponsor-fakes.js";

vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));
vi.mock("../stream-meta-store.js", () => ({ saveStreamMetaSoon: vi.fn() }));

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

  it("is rate-limited per viewer, not per address", async () => {
    let limited = 0;
    for (let i = 0; i < 125; i++) if ((await send(event())).statusCode === 429) limited++;
    expect(limited).toBe(5);
    // Another viewer behind the same proxy is still let through.
    expect((await send(event({ viewerId: "viewer-other-5678" }))).statusCode).toBe(204);
  });
});
