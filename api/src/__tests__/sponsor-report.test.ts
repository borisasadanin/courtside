/**
 * The sponsor's report (#121, phase 0, #141): per match and surface, live
 * and replay apart, for one season.
 *
 * What matters: the sums and shares are right, a match belongs to the season
 * its date is in (31 July is the season before 1 August), and viewers are
 * only ever given per match.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { initServices, sponsors, sponsorStats } from "../state.js";
import { createAdminToken, createViewerToken } from "../auth.js";
import { SPONSORS_KEY } from "../sponsors.js";
import sponsorRoutes from "../routes/sponsor-routes.js";
import { buildReport, readSeasonFiles } from "../sponsor-report.js";
import { statsKey, type Counts, type StatsFile } from "../sponsor-stats.js";
import { V081_FILE, memoryStorage } from "./sponsor-fakes.js";

vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));

const ICA = "a1b2c3d4e5f6";
const BIL = "0f9e8d7c6b5a";

const c = (viewers: number, starts: number, completes: number, sounds: number): Counts => ({ viewers, starts, completes, sounds, seen: 0 });

function file(key: string, date: string, sponsors: StatsFile["sponsors"]): StatsFile {
  return { version: 1, match: { key, date, homeTeam: "Älta P12", awayTeam: `Motstånd ${key}` }, updatedAt: "2026-11-01T00:00:00.000Z", sponsors };
}

/** Four matches around the 2026 season's start, ICA in three of them. */
const FIXTURES: [string, StatsFile][] = [
  // 31 July: the 2025 season.
  [statsKey("2025", "jul31"), file("jul31", "2026-07-31", {
    [ICA]: { viewers: { live: 50 }, surfaces: { start: { live: c(50, 50, 40, 10) } } },
  })],
  // 1 August: the first day of 2026.
  [statsKey("2026", "aug01"), file("aug01", "2026-08-01", {
    [ICA]: {
      viewers: { live: 20, replay: 4 },
      surfaces: {
        start: { live: c(20, 20, 15, 5), replay: c(4, 4, 1, 4) },
        p2: { live: c(12, 14, 7, 7) },
      },
    },
  })],
  [statsKey("2026", "oct10"), file("oct10", "2026-10-10", {
    [ICA]: { viewers: { live: 30 }, surfaces: { start: { live: c(30, 30, 30, 15) } } },
    [BIL]: { viewers: { live: 30 }, surfaces: { start: { live: c(30, 30, 0, 0) } } },
  })],
  // Bilfirman only.
  [statsKey("2026", "nov01"), file("nov01", "2026-11-01", {
    [BIL]: { viewers: { live: 9 }, surfaces: { p1: { live: c(9, 9, 9, 9) } } },
  })],
];

function storageWithFixtures() {
  const storage = memoryStorage();
  for (const [key, f] of FIXTURES) storage.files.set(key, { body: JSON.stringify(f), type: "application/json" });
  return storage;
}

describe("the report's numbers (#141)", () => {
  it("adds up the season's matches per surface, live and replay apart", async () => {
    const files = await readSeasonFiles(storageWithFixtures(), "2026");
    const report = buildReport(files, { id: ICA, name: "ICA Maxi" }, "2026");

    expect(report.season).toEqual({ id: "2026", label: "2026/27", from: "2026-08-01", to: "2027-07-31" });
    expect(report.matches.map((m) => [m.date, m.awayTeam, m.viewers])).toEqual([
      ["2026-08-01", "Motstånd aug01", { live: 20, replay: 4 }],
      ["2026-10-10", "Motstånd oct10", { live: 30, replay: 0 }],
    ]);

    const [start, p2] = report.surfaces;
    expect(start).toMatchObject({ id: "start", label: "Klipp vid start" });
    expect(start.live).toEqual({ matches: 2, starts: 50, completes: 45, sounds: 20, seen: 0, completeRate: 0.9, soundRate: 0.4 });
    expect(start.replay).toEqual({ matches: 1, starts: 4, completes: 1, sounds: 4, seen: 0, completeRate: 0.25, soundRate: 1 });
    expect(p2).toMatchObject({ id: "p2", live: { matches: 1 } });
    expect(p2.live.completeRate).toBeCloseTo(0.5);
    expect(p2.replay).toMatchObject({ matches: 0, starts: 0, completeRate: null, soundRate: null });
    // No number of different viewers for the season: they are counted per match.
    expect(start.live).not.toHaveProperty("viewers");

    const aug = report.matches[0].surfaces.find((s) => s.id === "start")!;
    expect(aug.live).toEqual({ viewers: 20, starts: 20, completes: 15, sounds: 5, seen: 0, completeRate: 0.75, soundRate: 0.25 });
  });

  it("puts 31 July in the season before and 1 August in the new one", async () => {
    const storage = storageWithFixtures();
    const before = buildReport(await readSeasonFiles(storage, "2025"), { id: ICA, name: "ICA Maxi" }, "2025");
    expect(before.season).toMatchObject({ from: "2025-08-01", to: "2026-07-31" });
    expect(before.matches.map((m) => m.date)).toEqual(["2026-07-31"]);

    const after = buildReport(await readSeasonFiles(storage, "2026"), { id: ICA, name: "ICA Maxi" }, "2026");
    expect(after.matches.map((m) => m.date)).toEqual(["2026-08-01", "2026-10-10"]);
  });

  it("follows the admin's season start, wherever a match was filed", async () => {
    const storage = storageWithFixtures();
    // The season starts 2 August: 1 August now belongs to 2025, though it is filed under 2026.
    const before = buildReport(await readSeasonFiles(storage, "2025"), { id: ICA, name: "ICA Maxi" }, "2025", "2026-08-02");
    expect(before.matches.map((m) => m.date)).toEqual(["2026-07-31", "2026-08-01"]);
    expect(before.surfaces[0].live.starts).toBe(70);
  });

  it("adds two files of the same match together", () => {
    const a = file("m1", "2026-09-01", { [ICA]: { viewers: { live: 5 }, surfaces: { start: { live: c(5, 5, 5, 0) } } } });
    const b = file("m1", "2026-09-01", { [ICA]: { viewers: { live: 2 }, surfaces: { start: { live: c(2, 2, 0, 2) } } } });
    const report = buildReport([a, b], { id: ICA, name: "ICA Maxi" }, "2026");
    expect(report.matches).toHaveLength(1);
    expect(report.matches[0].viewers.live).toBe(7);
    expect(report.surfaces[0].live).toMatchObject({ starts: 7, completes: 5, sounds: 2 });
  });
});

