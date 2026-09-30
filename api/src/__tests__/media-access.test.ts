/**
 * Media access rules.
 *
 * The bucket is private, so these routes are the only way to reach recorded
 * video. What they refuse matters more than what they allow, and the two gates
 * differ on purpose: match footage sits behind the viewer PIN, while a shared
 * clip is reachable without one but only exposes its own files.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { isSafeKey, keysReferencedBy } from "../routes/media.js";
import { rewriteSegmentUris } from "../playlist-rewrite.js";
import { initServices } from "../state.js";
import { config } from "../config.js";

const CLIP = {
  id: "a1b2c3d4e5f60718",
  streamId: "stream01",
  hlsUrl: "/api/clips/a1b2c3d4e5f60718/playlist.m3u8",
  durationSeconds: 8,
  createdAt: new Date().toISOString(),
};

const CLIP_MANIFEST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXTINF:2.000000,",
  "p1_seg41.ts",
  "#EXTINF:2.000000,",
  "p1_seg42.ts",
  "#EXT-X-ENDLIST",
].join("\n");

function mockMinio() {
  return {
    readClipsIndex: vi.fn().mockResolvedValue([CLIP]),
    readFile: vi.fn().mockResolvedValue(CLIP_MANIFEST),
    presignGet: vi.fn(async (key: string) => `https://storage.example.com/${key}?sig=abc`),
    clipManifestKey: (s: string, c: string) => `clips/${s}/${c}.m3u8`,
    clipMp4Key: (s: string, c: string) => `clips/${s}/${c}.mp4`,
    clipThumbnailKey: (s: string, c: string) => `clips/${s}/${c}.jpg`,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  initServices({} as never, mockMinio() as never, {} as never);
  const { default: mediaRoutes } = await import("../routes/media.js");
  await app.register(mediaRoutes);
  return app;
}

describe("key validation", () => {
  it("accepts the shapes our own keys take", () => {
    expect(isSafeKey("stream01/p1_seg41.ts")).toBe(true);
    expect(isSafeKey("clips/stream01/a1b2.mp4")).toBe(true);
  });

  it("refuses traversal, absolute paths and odd characters", () => {
    for (const bad of [
      "../../etc/passwd",
      "/etc/passwd",
      "stream01//p1.ts",
      "stream01/..%2Fsecret",
      "stream01/seg.ts\\x",
      "",
    ]) {
      expect(isSafeKey(bad), bad).toBe(false);
    }
  });
});

describe("manifest parsing", () => {
  it("collects only segment URIs, never tags", () => {
    const keys = keysReferencedBy(CLIP_MANIFEST, "stream01/");
    expect([...keys].sort()).toEqual(["stream01/p1_seg41.ts", "stream01/p1_seg42.ts"]);
  });

  it("handles absolute URLs left by older manifests", () => {
    const old = "#EXTINF:2,\nhttps://storage.example.com/recordings/stream01/p1_seg41.ts\n";
    expect([...keysReferencedBy(old, "stream01/")]).toEqual(["stream01/p1_seg41.ts"]);
  });
});

describe("playlist rewriting", () => {
  it("redirects segments without disturbing tags", () => {
    const out = rewriteSegmentUris(CLIP_MANIFEST, (f) => `/api/media/stream01/${f}`);
    expect(out).toContain("/api/media/stream01/p1_seg41.ts");
    expect(out).toContain("#EXT-X-ENDLIST");
    expect(out).toContain("#EXTINF:2.000000,");
    expect(out).not.toContain("\np1_seg41.ts");
  });
});

describe("GET /api/media/*", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it("refuses match footage without a viewer token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/media/stream01/p1_seg41.ts" });
    expect(res.statusCode).toBe(401);
  });

  it("redirects to a presigned URL once authorised", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/media/stream01/p1_seg41.ts",
      headers: { "x-api-key": config.API_KEY },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("stream01/p1_seg41.ts");
    expect(res.headers.location).toContain("sig=");
  });

  it("rejects a traversal attempt even when authorised", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/media/stream01/..%2F..%2Fsecret",
      headers: { "x-api-key": config.API_KEY },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/clips/:id/media/:file", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it("serves a shared clip without a PIN — that is the point of a clip link", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/clips/${CLIP.id}/media/p1_seg41.ts`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("stream01/p1_seg41.ts");
  });

  it("serves the clip's own MP4 and thumbnail", async () => {
    for (const [file, expected] of [
      [`${CLIP.id}.mp4`, `clips/stream01/${CLIP.id}.mp4`],
      [`${CLIP.id}.jpg`, `clips/stream01/${CLIP.id}.jpg`],
    ]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/clips/${CLIP.id}/media/${file}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain(expected);
    }
  });

  it("does NOT open the rest of the match — the whole point of scoping a clip", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/clips/${CLIP.id}/media/p1_seg99.ts`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses another clip's files", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/clips/${CLIP.id}/media/deadbeefdeadbeef.mp4`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s for an unknown clip rather than leaking whether a key exists", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/clips/0000000000000000/media/p1_seg41.ts",
    });
    expect(res.statusCode).toBe(404);
  });
});
