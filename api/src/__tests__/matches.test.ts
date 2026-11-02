/**
 * Match schedule (ABL-048).
 *
 * What matters: the admin enters matches by hand and can fix them; a match
 * with recordings is never deleted from the schedule; a camera that picks a
 * match records onto it, and one that does not (an older app, "Annan match")
 * still lands on a match, the same one as a second camera on it. The result
 * stays on the recording and the match reads it from there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { MatchSchedule, MATCHES_KEY, clubDate, isMatchDate, type LiveStream } from "../matches.js";
import { TeamRegistry, TEAMS_KEY } from "../teams.js";
import { backfillTeams, BACKFILL_KEY } from "../team-backfill.js";
import { initServices, matches, teams, streamMeta, devices } from "../state.js";
import { createAdminToken, createViewerToken } from "../auth.js";
import { mutableConfig } from "../config.js";
import { getBroadcastState, resetBroadcastState } from "../broadcast-state.js";
import type { Device } from "../devices.js";
import type { VodEntry } from "../types.js";
import matchRoutes from "../routes/match-routes.js";
import streamRoutes from "../routes/streams.js";
import broadcastRoutes from "../routes/broadcast-routes.js";

vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));

// Starting a stream would start collecting segments and checkpointing; neither matters here.
vi.mock("../segment-collector.js", () => ({
  SegmentCollector: class { start() {} },
}));
vi.mock("../stream-meta-store.js", () => ({ saveStreamMetaSoon: vi.fn() }));

/** The club's storage as the schedule, the registry and the stream routes see it. */
function memoryStorage() {
  const files = new Map<string, string>();
  let vods: VodEntry[] = [];
  let storedDevices: Device[] = [];
  return {
    files,
    get vods() { return vods; },
    set vods(list: VodEntry[]) { vods = list; },
    readFileIfExists: vi.fn(async (key: string) => files.get(key) ?? null),
    uploadBuffer: vi.fn(async (key: string, body: Buffer | string) => { files.set(key, body.toString()); }),
    downloadBuffer: vi.fn(async (key: string) => Buffer.from(files.get(key) ?? "")),
    deleteObject: vi.fn(async (key: string) => { files.delete(key); }),
    readVodIndex: vi.fn(async () => vods.map((v) => ({ ...v }))),
    addVodEntry: vi.fn(async (entry: VodEntry) => { vods.push(entry); }),
    updateVodEntry: vi.fn(async (id: string, update: Partial<VodEntry>) => {
      const i = vods.findIndex((v) => v.id === id);
      if (i === -1) return false;
      vods[i] = { ...vods[i], ...update };
      return true;
    }),
    readDeviceIndex: vi.fn(async () => storedDevices),
    writeDeviceIndex: vi.fn(async (d: Device[]) => { storedDevices = d; }),
  };
}

function vod(id: string, fields: Partial<VodEntry> = {}): VodEntry {
  return {
    id,
    matchTitle: "Test IF vs Gäst",
    location: "Testhallen",
    homeTeam: "Test IF",
    awayTeam: "Gäst",
    matchDate: "2026-11-01",
    cameraName: "Läktaren",
    hlsUrl: `/api/vod/${id}/playlist.m3u8`,
    createdAt: "2026-11-01T14:00:00.000Z",
    stoppedAt: "2026-11-01T15:30:00.000Z",
    ...fields,
  };
}

describe("dates", () => {
  it("accepts only real calendar dates written YYYY-MM-DD", () => {
    expect(isMatchDate("2026-11-08")).toBe(true);
    expect(isMatchDate("2026-02-30")).toBe(false);
    expect(isMatchDate("8/11 2026")).toBe(false);
    expect(isMatchDate(20261108)).toBe(false);
  });

  it("takes today in the club's time zone, not the server's", () => {
    // 23:30 UTC on 7 Nov is already 8 Nov in Stockholm.
    expect(clubDate(new Date("2026-11-07T23:30:00Z"))).toBe("2026-11-08");
  });
});