describe("GET /api/admin/sponsorship/report (#141)", () => {
  let app: FastifyInstance;
  let storage: ReturnType<typeof memoryStorage>;
  const admin = () => ({ "x-admin-token": createAdminToken() });

  beforeEach(async () => {
    vi.useFakeTimers({ now: new Date("2026-11-20T12:00:00Z"), toFake: ["Date"] });
    storage = storageWithFixtures();
    storage.files.set(SPONSORS_KEY, { body: V081_FILE, type: "application/json" });
    initServices({} as never, storage as never, {} as never);
    await sponsors.ready();
    app = Fastify();
    await app.register(sponsorRoutes);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  const get = (q: string, headers: Record<string, string> = admin()) => app.inject({ url: `/api/admin/sponsorship/report?${q}`, headers });

  it("wants the admin PIN", async () => {
    expect((await get(`sponsor=${ICA}`, {})).statusCode).toBe(401);
    expect((await get(`sponsor=${ICA}`, { authorization: `Bearer ${createViewerToken()}` })).statusCode).toBe(401);
  });

  it("gives today's season by default, with the seasons that have counts", async () => {
    const res = await get(`sponsor=${ICA}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sponsor).toEqual({ id: ICA, name: "ICA Maxi" });
    expect(body.season.id).toBe("2026");
    expect(body.seasons).toEqual(["2026", "2025"]);
    expect(body.seasonStart).toBeNull();
    expect(body.matches).toHaveLength(2);
  });

  it("includes what was counted since the last save", async () => {
    sponsorStats.record({ key: "nov20", date: "2026-11-20" }, { viewerId: "viewer-aaaa", sponsorId: ICA, surface: "end", kind: "start", mode: "live" });
    const body = (await get(`sponsor=${ICA}&season=2026`)).json();
    expect(body.matches.map((m: { key: string }) => m.key)).toEqual(["aug01", "oct10", "nov20"]);
    expect(JSON.stringify(body)).not.toContain("viewer-aaaa");
  });

  it("moves the boundary when the admin sets the season start", async () => {
    const patched = await app.inject({ method: "PATCH", url: "/api/admin/sponsorship/season", headers: admin(), payload: { seasonStart: "2026-08-02" } });
    expect(patched.json()).toEqual({ seasonStart: "2026-08-02" });
    const body = (await get(`sponsor=${ICA}&season=2026`)).json();
    expect(body.season).toMatchObject({ from: "2026-08-02", to: "2027-08-01" });
    expect(body.matches.map((m: { date: string }) => m.date)).toEqual(["2026-10-10"]);
    expect(body.seasonStart).toBe("2026-08-02");
  });

  it("refuses a missing sponsor or a made-up season", async () => {
    expect((await get("")).statusCode).toBe(400);
    expect((await get(`sponsor=${ICA}&season=last`)).statusCode).toBe(400);
  });

  it("keeps a removed sponsor's counts, without its name", async () => {
    const body = (await get("sponsor=ffffffffffff&season=2026")).json();
    expect(body.sponsor.name).toBe("Borttagen sponsor");
    expect(body.matches).toEqual([]);
  });
});
