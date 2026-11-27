/**
 * Which of the club's teams a match, stream or replay belongs to (#124).
 *
 * Every way there: the match's own team, a stream's or a replay's match, the
 * home team's name (also an earlier name of a merged team), and nothing at
 * all, when only the club's sponsors apply.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamRegistry } from "../teams.js";
import { MatchSchedule } from "../matches.js";
import { ownTeamOf, type OwnTeamDeps } from "../own-team.js";
import type { VodEntry } from "../types.js";

vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));

function memoryStorage(vods: Partial<VodEntry>[] = []) {
  const files = new Map<string, Buffer | string>();
  return {
    readFileIfExists: async (key: string) => files.get(key)?.toString() ?? null,
    uploadBuffer: async (key: string, body: Buffer | string) => { files.set(key, body); },
    downloadBuffer: async (key: string) => Buffer.from(files.get(key) ?? ""),
    deleteObject: async (key: string) => { files.delete(key); },
    readVodIndex: async () => vods as VodEntry[],
    updateVodEntry: async () => true,
  };
}

describe("ownTeamOf (#124)", () => {
  let teams: TeamRegistry;
  let schedule: MatchSchedule;
  let streams: Map<string, { matchId?: string; homeTeam?: string }>;
  let vods: Partial<VodEntry>[];
  let deps: OwnTeamDeps;
  let p12: string;
  let f14: string;

  beforeEach(async () => {
    vods = [];
    const storage = memoryStorage(vods);
    teams = new TeamRegistry(storage);
    schedule = new MatchSchedule(storage, teams);
    streams = new Map();
    p12 = (await teams.create({ name: "Älta P12", own: true })).id;
    f14 = (await teams.create({ name: "Älta F14", own: true })).id;
    deps = {
      matchSummary: (id) => schedule.summary(id),
      stream: (id) => streams.get(id),
      vod: async (id) => vods.find((v) => v.id === id) as VodEntry | undefined,
      findTeamByName: (name) => teams.findByName(name),
    };
  });

  it("takes the match's own team", async () => {
    const match = await schedule.create({ date: "2026-12-01", ownTeamId: p12, opponentName: "AIK" });
    expect(await ownTeamOf({ matchId: match.id }, deps)).toBe(p12);
  });

  it("takes the match a stream records, before the stream's home team", async () => {
    const match = await schedule.create({ date: "2026-12-01", ownTeamId: f14, opponentName: "AIK" });
    streams.set("s1", { matchId: match.id, homeTeam: "Älta P12" });
    expect(await ownTeamOf({ streamId: "s1" }, deps)).toBe(f14);
  });

  it("takes the match a replay records", async () => {
    const match = await schedule.create({ date: "2026-12-01", ownTeamId: p12, opponentName: "AIK" });
    vods.push({ id: "v1", matchId: match.id, homeTeam: "Något annat" });
    expect(await ownTeamOf({ vodId: "v1" }, deps)).toBe(p12);
  });

  it("finds the team by the home team's name when there is no match, also by an earlier name", async () => {
    streams.set("s2", { homeTeam: "älta p12 " });
    expect(await ownTeamOf({ streamId: "s2" }, deps)).toBe(p12);

    vods.push({ id: "v2", homeTeam: "Älta P12B" });
    expect(await ownTeamOf({ vodId: "v2" }, deps)).toBeNull();
    // P12B was a duplicate: merged into P12, its name now finds P12.
    const dup = await teams.create({ name: "Älta P12B", own: true });
    await teams.merge(p12, dup.id);
    expect(await ownTeamOf({ vodId: "v2" }, deps)).toBe(p12);
  });

  it("follows a merge for a match that named the merged team", async () => {
    const dup = await teams.create({ name: "Älta P12B", own: true });
    const match = await schedule.create({ date: "2026-12-01", ownTeamId: dup.id, opponentName: "AIK" });
    await teams.merge(p12, dup.id);
    expect(await ownTeamOf({ matchId: match.id }, deps)).toBe(p12);
  });

  it("gives null for a stream without a match whose home team is not in the registry, and for nothing", async () => {
    streams.set("s3", { homeTeam: "Okänt lag" });
    expect(await ownTeamOf({ streamId: "s3" }, deps)).toBeNull();
    expect(await ownTeamOf({ streamId: "gone" }, deps)).toBeNull();
    expect(await ownTeamOf({ vodId: "gone" }, deps)).toBeNull();
    expect(await ownTeamOf({ matchId: "gone" }, deps)).toBeNull();
    expect(await ownTeamOf({}, deps)).toBeNull();
  });
});
