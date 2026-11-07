/**
 * Guest spaces in admin (#55): the real routes over an in-memory bucket.
 * Deleting clips must remove their index entries and files and note it in the
 * deletion log; a new code must replace the old one.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { initServices } from "../state.js";
import { GUEST_INDEX_KEY, guestMp4Key, guestThumbnailKey, type GuestSpace } from "../guest-spaces.js";
import { DELETION_LOG_KEY } from "../erasure.js";
import { guestInvitation } from "../routes/guest-admin-routes.js";
import type { VodEntry } from "../types.js";

const ADMIN = { "x-api-key": "test-api-key" };

function memoryMinio(vods: Partial<VodEntry>[] = []) {
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
    async readVodIndex() {
      return vods;
    },
    async presignGet(key: string) {
      return `https://storage.example.com/${key}?sig=x`;
    },
  };
}

function space(id: string, matchDate: string, clipIds: string[], extra: Partial<GuestSpace> = {}): GuestSpace {
  return {
    id,
    code: `CODE${id.toUpperCase()}`.slice(0, 8),
    matchId: `m-${id}`,
    streamIds: [`s-${id}`],
    homeTeam: "Älta",
    awayTeam: "Nacka",
    venue: "Älta hallen",
    matchDate,
    endedAt: `${matchDate}T18:00:00.000Z`,
    createdAt: `${matchDate}T17:00:00.000Z`,
    clips: clipIds.map((c, i) => ({
      id: c,
      mp4Url: `/api/guest/clips/${c}/media/${c}.mp4`,
      thumbnailUrl: `/api/guest/clips/${c}/media/${c}.jpg`,
      durationSeconds: 8,
      createdAt: `${matchDate}T17:0${i}:00.000Z`,
    })),
    ...extra,
  };
}

let app: FastifyInstance;
let minio: ReturnType<typeof memoryMinio>;

async function setup(spaces: GuestSpace[], vods: Partial<VodEntry>[] = []) {
  minio = memoryMinio(vods);
  minio.files.set(GUEST_INDEX_KEY, JSON.stringify(spaces));
  for (const s of spaces) {
    for (const c of s.clips) {
      minio.files.set(guestMp4Key(s.id, c.id), "mp4");
      minio.files.set(guestThumbnailKey(s.id, c.id), "jpg");
    }
  }
  initServices({} as never, minio as never, {} as never);
  app = Fastify();
  const { default: guestAdminRoutes } = await import("../routes/guest-admin-routes.js");
  await app.register(guestAdminRoutes);
}

function log() {
  return JSON.parse(minio.files.get(DELETION_LOG_KEY) ?? "[]");
}

function index(): GuestSpace[] {
  return JSON.parse(minio.files.get(GUEST_INDEX_KEY) ?? "[]");
}

beforeEach(async () => {
  await setup(
    [
      space("old", "2026-10-20", ["o1"]),
      space("new", "2026-11-07", ["n1", "n2"], { result: { home: 50, away: 40 } }),
      space("empty", "2026-11-01", []),
    ],
    [{ id: "s-new", result: { home: 61, away: 58, setBy: "admin", setAt: "2026-11-07T19:00:00Z" } }],
  );
});

describe("admin only", () => {
  it.each([
    ["GET", "/api/admin/guest-spaces"],
    ["GET", "/api/admin/guest-spaces/new"],
    ["GET", "/api/admin/guest-spaces/new/clips/n1/media/n1.mp4"],
    ["DELETE", "/api/admin/guest-spaces/new/clips/n1"],
    ["DELETE", "/api/admin/guest-spaces/new/clips"],
    ["POST", "/api/admin/guest-spaces/new/code"],
  ] as const)("%s %s needs admin", async (method, url) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
    expect(index().find((s) => s.id === "new")?.clips).toHaveLength(2);
  });
});

describe("GET /api/admin/guest-spaces", () => {
  it("lists spaces with clips, newest match first, with code, link and when it goes", async () => {
    const res = await app.inject({ url: "/api/admin/guest-spaces", headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list.map((s: { id: string }) => s.id)).toEqual(["new", "old"]);
    const first = list[0];
    expect(first).toMatchObject({
      homeTeam: "Älta",
      awayTeam: "Nacka",
      venue: "Älta hallen",
      matchDate: "2026-11-07",
      code: "CODENEW",
      link: "https://live.example.com/gast",
      clipCount: 2,
      matchId: "m-new",
      streamIds: ["s-new"],
      deleteAfter: "2026-11-21T18:00:00.000Z",
    });
    // The recording's (corrected) result wins over the space's copy.
    expect(first.result).toEqual({ home: 61, away: 58 });
    expect(list[1].result).toBeNull();
  });

  it("hands out a ready invitation with link, code and dates", async () => {
    const [first] = (await app.inject({ url: "/api/admin/guest-spaces", headers: ADMIN })).json();
    expect(first.invitation).toContain("Älta – Nacka, 7 november 2026");
    expect(first.invitation).toContain("https://live.example.com/gast");
    expect(first.invitation).toContain("koden CODENEW");
    expect(first.invitation).toContain("raderas för alltid den 21 november 2026");
  });
});

describe("guestInvitation", () => {
  it("names the product from configuration", () => {
    const text = guestInvitation({
      homeTeam: "A",
      awayTeam: "B",
      matchDate: "2026-11-07",
      link: "https://x.example/gast",
      code: "ABCD2345",
      deleteAfter: "2026-11-21T18:00:00.000Z",
      product: { name: "Produkten", url: "https://produkt.example" },
    });
    expect(text).toContain("inspelade med Produkten, som er klubb också kan använda: https://produkt.example");
  });
});

describe("GET /api/admin/guest-spaces/:id", () => {
  it("gives the space with its clips, playable through admin's own media route", async () => {
    const res = await app.inject({ url: "/api/admin/guest-spaces/new", headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe("CODENEW");
    expect(body.clips.map((c: { id: string }) => c.id)).toEqual(["n1", "n2"]);
    expect(body.clips[0].mp4Url).toBe("/api/admin/guest-spaces/new/clips/n1/media/n1.mp4");
    expect(body.clips[0].thumbnailUrl).toBe("/api/admin/guest-spaces/new/clips/n1/media/n1.jpg");

    const media = await app.inject({ url: body.clips[0].mp4Url, headers: ADMIN });
    expect(media.statusCode).toBe(302);
    expect(media.headers.location).toContain("guest/new/n1.mp4");

    const link = await app.inject({ url: `${body.clips[0].thumbnailUrl}?link=1`, headers: ADMIN });
    expect(link.json().url).toContain("guest/new/n1.jpg");
  });

  it("serves only the clip's own files", async () => {
    const res = await app.inject({ url: "/api/admin/guest-spaces/new/clips/n1/media/n2.mp4", headers: ADMIN });
    expect(res.statusCode).toBe(403);
  });

  it("404s an unknown space", async () => {
    const res = await app.inject({ url: "/api/admin/guest-spaces/nope", headers: ADMIN });
    expect(res.statusCode).toBe(404);
  });
});

describe("deleting guest clips", () => {
  it("deletes one clip: index entry, files and a log entry", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/admin/guest-spaces/new/clips/n1?onRequest=1", headers: ADMIN });
    expect(res.statusCode).toBe(204);
    expect(index().find((s) => s.id === "new")!.clips.map((c) => c.id)).toEqual(["n2"]);
    expect(minio.files.has(guestMp4Key("new", "n1"))).toBe(false);
    expect(minio.files.has(guestThumbnailKey("new", "n1"))).toBe(false);
    expect(minio.files.has(guestMp4Key("new", "n2"))).toBe(true);
    expect(log()).toEqual([
      expect.objectContaining({ what: "guest-clip", id: "n1", match: "Älta – Nacka", onRequest: true, files: 2 }),
    ]);
  });

  it("404s a clip that is not in the space", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/admin/guest-spaces/new/clips/o1", headers: ADMIN });
    expect(res.statusCode).toBe(404);
    expect(minio.files.has(guestMp4Key("old", "o1"))).toBe(true);
    expect(log()).toEqual([]);
  });

  it("deletes all clips of a space and logs them", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/admin/guest-spaces/new/clips", headers: ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: 2, files: 4 });
    expect(index().find((s) => s.id === "new")!.clips).toEqual([]);
    expect([...minio.files.keys()].some((k) => k.startsWith("guest/new/"))).toBe(false);
    // Other spaces untouched.
    expect(minio.files.has(guestMp4Key("old", "o1"))).toBe(true);
    expect(log()).toEqual([
      expect.objectContaining({ what: "guest-clip", id: "new", match: "Älta – Nacka", onRequest: false, files: 4, clips: 2 }),
    ]);

    // An emptied space leaves the list; it still opens by id.
    const list = (await app.inject({ url: "/api/admin/guest-spaces", headers: ADMIN })).json();
    expect(list.map((s: { id: string }) => s.id)).toEqual(["old"]);
    const detail = await app.inject({ url: "/api/admin/guest-spaces/new", headers: ADMIN });
    expect(detail.json().clips).toEqual([]);
  });
});

describe("POST /api/admin/guest-spaces/:id/code", () => {
  it("gives the space a new code", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/guest-spaces/new/code", headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const { code } = res.json();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(code).not.toBe("CODENEW");
    expect(index().find((s) => s.id === "new")!.code).toBe(code);
  });

  it("404s an unknown space", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/guest-spaces/nope/code", headers: ADMIN });
    expect(res.statusCode).toBe(404);
  });
});
