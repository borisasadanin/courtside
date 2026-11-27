/**
 * The match's MVP (#121, phase 2: #162, #164).
 *
 * What matters: an MVP is one of the match's own clips and a jersey number,
 * 0–99 or 00, never a name or free text; the match shows it with the sponsor
 * of "mvp" when the club has one; one sponsor per team at most has the
 * surface; and the clip's shared page tells that it is the MVP.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { initServices, matches, sponsors, streamMeta, teams } from "../state.js";
import { createAdminToken, createViewerToken } from "../auth.js";
import { isJersey, type Match } from "../matches.js";
import type { HighlightClip, VodEntry } from "../types.js";
import matchRoutes from "../routes/match-routes.js";
import clipRoutes from "../routes/clip-routes.js";
import { memoryStorage } from "./sponsor-fakes.js";

vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));
vi.mock("../stream-meta-store.js", () => ({ saveStreamMetaSoon: vi.fn() }));

/** A real 1×1 PNG. */
const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let app: FastifyInstance;
let clips: HighlightClip[];
let match: Match;
let other: Match;
let ownTeamId: string;

const admin = () => ({ "x-admin-token": createAdminToken() });
const viewer = () => ({ authorization: `Bearer ${createViewerToken()}` });

function clipEntry(id: string, streamId: string): HighlightClip {
  return {
    id, streamId, hlsUrl: `/api/clips/${id}/playlist.m3u8`, thumbnailUrl: `/api/clips/${id}/media/${id}.jpg`,
    durationSeconds: 8, createdAt: "2026-11-01T14:30:00.000Z",
  };
}

function recording(id: string, matchId: string): Partial<VodEntry> {
  return { id, matchId, matchTitle: "P12 vs Hornets", homeTeam: "P12", awayTeam: "Hornets", matchDate: "2026-11-01", location: "", hlsUrl: "", createdAt: "2026-11-01T14:00:00.000Z" };
}

beforeEach(async () => {
  streamMeta.clear();
  const storage = memoryStorage();
  clips = [];
  initServices({} as never, Object.assign(storage, {
    readClipsIndex: vi.fn(async () => clips.map((c) => ({ ...c }))),
  }) as never, {} as never);
  const own = await teams.create({ name: "P12", own: true });
  const opponent = await teams.create({ name: "Hornets" });
  ownTeamId = own.id;
  match = await matches.create({ date: "2026-11-01", ownTeamId: own.id, opponentId: opponent.id });
  other = await matches.create({ date: "2026-11-08", ownTeamId: own.id, opponentId: opponent.id });
  storage.vods.push(recording("stream01", match.id), recording("stream02", other.id));
  clips.push(clipEntry("clip0001", "stream01"), clipEntry("clip0002", "stream01"), clipEntry("clip0003", "stream02"));
  app = Fastify();
  await app.register(matchRoutes);
  await app.register(clipRoutes);
});

afterEach(async () => {
  await app.close();
});

const put = (id: string, payload: unknown, headers: Record<string, string> = admin()) =>
  app.inject({ method: "PUT", url: `/api/admin/matches/${id}/mvp`, payload: payload as object, headers });

describe("jersey numbers (#162)", () => {
  it("takes 0–99 and 00, digits only", () => {
    for (const ok of ["0", "00", "7", "12", "99"]) expect(isJersey(ok)).toBe(true);
    for (const bad of ["100", "-1", "07", "000", "1.5", "12a", "Kalle", "#12", " 12", "", "١٢", 12, null, undefined]) {
      expect(isJersey(bad)).toBe(false);
    }
  });
});