describe("MatchSchedule", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let registry: TeamRegistry;
  let live: Map<string, LiveStream>;
  let schedule: MatchSchedule;

  beforeEach(() => {
    storage = memoryStorage();
    registry = new TeamRegistry(storage);
    live = new Map();
    schedule = new MatchSchedule(storage, registry, () => live);
  });

  it("adds no typed team to the registry when the match is refused", async () => {
    const own = await registry.ensure("P12", { own: true });
    await expect(schedule.create({ date: "2026-11-08", ownTeamName: "Nya laget", opponentName: "nya laget" })).rejects.toThrow("Välj två olika lag.");
    const match = await schedule.create({ date: "2026-11-08", ownTeamId: own!.id, opponentName: "AIK" });
    await expect(schedule.update(match.id, { opponentName: "P12" })).rejects.toThrow("Välj två olika lag.");
    await expect(schedule.update("saknas", { opponentName: "Täby" })).rejects.toThrow("Matchen finns inte.");
    expect((await registry.list()).map((t) => t.name).sort()).toEqual(["AIK", "P12"]);
  });

  it("stores a match in the club's storage, with the club's venue unless another is given", async () => {
    const p12 = await registry.create({ name: "P12", own: true });
    const match = await schedule.create({ date: "2026-11-08", time: "14:00", ownTeamId: p12.id, opponentName: "Hornets" });

    expect(match).toMatchObject({
      date: "2026-11-08",
      time: "14:00",
      venue: "Testhallen",
      ownTeam: { id: p12.id, name: "P12", shortName: "P12", own: true },
      opponent: { name: "Hornets", own: false },
      status: "planned",
      recordingIds: [],
    });
    expect(match.result).toBeUndefined();
    // The new opponent joined the registry, ready for a logo.
    expect((await registry.findByName("hornets"))?.id).toBe(match.opponent.id);

    const stored = JSON.parse(storage.files.get(MATCHES_KEY)!);
    expect(stored.matches).toHaveLength(1);
    expect(stored.matches[0].opponent).toEqual({ id: match.opponent.id, name: "Hornets" });

    const reloaded = new MatchSchedule(storage, new TeamRegistry(storage), () => live);
    expect(await reloaded.get(match.id)).toEqual(match);
  });

  it("needs both teams and a date; time and venue are optional", async () => {
    await expect(schedule.create({ ownTeamName: "P12", opponentName: "AIK" })).rejects.toMatchObject({ status: 400 });
    await expect(schedule.create({ date: "2026-11-08", ownTeamName: "P12" })).rejects.toMatchObject({ status: 400 });
    await expect(schedule.create({ date: "2026-11-08", time: "25:00", ownTeamName: "P12", opponentName: "AIK" }))
      .rejects.toThrow(/TT:MM/);
    await expect(schedule.create({ date: "2026-11-08", ownTeamName: "AIK", opponentName: "aik" }))
      .rejects.toThrow(/två olika lag/);
    await expect(schedule.create({ date: "2026-11-08", ownTeamId: "nope", opponentName: "AIK" })).rejects.toMatchObject({ status: 400 });

    const bare = await schedule.create({ date: "2026-11-08", ownTeamName: "P12", opponentName: "AIK", venue: "" });
    expect(bare.time).toBeUndefined();
    expect(bare.venue).toBeUndefined();
  });

  it("lists by date and time, a match without a time first on its day, between two dates", async () => {
    const add = (date: string, time?: string) =>
      schedule.create({ date, ...(time && { time }), ownTeamName: "P12", opponentName: `${date} ${time ?? ""}` });
    await add("2026-11-09", "10:00");
    await add("2026-11-08", "14:00");
    await add("2026-11-08");
    await add("2026-11-08", "09:30");
    await add("2026-10-30", "18:00");

    const when = (list: { date: string; time?: string }[]) => list.map((m) => `${m.date} ${m.time ?? "-"}`);
    expect(when(await schedule.list())).toEqual([
      "2026-10-30 18:00", "2026-11-08 -", "2026-11-08 09:30", "2026-11-08 14:00", "2026-11-09 10:00",
    ]);
    expect(when(await schedule.list({ from: "2026-11-08", to: "2026-11-08" }))).toEqual([
      "2026-11-08 -", "2026-11-08 09:30", "2026-11-08 14:00",
    ]);
    expect(when(await schedule.list({ from: "2026-11-09" }))).toEqual(["2026-11-09 10:00"]);
  });

  it("changes only what is sent; an empty time or venue clears it", async () => {
    const match = await schedule.create({ date: "2026-11-08", time: "14:00", ownTeamName: "P12", opponentName: "AIK" });
    const moved = await schedule.update(match.id, { time: "15:30" });
    expect(moved).toMatchObject({ date: "2026-11-08", time: "15:30", venue: "Testhallen", opponent: { name: "AIK" } });

    const cleared = await schedule.update(match.id, { time: "", venue: null });
    expect(cleared.time).toBeUndefined();
    expect(cleared.venue).toBeUndefined();

    await expect(schedule.update("nope", { time: "12:00" })).rejects.toMatchObject({ status: 404 });
    await expect(schedule.update(match.id, { date: "nope" })).rejects.toMatchObject({ status: 400 });
  });

  it("shows the team as the registry has it now: renamed, merged, or removed", async () => {
    const match = await schedule.create({ date: "2026-11-08", ownTeamName: "P12", opponentName: "Hornetts" });
    await registry.update(match.opponent.id, { name: "Hornets" });
    expect((await schedule.get(match.id))?.opponent.name).toBe("Hornets");

    // Merged into another team: found by its old name.
    const kept = await registry.create({ name: "Stockholm Hornets" });
    await registry.merge(kept.id, match.opponent.id);
    expect((await schedule.get(match.id))?.opponent).toMatchObject({ id: kept.id, name: "Stockholm Hornets" });

    // Removed: the match keeps the name it had, with no registry id.
    await registry.remove(kept.id);
    const after = await schedule.get(match.id);
    expect(after?.opponent).toMatchObject({ id: "", name: "Hornetts" });
    expect(after?.opponent.shortName).toBeTruthy();
  });

  it("reads its recordings, status and result from the recordings", async () => {
    const match = await schedule.create({ date: "2026-11-01", ownTeamName: "P12", opponentName: "AIK" });
    expect((await schedule.get(match.id))?.status).toBe("planned");

    // A camera is on it: live, and listed before its VOD entry is written.
    live.set("cam1", { matchId: match.id, createdAt: "2026-11-01T14:00:00.000Z" });
    expect(await schedule.get(match.id)).toMatchObject({ status: "live", recordingIds: ["cam1"] });

    storage.vods = [
      vod("cam1", { matchId: match.id, createdAt: "2026-11-01T14:00:00.000Z", result: { home: 40, away: 38, setBy: "camera", setAt: "x" } }),
      vod("cam2", { matchId: match.id, createdAt: "2026-11-01T14:20:00.000Z", result: { home: 72, away: 65, setBy: "camera", setAt: "y" } }),
      vod("cam3", { matchId: match.id, createdAt: "2026-11-01T14:30:00.000Z" }),
      vod("other"),
    ];
    live.set("cam1", { matchId: match.id, createdAt: "2026-11-01T14:00:00.000Z", stoppedAt: "2026-11-01T15:30:00.000Z" });
    const ended = await schedule.get(match.id);
    expect(ended?.status).toBe("ended");
    expect(ended?.recordingIds).toEqual(["cam1", "cam2", "cam3"]);
    // The newest recording that has a result, without who set it.
    expect(ended?.result).toEqual({ home: 72, away: 65 });
  });

  it("removes a match without recordings, and refuses one with", async () => {
    const empty = await schedule.create({ date: "2026-11-08", ownTeamName: "P12", opponentName: "AIK" });
    await schedule.remove(empty.id);
    expect(await schedule.get(empty.id)).toBeNull();
    await expect(schedule.remove(empty.id)).rejects.toMatchObject({ status: 404 });

    const played = await schedule.create({ date: "2026-11-01", ownTeamName: "P12", opponentName: "AIK" });
    storage.vods = [vod("cam1", { matchId: played.id })];
    await expect(schedule.remove(played.id)).rejects.toMatchObject({ status: 409 });
    expect(await schedule.get(played.id)).not.toBeNull();

    // Once its recording is deleted under Inspelningar, it can go.
    storage.vods = [];
    await schedule.remove(played.id);
  });

  it("fixes a misspelt team on the match's recordings too, but keeps a title written by hand", async () => {
    const match = await schedule.create({ date: "2026-11-01", ownTeamName: "P12", opponentName: "Hornetts" });
    storage.vods = [
      vod("cam1", { matchId: match.id, homeTeam: "P12", awayTeam: "Hornetts", matchTitle: "P12 vs Hornetts" }),
      vod("cam2", { matchId: match.id, homeTeam: "P12", awayTeam: "Hornetts", matchTitle: "Seriefinal" }),
      vod("other", { homeTeam: "P12", awayTeam: "Hornetts", matchTitle: "P12 vs Hornetts" }),
    ];

    const fixed = await schedule.update(match.id, { opponentName: "Hornets", venue: "Sporthallen" });
    expect(fixed.opponent.name).toBe("Hornets");
    expect(fixed.recordingIds).toEqual(["cam1", "cam2"]);

    const [cam1, cam2, other] = storage.vods;
    expect(cam1).toMatchObject({ awayTeam: "Hornets", matchTitle: "P12 vs Hornets", location: "Sporthallen" });
    expect(cam2).toMatchObject({ awayTeam: "Hornets", matchTitle: "Seriefinal" });
    expect(other.awayTeam).toBe("Hornetts");
  });

  it("puts a recording without a match on one the same day between the same teams, or makes one", async () => {
    const aik = await registry.create({ name: "AIK" });
    await registry.update(aik.id, { name: "AIK Basket" });
    const planned = await schedule.create({ date: "2026-11-08", time: "14:00", ownTeamName: "P12", opponentId: aik.id });

    // Typed differently, and under the team's old name: still the planned match.
    const found = await schedule.forRecording("2026-11-08", "p12 ", "aik", { own: true, opponent: true });
    expect(found.id).toBe(planned.id);

    // Another day, or another opponent: a new match, made by the camera.
    const otherDay = await schedule.forRecording("2026-11-09", "P12", "AIK", { own: true, opponent: true });
    expect(otherDay.id).not.toBe(planned.id);
    expect((await schedule.get(otherDay.id))).toMatchObject({ source: "camera", venue: "Testhallen", status: "planned" });

    const fresh = await schedule.forRecording("2026-11-08", "P12", "Solna Vikings", { own: true, opponent: true });
    expect(fresh.id).not.toBe(planned.id);
    expect(await registry.findByName("solna vikings")).not.toBeNull();
  });

  it("makes one match when two cameras without one start at once", async () => {
    const [a, b] = await Promise.all([
      schedule.forRecording("2026-11-08", "P12", "Hornets", { own: true, opponent: true }),
      schedule.forRecording("2026-11-08", "p12", "HORNETS", { own: true, opponent: true }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await schedule.list()).toHaveLength(1);
  });

  it("does not add the placeholders to the registry when the camera typed nothing", async () => {
    const match = await schedule.forRecording("2026-11-08", "Test IF", "Motståndare", { own: false, opponent: false });
    expect(match.opponent).toMatchObject({ id: "", name: "Motståndare" });
    expect(await registry.list()).toEqual([]);
  });

  it("finds the match an older app announces as \"P12 vs AIK\"", async () => {
    const match = await schedule.create({ date: "2026-11-08", ownTeamName: "P12", opponentName: "AIK" });
    expect(await schedule.findAnnounced("p12 vs aik", "2026-11-08")).toBe(match.id);
    expect(await schedule.findAnnounced("P12 vs AIK", "2026-11-09")).toBeNull();
    expect(await schedule.findAnnounced("Kvällens match", "2026-11-08")).toBeNull();
  });
});

describe("team backfill", () => {
  it("adds the teams of earlier recordings once, the club's side as its own, without placeholders", async () => {
    const storage = memoryStorage();
    const registry = new TeamRegistry(storage);
    await registry.create({ name: "AIK" });
    storage.vods = [
      vod("a", { homeTeam: "P12", awayTeam: "aik" }),
      vod("b", { homeTeam: "P12", awayTeam: "Hornets " }),
      vod("c", { homeTeam: "Test IF", awayTeam: "Motståndare" }),
      vod("d", { homeTeam: "F14", awayTeam: "hornets" }),
    ];

    expect(await backfillTeams(storage, registry, ["Test IF", "Motståndare"])).toBe(3);
    const list = await registry.list();
    expect(list.map((t) => `${t.name}${t.own ? " (eget)" : ""}`)).toEqual(["F14 (eget)", "P12 (eget)", "AIK", "Hornets"]);
    expect(JSON.parse(storage.files.get(BACKFILL_KEY)!).teamsFromRecordings).toBeTruthy();

    // Done once: a team removed afterwards stays removed.
    await registry.remove(list.find((t) => t.name === "Hornets")!.id);
    expect(await backfillTeams(storage, registry, ["Test IF", "Motståndare"])).toBe(0);
    expect(await registry.findByName("Hornets")).toBeNull();
  });

  it("marks nothing when the recordings cannot be read, so the next start tries again", async () => {
    const storage = memoryStorage();
    storage.readVodIndex.mockRejectedValueOnce(new Error("storage starting"));
    await expect(backfillTeams(storage, new TeamRegistry(storage), [])).rejects.toThrow();
    expect(storage.files.has(BACKFILL_KEY)).toBe(false);
    expect(storage.files.has(TEAMS_KEY)).toBe(false);
  });
});

// --- Routes ---

describe("match routes, streams and announcements", () => {
  let app: FastifyInstance;
  let storage: ReturnType<typeof memoryStorage>;
  let restreamer: ReturnType<typeof restreamerStub>;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;
  let camera: Record<string, string>;
  let cameraB: Record<string, string>;
  const today = clubDate();

  function restreamerStub() {
    return {
      rtmpHost: "rtmp.example.com",
      baseUrlValue: "https://restreamer.example.com",
      createProcess: vi.fn(async () => ({})),
      rtmpUrl: (id: string) => `rtmp://rtmp.example.com/live/${id}`,
      hlsUrl: (id: string) => `https://restreamer.example.com/memfs/${id}.m3u8`,
    };
  }
  const osc = {
    getState: () => "running",
    getInfo: () => ({ url: "https://restreamer.example.com", rtmpHost: "rtmp.example.com" }),
    streamStarted: vi.fn(),
  };

  async function pair(name: string): Promise<Record<string, string>> {
    const { code } = devices.createPairingCode();
    const { token } = (await devices.pair(code, name))!;
    return { "x-device-token": token };
  }

  const start = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/streams", headers, payload: { name: "Läktaren", ...payload } });

  beforeEach(async () => {
    streamMeta.clear();
    resetBroadcastState();
    (mutableConfig as { VIEWER_PIN: string }).VIEWER_PIN = "5678";
    storage = memoryStorage();
    restreamer = restreamerStub();
    initServices(restreamer as never, storage as never, osc as never);
    admin = { "x-admin-token": createAdminToken() };
    viewer = { authorization: `Bearer ${createViewerToken()}` };
    camera = await pair("Läktaren");
    cameraB = await pair("Kortsidan");
    app = Fastify();
    await app.register(matchRoutes);
    await app.register(streamRoutes);
    await app.register(broadcastRoutes);
  });

  afterEach(async () => {
    await app.close();
    streamMeta.clear();
  });

  it("shows the schedule to viewers, paired cameras and the admin, not to anyone", async () => {
    await matches.create({ date: today, time: "14:00", ownTeamName: "P12", opponentName: "Hornets" });
    expect((await app.inject({ url: "/api/matches" })).statusCode).toBe(401);
    for (const headers of [viewer, camera, admin]) {
      const res = await app.inject({ url: "/api/matches", headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().map((m: { opponent: { name: string } }) => m.opponent.name)).toEqual(["Hornets"]);
    }
  });

  it("filters by date and refuses a date it cannot read", async () => {
    await matches.create({ date: "2026-11-08", ownTeamName: "P12", opponentName: "Hornets" });
    await matches.create({ date: "2026-11-15", ownTeamName: "P12", opponentName: "AIK" });
    const res = await app.inject({ url: "/api/matches?from=2026-11-10&to=2026-11-30", headers: viewer });
    expect(res.json().map((m: { date: string }) => m.date)).toEqual(["2026-11-15"]);
    expect((await app.inject({ url: "/api/matches?from=8+nov", headers: viewer })).statusCode).toBe(400);
  });

  it("gives one match by id, and match_not_found for an unknown one", async () => {
    const match = await matches.create({ date: "2026-11-08", ownTeamName: "P12", opponentName: "Hornets" });
    const res = await app.inject({ url: `/api/matches/${match.id}`, headers: camera });
    expect(res.json()).toMatchObject({ id: match.id, ownTeam: { name: "P12" }, status: "planned", recordingIds: [] });
    const missing = await app.inject({ url: "/api/matches/nope", headers: viewer });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("match_not_found");
  });

  it("lets only the admin add, change and remove matches", async () => {
    const body = { date: "2026-11-08", time: "14:00", ownTeamName: "P12", opponentName: "Hornets" };
    expect((await app.inject({ method: "POST", url: "/api/admin/matches", headers: viewer, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/matches", headers: camera, payload: body })).statusCode).toBe(401);

    const created = await app.inject({ method: "POST", url: "/api/admin/matches", headers: admin, payload: body });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const noDate = await app.inject({ method: "POST", url: "/api/admin/matches", headers: admin, payload: { ...body, date: "" } });
    expect(noDate.statusCode).toBe(400);
    expect(noDate.json().error).toMatch(/datum/);

    const changed = await app.inject({ method: "PUT", url: `/api/admin/matches/${id}`, headers: admin, payload: { venue: "Sporthallen" } });
    expect(changed.json()).toMatchObject({ venue: "Sporthallen", time: "14:00" });

    expect((await app.inject({ method: "DELETE", url: `/api/admin/matches/${id}`, headers: viewer })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/matches/${id}`, headers: admin })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/matches/${id}`, headers: admin })).statusCode).toBe(404);
  });

  it("records a picked match with its teams and venue, whatever the app typed", async () => {
    const match = await matches.create({ date: today, time: "14:00", ownTeamName: "P12", opponentName: "Hornets", venue: "Sporthallen" });
    const res = await start(camera, { matchId: match.id, team: "fel lag", opponent: "fel motståndare" });
    expect(res.statusCode).toBe(201);
    const stream = res.json();
    expect(stream).toMatchObject({ matchId: match.id, homeTeam: "P12", awayTeam: "Hornets" });

    expect(streamMeta.get(stream.id)?.matchId).toBe(match.id);
    expect(storage.vods[0]).toMatchObject({
      id: stream.id, matchId: match.id, homeTeam: "P12", awayTeam: "Hornets",
      matchTitle: "P12 vs Hornets", location: "Sporthallen", matchDate: today,
    });
    // Nothing typed joined the registry.
    expect(await teams.findByName("fel lag")).toBeNull();

    // A second camera on the same match lands on it too, and it is live.
    const second = (await start(cameraB, { name: "Kortsidan", matchId: match.id })).json();
    const shown = (await app.inject({ url: `/api/matches/${match.id}`, headers: viewer })).json();
    expect(shown.status).toBe("live");
    expect(shown.recordingIds.sort()).toEqual([stream.id, second.id].sort());
  });

  it("turns away an unknown match before anything starts", async () => {
    const res = await start(camera, { matchId: "nope", team: "P12", opponent: "AIK" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "match_not_found" });
    expect(typeof res.json().message).toBe("string");
    expect(restreamer.createProcess).not.toHaveBeenCalled();
    expect(streamMeta.size).toBe(0);
  });

  it("puts an older app's recording on the planned match with the same teams", async () => {
    const planned = await matches.create({ date: today, time: "14:00", ownTeamName: "P12", opponentName: "AIK" });
    const res = await start(camera, { team: "p12", opponent: "aik " });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ matchId: planned.id, homeTeam: "P12", awayTeam: "AIK" });
    expect(storage.vods[0].matchId).toBe(planned.id);
  });

  it("makes a match after the fact for \"Annan match\", and the second camera joins it", async () => {
    const a = (await start(camera, { team: "P12", opponent: "Solna Vikings" })).json();
    const b = (await start(cameraB, { name: "Kortsidan", team: "P12", opponent: "solna vikings" })).json();
    expect(a.matchId).toBeTruthy();
    expect(b.matchId).toBe(a.matchId);

    const match = await matches.get(a.matchId);
    expect(match).toMatchObject({ date: today, source: "camera", ownTeam: { name: "P12", own: true }, opponent: { name: "Solna Vikings" } });
    expect((await teams.findByName("P12"))?.own).toBe(true);
  });

  it("gives an app that typed no teams a match with the placeholders, as before", async () => {
    const res = await start(camera, {});
    expect(res.json()).toMatchObject({ homeTeam: "Test IF", awayTeam: "Motståndare" });
    expect(res.json().matchId).toBeTruthy();
    expect(await teams.list()).toEqual([]);
  });

  it("puts a match id on the stream list", async () => {
    const match = await matches.create({ date: today, ownTeamName: "P12", opponentName: "AIK" });
    const stream = (await start(camera, { matchId: match.id })).json();
    restreamer = Object.assign(restreamer, { listManagedProcesses: vi.fn(async () => []) });
    const list = (await app.inject({ url: "/api/streams", headers: viewer })).json();
    expect(list.find((s: { id: string }) => s.id === stream.id)?.matchId).toBe(match.id);
  });

  it("names the teams on the stream list, so a live card needs no schedule", async () => {
    const match = await matches.create({ date: today, ownTeamName: "P12", opponentName: "AIK" });
    const picked = (await start(camera, { matchId: match.id })).json();
    const typed = (await start(cameraB, { name: "Kortsidan", team: "F14", opponent: "Hornets" })).json();
    restreamer = Object.assign(restreamer, { listManagedProcesses: vi.fn(async () => []) });
    const list = (await app.inject({ url: "/api/streams", headers: viewer })).json();
    const shown = (id: string) => list.find((s: { id: string }) => s.id === id);
    expect(shown(picked.id)).toMatchObject({ matchId: match.id, homeTeam: "P12", awayTeam: "AIK" });
    expect(shown(typed.id)).toMatchObject({ matchId: typed.matchId, homeTeam: "F14", awayTeam: "Hornets" });

    // A stream from before the names were kept shows without them, as before.
    streamMeta.set("old", { name: "Gammal kamera", createdAt: new Date().toISOString(), partNumber: 1, periodNumber: 1, completedParts: [] });
    const again = (await app.inject({ url: "/api/streams", headers: viewer })).json();
    const old = again.find((s: { id: string }) => s.id === "old");
    expect(old).toBeTruthy();
    expect(old).not.toHaveProperty("homeTeam");
    expect(old).not.toHaveProperty("matchId");
  });

  it("shows two cameras' announcements of one match once, and starting it ends both", async () => {
    const match = await matches.create({ date: today, time: "14:00", ownTeamName: "P12", opponentName: "AIK" });
    // An older app names its match only in the message; a newer one by id.
    await app.inject({ method: "PATCH", url: "/api/broadcast", headers: camera, payload: { status: "upcoming", message: "P12 vs AIK" } });
    await app.inject({ method: "PATCH", url: "/api/broadcast", headers: cameraB, payload: { status: "upcoming", matchId: match.id } });

    let state = getBroadcastState(streamMeta.values());
    expect(state.status).toBe("upcoming");
    expect(state.upcoming).toHaveLength(1);
    expect(state.upcoming[0]).toMatchObject({ matchId: match.id, message: "P12 vs AIK" });

    await start(camera, { matchId: match.id });
    state = getBroadcastState(streamMeta.values());
    expect(state.status).toBe("live");
    expect(state.upcoming).toEqual([]);
  });

  it("keeps a free-text announcement that fits no match, as before", async () => {
    await app.inject({ method: "PATCH", url: "/api/broadcast", headers: camera, payload: { status: "upcoming", message: "Träningsmatch" } });
    const state = getBroadcastState(streamMeta.values());
    expect(state.upcoming).toEqual([{ message: "Träningsmatch", updatedAt: expect.any(String) }]);
  });
});
