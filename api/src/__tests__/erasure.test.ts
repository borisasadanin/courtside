/**
 * Deleting recordings for good.
 *
 * A shared clip opens without the PIN, so a clip that outlives its deletion, or
 * its match's deletion, is a recording of someone's child still on the web.
 * These tests run the real routes against an in-memory bucket and check what a
 * stranger holding the old link gets afterwards.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { initServices, clipsByStream } from "../state.js";
import type { HighlightClip, VodEntry } from "../types.js";

const ADMIN = { "x-api-key": "test-api-key" };

function clip(id: string, streamId: string): HighlightClip {
  return {
    id,
    streamId,
    hlsUrl: `/api/clips/${id}/playlist.m3u8`,
    mp4Url: `/api/clips/${id}/media/${id}.mp4`,
    thumbnailUrl: `/api/clips/${id}/media/${id}.jpg`,
    durationSeconds: 8,
    createdAt: new Date().toISOString(),
  };
}

function vod(id: string): VodEntry {
  return {
    id,
    matchTitle: "Hemma vs Borta",
    location: "Hallen",
    homeTeam: "Hemma",
    awayTeam: "Borta",
    matchDate: "2026-10-30",
    cameraName: "Läktaren",
    hlsUrl: `/api/vod/${id}/playlist.m3u8`,
    createdAt: new Date().toISOString(),
    stoppedAt: new Date().toISOString(),
  };
}

/** Just enough of MinioClient, over a Map of keys. */
function fakeMinio() {
  const objects = new Map<string, string>();
  let vods: VodEntry[] = [];
  let clips: HighlightClip[] = [];
  const deletePrefix = async (prefix: string) => {
    let n = 0;
    for (const key of [...objects.keys()]) if (key.startsWith(prefix)) { objects.delete(key); n++; }
    return n;
  };
  return {
    objects,
    get vods() { return vods; },
    get clips() { return clips; },
    seed(v: VodEntry[], c: HighlightClip[]) {
      vods = v;
      clips = c;
      for (const entry of v) objects.set(`${entry.id}/p1_seg1.ts`, "ts");
      for (const k of c) {
        objects.set(`clips/${k.streamId}/${k.id}.m3u8`, "#EXTM3U\np1_seg1.ts\n#EXT-X-ENDLIST");
        objects.set(`clips/${k.streamId}/${k.id}.mp4`, "mp4");
        objects.set(`clips/${k.streamId}/${k.id}.jpg`, "jpg");
      }
    },
    readVodIndex: async () => vods,
    readClipsIndex: async () => clips,
    removeVodEntry: async (id: string) => {
      const before = vods.length;
      vods = vods.filter((v) => v.id !== id);
      return vods.length < before;
    },
    removeClipEntries: async (match: (c: HighlightClip) => boolean) => {
      const removed = clips.filter(match);
      clips = clips.filter((c) => !match(c));
      return removed;
    },
    deletePrefix,
    deleteVodFiles: (streamId: string) => deletePrefix(`${streamId}/`),
    readFile: async (key: string) => objects.get(key) ?? null,
    presignGet: async (key: string) => `https://storage.example.com/${key}?sig=x`,
    clipManifestKey: (s: string, c: string) => `clips/${s}/${c}.m3u8`,
    clipMp4Key: (s: string, c: string) => `clips/${s}/${c}.mp4`,
    clipThumbnailKey: (s: string, c: string) => `clips/${s}/${c}.jpg`,
    getStorageInfo: async () => ({ totalBytes: 0, vods: [] }),
  };
}

let app: FastifyInstance;
let minio: ReturnType<typeof fakeMinio>;

