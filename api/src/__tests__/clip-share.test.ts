/**
 * Shared clip links.
 *
 * The share buttons hand out <site>/c/<clipId>.  The website is served from the
 * API's origin, so that path must be answered here: a 404 is what a WhatsApp
 * recipient sees otherwise.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { initServices } from "../state.js";

const CLIP = {
  id: "75d86aa9afa2fd7a",
  streamId: "stream01",
  label: "Trepoängare",
  mp4Url: "/api/clips/75d86aa9afa2fd7a/media/75d86aa9afa2fd7a.mp4",
  thumbnailUrl: "/api/clips/75d86aa9afa2fd7a/media/75d86aa9afa2fd7a.jpg",
  durationSeconds: 8,
  createdAt: new Date().toISOString(),
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  initServices({} as never, {
    readClipsIndex: vi.fn().mockResolvedValue([CLIP]),
    readVodIndex: vi.fn().mockResolvedValue([]),
  } as never, {} as never);
  const { default: clipRoutes } = await import("../routes/clip-routes.js");
  await app.register(clipRoutes);
});

describe("GET /c/:id", () => {
  it("gives a crawler the preview, with absolute media URLs", async () => {
    const res = await app.inject({
      url: `/c/${CLIP.id}`,
      headers: { host: "club.apps.osaas.io", "x-forwarded-proto": "https", "user-agent": "WhatsApp/2.23" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('og:title" content="Trepoängare');
    expect(res.body).toContain(`og:image" content="https://club.apps.osaas.io${CLIP.thumbnailUrl}`);
    // A preview, not a download: the MP4 is for viewers on the site.
    expect(res.body).not.toContain("og:video");
    expect(res.body).not.toContain(".mp4");
    expect(res.body).not.toContain("http-equiv=\"refresh\"");
  });

  it("sends a person on to the clip page", async () => {
    const res = await app.inject({
      url: `/c/${CLIP.id}`,
      headers: { host: "club.apps.osaas.io", "x-forwarded-proto": "https", "user-agent": "Mozilla/5.0 (iPhone)" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('http-equiv="refresh"');
    expect(res.body).toContain(`/clip.html#${CLIP.id}`);
  });

  it("answers the same as the OG route it stands in for", async () => {
    const headers = { host: "club.apps.osaas.io", "user-agent": "WhatsApp/2.23" };
    const short = await app.inject({ url: `/c/${CLIP.id}`, headers });
    const long = await app.inject({ url: `/api/clips/${CLIP.id}/og`, headers });
    expect(short.body).toBe(long.body);
  });

  it("404s an unknown clip as a page, not JSON", async () => {
    const res = await app.inject({ url: "/c/doesnotexist" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});

describe("GET /api/clips/:id/public", () => {
  it("describes the clip without its download", async () => {
    const res = await app.inject({ url: `/api/clips/${CLIP.id}/public` });
    expect(res.statusCode).toBe(200);
    expect(res.json().label).toBe("Trepoängare");
    expect(res.json()).not.toHaveProperty("mp4Url");
  });
});