describe("PUT and DELETE /api/admin/matches/:id/mvp (#162)", () => {
  it("wants the admin PIN", async () => {
    expect((await put(match.id, { clipId: "clip0001", jersey: "12" }, {})).statusCode).toBe(401);
    expect((await put(match.id, { clipId: "clip0001", jersey: "12" }, viewer())).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/matches/${match.id}/mvp`, headers: viewer() })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/admin/matches/${match.id}/clips`, headers: viewer() })).statusCode).toBe(401);
  });

  it("refuses a number out of range, free text and a name", async () => {
    for (const jersey of ["100", "-1", "07", "12b", "Kalle Anka", "", 1.5, 100, null]) {
      const res = await put(match.id, { clipId: "clip0001", jersey });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Tröjnumret ska vara 0–99 eller 00.");
    }
    expect((await matches.get(match.id))?.mvp).toBeUndefined();
  });

  it("refuses a clip from another match, and one that does not exist", async () => {
    const res = await put(match.id, { clipId: "clip0003", jersey: "12" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Klippet hör inte till matchen.");
    expect((await put(match.id, { clipId: "nosuchclip", jersey: "12" })).statusCode).toBe(400);
    expect((await put(match.id, { jersey: "12" })).statusCode).toBe(400);
    expect((await put("nosuchmatch", { clipId: "clip0001", jersey: "12" })).statusCode).toBe(404);
    expect((await matches.get(match.id))?.mvp).toBeUndefined();
  });

  it("sets, changes and removes the MVP; 00 stays 00", async () => {
    expect((await put(match.id, { clipId: "clip0001", jersey: 12 })).json().mvp).toEqual({ clipId: "clip0001", jersey: "12" });
    expect((await put(match.id, { clipId: "clip0002", jersey: "00" })).json().mvp).toEqual({ clipId: "clip0002", jersey: "00" });
    const shown = (await app.inject({ url: `/api/matches/${match.id}`, headers: viewer() })).json();
    expect(shown.mvp).toEqual({ clipId: "clip0002", jersey: "00" });

    // A change of the match keeps it.
    await app.inject({ method: "PUT", url: `/api/admin/matches/${match.id}`, payload: { venue: "Hallen" }, headers: admin() });
    expect((await matches.get(match.id))?.mvp).toEqual({ clipId: "clip0002", jersey: "00" });

    const removed = await app.inject({ method: "DELETE", url: `/api/admin/matches/${match.id}/mvp`, headers: admin() });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).not.toHaveProperty("mvp");
    expect((await matches.get(match.id))?.mvp).toBeUndefined();
  });

  it("lists the match's own clips to choose from", async () => {
    const res = await app.inject({ url: `/api/admin/matches/${match.id}/clips`, headers: admin() });
    expect(res.json().map((c: { id: string }) => c.id)).toEqual(["clip0001", "clip0002"]);
    expect(res.json()[0]).toMatchObject({ thumbnailUrl: "/api/clips/clip0001/media/clip0001.jpg", durationSeconds: 8 });
  });
});

describe("the MVP's sponsor (#162, #164)", () => {
  it("is shown with the MVP only when the surface is on", async () => {
    const x = await sponsors.createSponsor({ name: "ICA", packageId: "platinum" });
    await sponsors.setLogo(x.id, LOGO);
    await put(match.id, { clipId: "clip0001", jersey: "12" });

    const off = (await app.inject({ url: `/api/matches/${match.id}`, headers: viewer() })).json();
    expect(off.mvp).toEqual({ clipId: "clip0001", jersey: "12" });

    await sponsors.setSurfaces({ mvp: true });
    const on = (await app.inject({ url: `/api/matches/${match.id}`, headers: viewer() })).json();
    expect(on.mvp.sponsor).toMatchObject({ id: x.id, name: "ICA", logoUrl: expect.stringContaining(`/api/sponsor-logos/${x.id}`) });
    const list = (await app.inject({ url: "/api/matches", headers: viewer() })).json();
    expect(list.find((m: Match) => m.id === match.id).mvp.sponsor.name).toBe("ICA");
    // A match without an MVP gets no sponsor.
    expect(list.find((m: Match) => m.id === other.id)).not.toHaveProperty("mvp");
  });

  it("goes to one sponsor per team at most", async () => {
    await sponsors.createSponsor({ name: "ICA", packageId: "platinum", teamIds: [ownTeamId], off: ["corner", "match-card", "share-image", "shared-clip"] });
    await expect(sponsors.createSponsor({ name: "Coop", packageId: "platinum", teamIds: [ownTeamId], off: ["corner", "match-card", "share-image", "shared-clip"] }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("sponsor för MVP: ICA") });
  });
});

describe("the MVP on the clip's page (#164)", () => {
  it("is there for the MVP's clip only, with the sponsor when the surface is on", async () => {
    await put(match.id, { clipId: "clip0001", jersey: "7" });
    expect((await app.inject({ url: "/api/clips/clip0001/public" })).json().mvp).toEqual({ jersey: "7" });
    expect((await app.inject({ url: "/api/clips/clip0002/public" })).json()).not.toHaveProperty("mvp");

    await sponsors.createSponsor({ name: "ICA", packageId: "platinum" });
    await sponsors.setSurfaces({ mvp: true });
    expect((await app.inject({ url: "/api/clips/clip0001/public" })).json().mvp).toMatchObject({ jersey: "7", sponsor: { name: "ICA" } });

    await app.inject({ method: "DELETE", url: `/api/admin/matches/${match.id}/mvp`, headers: admin() });
    expect((await app.inject({ url: "/api/clips/clip0001/public" })).json()).not.toHaveProperty("mvp");
  });
});