beforeEach(async () => {
  minio = fakeMinio();
  minio.seed([vod("match1"), vod("match2")], [clip("aaaa000000000001", "match1"), clip("aaaa000000000002", "match1"), clip("bbbb000000000001", "match2")]);
  clipsByStream.clear();
  clipsByStream.set("match1", [...minio.clips.filter((c) => c.streamId === "match1")]);
  initServices({} as never, minio as never, {} as never);

  app = Fastify();
  for (const mod of ["../routes/vod.js", "../routes/clip-routes.js", "../routes/media.js", "../routes/admin.js"]) {
    const { default: routes } = await import(mod);
    await app.register(routes);
  }
});

/** What a stranger holding the shared link sees. */
async function sharedLink(id: string) {
  const media = await app.inject({ url: `/api/clips/${id}/media/${id}.jpg` });
  const page = await app.inject({ url: `/c/${id}` });
  const manifest = await app.inject({ url: `/api/clips/${id}/playlist.m3u8` });
  return [media.statusCode, page.statusCode, manifest.statusCode];
}

describe("deleting a match", () => {
  it("takes its clips with it, so their shared links stop working", async () => {
    expect(await sharedLink("aaaa000000000001")).toEqual([302, 200, 200]);

    const res = await app.inject({ method: "DELETE", url: "/api/vod/match1", headers: ADMIN });
    expect(res.statusCode).toBe(204);

    expect(await sharedLink("aaaa000000000001")).toEqual([404, 404, 404]);
    expect(await sharedLink("aaaa000000000002")).toEqual([404, 404, 404]);
    expect([...minio.objects.keys()].filter((k) => k.includes("match1"))).toEqual([]);
    expect(clipsByStream.has("match1")).toBe(false);
  });

  it("leaves other matches and their clips alone", async () => {
    await app.inject({ method: "DELETE", url: "/api/vod/match1", headers: ADMIN });
    expect(minio.vods.map((v) => v.id)).toEqual(["match2"]);
    expect(await sharedLink("bbbb000000000001")).toEqual([302, 200, 200]);
  });

  it("removes the clips of a match that is already gone from the index", async () => {
    minio.seed([vod("match2")], minio.clips);
    const res = await app.inject({ method: "DELETE", url: "/api/vod/match1", headers: ADMIN });
    expect(res.statusCode).toBe(204);
    expect(await sharedLink("aaaa000000000001")).toEqual([404, 404, 404]);
  });

  it("404s when there is nothing by that id", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/vod/nosuchmatch", headers: ADMIN });
    expect(res.statusCode).toBe(404);
  });
});

describe("deleting one clip", () => {
  it("ends its shared link and keeps the match", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/clips/aaaa000000000001", headers: ADMIN });
    expect(res.statusCode).toBe(204);

    expect(await sharedLink("aaaa000000000001")).toEqual([404, 404, 404]);
    expect(await sharedLink("aaaa000000000002")).toEqual([302, 200, 200]);
    expect(minio.objects.has("match1/p1_seg1.ts")).toBe(true);
    expect([...minio.objects.keys()].filter((k) => k.includes("aaaa000000000001"))).toEqual([]);
    expect(clipsByStream.get("match1")!.map((c) => c.id)).toEqual(["aaaa000000000002"]);
  });

  it("is for the admin only", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/clips/aaaa000000000001" });
    expect(res.statusCode).toBe(401);
    expect(await sharedLink("aaaa000000000001")).toEqual([302, 200, 200]);
  });

  it("404s an unknown clip", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/clips/ffff000000000000", headers: ADMIN });
    expect(res.statusCode).toBe(404);
  });
});

describe("the admin's storage view", () => {
  it("lists each match's clips, and clips whose match is gone", async () => {
    minio.seed([vod("match2")], minio.clips);
    const res = await app.inject({ url: "/api/admin/storage", headers: ADMIN });
    const body = res.json();
    expect(body.vods[0].clips.map((c: { id: string }) => c.id)).toEqual(["bbbb000000000001"]);
    expect(body.orphanClips.map((c: { id: string }) => c.id)).toEqual(["aaaa000000000001", "aaaa000000000002"]);
  });
});
