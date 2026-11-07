/**
 * Guest spaces (#50): the opponent's highlights, one space per match, apart
 * from the club's own clips.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  GuestSpaces,
  GUEST_INDEX_KEY,
  GUEST_RETENTION_MS,
  deleteAfter,
  newGuestCode,
  normaliseGuestCode,
  type GuestClip,
  type GuestMatchInfo,
} from "../guest-spaces.js";

function memoryStorage() {
  const files = new Map<string, string>();
  return {
    files,
    async readFileIfExists(key: string) {
      return files.get(key) ?? null;
    },
    async uploadBuffer(key: string, body: Buffer | string) {
      files.set(key, body.toString());
    },
    async deletePrefix(prefix: string) {
      let n = 0;
      for (const key of [...files.keys()]) if (key.startsWith(prefix)) { files.delete(key); n++; }
      return n;
    },
  };
}

const MATCH: GuestMatchInfo = {
  streamId: "s1",
  matchId: "m1",
  homeTeam: "Älta",
  awayTeam: "Nacka",
  venue: "Älta hallen",
  matchDate: "2026-11-07",
};

function clip(id: string, createdAt = new Date().toISOString()): GuestClip {
  return { id, mp4Url: `/api/guest/clips/${id}/media/${id}.mp4`, durationSeconds: 8, createdAt };
}

describe("guest codes", () => {
  it("are 8 characters that cannot be mistaken for each other", () => {
    for (let i = 0; i < 200; i++) {
      const code = newGuestCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it("are read as typed, with spaces, dashes and lower case", () => {
    expect(normaliseGuestCode(" abcd-ef 23 ")).toBe("ABCDEF23");
  });
});

describe("GuestSpaces", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let spaces: GuestSpaces;

  beforeEach(() => {
    storage = memoryStorage();
    spaces = new GuestSpaces(storage);
  });

  it("has no space for a match until its first opponent clip", async () => {
    expect(await spaces.list()).toEqual([]);
    expect(storage.files.has(GUEST_INDEX_KEY)).toBe(false);

    const id = await spaces.spaceIdFor("s1", "m1");
    const space = await spaces.addClip(MATCH, id, clip("c1"));

    expect(space.id).toBe(id);
    expect(space.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(space.awayTeam).toBe("Nacka");
    expect(space.venue).toBe("Älta hallen");
    expect(space.clips.map((c) => c.id)).toEqual(["c1"]);
  });

  it("keeps one space per match, also when the match is restarted on a new stream", async () => {
    const id = await spaces.spaceIdFor("s1", "m1");
    await spaces.addClip(MATCH, id, clip("c1"));
    expect(await spaces.spaceIdFor("s1", "m1")).toBe(id);
    await spaces.addClip(MATCH, id, clip("c2"));

    // Restarted: a new stream, the same match
    expect(await spaces.spaceIdFor("s2", "m1")).toBe(id);
    await spaces.addClip({ ...MATCH, streamId: "s2" }, id, clip("c3"));

    const all = await spaces.list();
    expect(all).toHaveLength(1);
    expect(all[0].streamIds).toEqual(["s1", "s2"]);
    expect(all[0].clips).toHaveLength(3);
  });

  it("never makes two spaces for two clips saved at once", async () => {
    const [a, b] = await Promise.all([spaces.spaceIdFor("s1", "m1"), spaces.spaceIdFor("s1", "m1")]);
    await Promise.all([spaces.addClip(MATCH, a, clip("c1")), spaces.addClip(MATCH, b, clip("c2"))]);
    const all = await spaces.list();
    expect(all).toHaveLength(1);
    expect(all[0].clips).toHaveLength(2);
  });

  it("gives every match its own code", async () => {
    await spaces.addClip(MATCH, "a", clip("c1"));
    await spaces.addClip({ ...MATCH, streamId: "s9", matchId: "m9" }, "b", clip("c2"));
    const [x, y] = await spaces.list();
    expect(x.id).not.toBe(y.id);
    expect(x.code).not.toBe(y.code);
    expect((await spaces.byCode(x.code.toLowerCase()))?.id).toBe(x.id);
    expect(await spaces.byCode("")).toBeUndefined();
    expect(await spaces.byCode("NOPE2345")).toBeUndefined();
  });

  it("counts 14 days from the end of the match", async () => {
    await spaces.addClip(MATCH, "a", clip("c1", "2026-11-07T18:00:00.000Z"));
    let space = (await spaces.get("a"))!;
    // Not ended: from the newest clip
    expect(deleteAfter(space).getTime()).toBe(Date.parse("2026-11-07T18:00:00.000Z") + GUEST_RETENTION_MS);

    await spaces.streamEnded("s1", "2026-11-07T19:30:00.000Z");
    space = (await spaces.get("a"))!;
    expect(deleteAfter(space).toISOString()).toBe("2026-11-21T19:30:00.000Z");
  });

  it("keeps its own copy of the result", async () => {
    await spaces.addClip(MATCH, "a", clip("c1"));
    await spaces.noteResult("s1", { home: 54, away: 61 });
    await spaces.noteResult("other", { home: 1, away: 2 });
    expect((await spaces.get("a"))!.result).toEqual({ home: 54, away: 61 });
  });

  it("gives a new code, and the old one stops working", async () => {
    await spaces.addClip(MATCH, "a", clip("c1"));
    const old = (await spaces.get("a"))!.code;
    const renewed = await spaces.newCode("a");
    expect(renewed!.code).not.toBe(old);
    expect(await spaces.byCode(old)).toBeUndefined();
    expect((await spaces.byCode(renewed!.code))?.id).toBe("a");
  });

  it("removes one clip or all of them, files included", async () => {
    await spaces.addClip(MATCH, "a", clip("c1"));
    await spaces.addClip(MATCH, "a", clip("c2"));
    storage.files.set("guest/a/c1.mp4", "x");
    storage.files.set("guest/a/c1.jpg", "x");
    storage.files.set("guest/a/c2.mp4", "x");

    const one = await spaces.removeClips("a", ["c1"]);
    expect(one!.removed.map((c) => c.id)).toEqual(["c1"]);
    expect(one!.files).toBe(2);
    expect(storage.files.has("guest/a/c2.mp4")).toBe(true);

    const rest = await spaces.removeClips("a");
    expect(rest!.removed.map((c) => c.id)).toEqual(["c2"]);
    expect((await spaces.get("a"))!.clips).toEqual([]);
    expect(storage.files.has("guest/a/c2.mp4")).toBe(false);
  });

  it("deletes a whole space and its files", async () => {
    await spaces.addClip(MATCH, "a", clip("c1"));
    storage.files.set("guest/a/c1.mp4", "x");
    const gone = await spaces.removeSpace("a");
    expect(gone!.files).toBe(1);
    expect(await spaces.list()).toEqual([]);
    expect(await spaces.removeSpace("a")).toBeUndefined();
  });

  it("finds a clip and its space", async () => {
    await spaces.addClip(MATCH, "a", clip("c1"));
    const found = await spaces.findClip("c1");
    expect(found?.space.id).toBe("a");
    expect(await spaces.findClip("nope")).toBeUndefined();
  });
});

// --- The camera's clip request with a team ---

vi.mock("../clip-service.js", () => ({
  createClip: vi.fn(async () => ({
    id: "own1", streamId: "s1", hlsUrl: "/api/clips/own1/playlist.m3u8", durationSeconds: 8, createdAt: new Date().toISOString(),
  })),
  createGuestClip: vi.fn(async (_c: unknown, _t: number, _m: unknown, _l: unknown, _spaceId: string) => ({
    id: `g${Math.random().toString(16).slice(2, 8)}`,
    mp4Url: "/api/guest/clips/g/media/g.mp4",
    durationSeconds: 8,
    createdAt: new Date().toISOString(),
  })),
}));

describe("POST /api/streams/:id/clip with a team", () => {
  let app: FastifyInstance;
  let storage: ReturnType<typeof memoryStorage>;
  const clipsIndex: unknown[] = [];

  beforeEach(async () => {
    vi.resetModules();
    storage = memoryStorage();
    clipsIndex.length = 0;
    const state = await import("../state.js");
    state.initServices({} as never, {
      ...storage,
      readVodIndex: vi.fn().mockResolvedValue([
        { id: "s1", homeTeam: "Älta", awayTeam: "Nacka", location: "Älta hallen", matchDate: "2026-11-07", matchId: "m1" },
      ]),
      readClipsIndex: vi.fn(async () => clipsIndex),
      addClipEntry: vi.fn(async (c: unknown) => { clipsIndex.push(c); }),
    } as never, {} as never);
    state.streamMeta.set("s1", { name: "Älta – Nacka", createdAt: "2026-11-07T18:00:00Z", partNumber: 1, periodNumber: 1, completedParts: [] });
    state.collectors.set("s1", {} as never);
    const { config } = await import("../config.js");
    (config as { API_KEY: string }).API_KEY = "key";
    app = Fastify();
    const { default: clipRoutes } = await import("../routes/clip-routes.js");
    await app.register(clipRoutes);
  });

  const post = (body: object, stream = "s1") =>
    app.inject({ method: "POST", url: `/api/streams/${stream}/clip`, headers: { "x-api-key": "key" }, payload: body });

  it("puts an opponent clip in the match's guest space, never in the club's clips", async () => {
    const res = await post({ team: "opponent" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ team: "opponent", teamName: "Nacka" });
    expect(res.json().code).toBeUndefined();

    expect(clipsIndex).toHaveLength(0);
    const spaces = JSON.parse(storage.files.get(GUEST_INDEX_KEY)!);
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ awayTeam: "Nacka", homeTeam: "Älta", venue: "Älta hallen", matchId: "m1" });
    expect(spaces[0].clips).toHaveLength(1);

    const list = await app.inject({ url: "/api/clips", headers: { "x-api-key": "key" } });
    expect(list.json()).toEqual([]);
  });

  it("saves a clip without a team as the club's own, as before", async () => {
    const res = await post({});
    expect(res.statusCode).toBe(201);
    expect(res.json().team).toBe("own");
    expect(clipsIndex).toHaveLength(1);
    expect(storage.files.has(GUEST_INDEX_KEY)).toBe(false);
  });

  it("refuses a team it does not know", async () => {
    const res = await post({ team: "referee" });
    expect(res.statusCode).toBe(400);
  });
});
