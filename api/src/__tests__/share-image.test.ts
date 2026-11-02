/**
 * Share image per match (ABL-050).
 *
 * A match link's preview is fetched without the viewer code, so what these
 * routes give must be safe for anyone: a drawn picture and a few words, never
 * a recording. The picture's URL carries a version, so a chat app shows the
 * result once there is one instead of the picture it cached before.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initServices, matches, teams, streamMeta } from "../state.js";
import shareRoutes from "../routes/share-routes.js";
import { ShareImages, fitText, formatShareDate, shareTitle, type ShareDrawing } from "../share-image.js";
import type { Match } from "../matches.js";
import type { VodEntry } from "../types.js";

/** A real 1×1 PNG, so ffmpeg has a logo to read. */
const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const PAGE = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="description" content="">
  <meta property="og:title" content="">
  <meta property="og:description" content="">
  <meta property="og:image" content="/assets/icon-1a2b3c4d.png">
  <meta property="og:url" content="">
  <meta property="og:type" content="website">
  <title>Courtside</title>
  <script src="/runtime-config.js"></script>
</head>
<body><div id="app"></div></body>
</html>`;

/** The club's storage, binary-safe: logos go in and come out as bytes. */
function memoryStorage() {
  const files = new Map<string, Buffer>();
  const vods: VodEntry[] = [];
  return {
    files,
    vods,
    readFileIfExists: vi.fn(async (key: string) => files.get(key)?.toString() ?? null),
    uploadBuffer: vi.fn(async (key: string, body: Buffer | string) => { files.set(key, Buffer.from(body)); }),
    downloadBuffer: vi.fn(async (key: string) => {
      const file = files.get(key);
      if (!file) throw new Error(`No such key: ${key}`);
      return file;
    }),
    deleteObject: vi.fn(async (key: string) => { files.delete(key); }),
    readVodIndex: vi.fn(async () => vods.map((v) => ({ ...v }))),
    updateVodEntry: vi.fn(async () => true),
  };
}

function recording(id: string, matchId: string, fields: Partial<VodEntry> = {}): VodEntry {
  return {
    id,
    matchId,
    matchTitle: "P12 vs Hornets",
    location: "Testhallen",
    homeTeam: "P12",
    awayTeam: "Hornets",
    matchDate: "2026-11-01",
    cameraName: "Läktaren",
    hlsUrl: `/api/vod/${id}/playlist.m3u8`,
    createdAt: "2026-11-01T14:00:00.000Z",
    stoppedAt: "2026-11-01T15:30:00.000Z",
    ...fields,
  };
}

/** Width and height from a PNG's header. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const crawler = { host: "club.example.com", "x-forwarded-proto": "https", "user-agent": "WhatsApp/2.23" };

let webRoot: string;
let app: FastifyInstance;
let storage: ReturnType<typeof memoryStorage>;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "courtside-share-web-"));
  writeFileSync(join(webRoot, "index.html"), PAGE);
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  streamMeta.clear();
  storage = memoryStorage();
  initServices({} as never, storage as never, {} as never);
  app = Fastify();
  await app.register(shareRoutes, { branding: { logo: async () => null, logoVersion: () => null }, webRoot });
});

afterEach(async () => {
  await app.close();
});

async function newMatch(): Promise<Match> {
  const own = await teams.create({ name: "P12", own: true });
  const opponent = await teams.create({ name: "Hornets" });
  return matches.create({ date: "2026-11-01", ownTeamId: own.id, opponentId: opponent.id });
}

/** The og:image URL in a match page. */
async function imageUrl(id: string): Promise<string> {
  const res = await app.inject({ url: `/match/${id}`, headers: crawler });
  return /<meta property="og:image" content="([^"]+)">/.exec(res.body)![1];
}

describe("GET /match/:id", () => {
  it("is the website with the match's preview in place of the club's", async () => {
    const match = await newMatch();
    const res = await app.inject({ url: `/match/${match.id}`, headers: crawler });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('<meta property="og:title" content="P12 – Hornets">');
    expect(res.body).toContain('<meta property="og:description" content="Söndag 1 november 2026 · Testhallen · Test Courtside. Matchen sänds live.">');
    expect(res.body).toMatch(
      new RegExp(`<meta property="og:image" content="https://club\\.example\\.com/api/matches/${match.id}/share\\.png\\?v=[0-9a-f]{12}">`),
    );
    expect(res.body).toContain(`<meta property="og:url" content="https://club.example.com/match/${match.id}">`);
    expect(res.body).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(res.body).toContain('<meta property="og:image:width" content="1200">');
    expect(res.body).toContain("<title>P12 – Hornets — Test Courtside</title>");
    // The club's own tags are replaced, not left beside the match's.
    expect(res.body.match(/og:title/g)).toHaveLength(1);
    expect(res.body.match(/og:image"/g)).toHaveLength(1);
    expect(res.body.match(/<title>/g)).toHaveLength(1);
    // Still the website, which asks for the viewer code itself.
    expect(res.body).toContain('<div id="app"></div>');
    expect(res.body).toContain('<script src="/runtime-config.js"></script>');
  });

  it("shows the result once the match has one", async () => {
    const match = await newMatch();
    storage.vods.push(recording("rec1", match.id, { result: { home: 72, away: 65 } as VodEntry["result"] }));
    const res = await app.inject({ url: `/match/${match.id}`, headers: crawler });
    expect(res.body).toContain('og:title" content="P12 72 – 65 Hornets"');
    expect(res.body).toContain("Se reprisen.");
  });

  it("tells a planned match's time and venue", async () => {
    const own = await teams.create({ name: "P12", own: true });
    const opponent = await teams.create({ name: "Hornets" });
    const match = await matches.create({ date: "2026-11-08", time: "14:00", venue: "Sporthallen", ownTeamId: own.id, opponentId: opponent.id });
    const res = await app.inject({ url: `/match/${match.id}`, headers: crawler });
    expect(res.body).toContain('og:description" content="Söndag 8 november 2026 kl. 14:00 · Sporthallen · Test Courtside. Matchen sänds live."');
  });

  it("leaves the time out once the match is played", async () => {
    const own = await teams.create({ name: "P12", own: true });
    const opponent = await teams.create({ name: "Hornets" });
    const match = await matches.create({ date: "2026-11-01", time: "14:00", venue: "Sporthallen", ownTeamId: own.id, opponentId: opponent.id });
    storage.vods.push(recording("rec1", match.id, { result: { home: 72, away: 65 } as VodEntry["result"] }));
    const res = await app.inject({ url: `/match/${match.id}`, headers: crawler });
    expect(res.body).toContain('og:description" content="Söndag 1 november 2026 · Sporthallen · Test Courtside. Se reprisen."');
  });

  it("escapes team names", async () => {
    const own = await teams.create({ name: 'P12 "B" <script>', own: true });
    const opponent = await teams.create({ name: "Hornets & Co" });
    const match = await matches.create({ date: "2026-11-01", ownTeamId: own.id, opponentId: opponent.id });
    const res = await app.inject({ url: `/match/${match.id}`, headers: crawler });
    expect(res.body).not.toContain("<script>");
    expect(res.body).toContain("P12 &#34;B&#34; &#60;script&#62; – Hornets &#38; Co");
  });

  it("gives an unknown match the plain website, telling nothing", async () => {
    for (const id of ["nosuchid", "x%3Cscript%3E", "a".repeat(80)]) {
      const res = await app.inject({ url: `/match/${id}`, headers: crawler });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(PAGE);
    }
  });

  it("gives no recording away", async () => {
    const match = await newMatch();
    storage.vods.push(recording("rec7f3a", match.id, { result: { home: 50, away: 48 } as VodEntry["result"] }));
    const page = await app.inject({ url: `/match/${match.id}`, headers: crawler });
    expect(page.body).not.toContain("rec7f3a");
    expect(page.body).not.toMatch(/\/api\/(vod|media|clips)\//);
    expect(page.body).not.toMatch(/\.(m3u8|mp4|jpg)/);

    storage.downloadBuffer.mockClear();
    const image = await app.inject({ url: new URL(await imageUrl(match.id)).pathname });
    expect(image.statusCode).toBe(200);
    // Drawn from the registry and the club's logo only, never from a recording's files.
    for (const [key] of storage.downloadBuffer.mock.calls) expect(key).toMatch(/^config\//);
  });
});

describe("GET /api/matches/:id/share.png", () => {
  it("draws a match without logos and without a result", async () => {
    const match = await newMatch();
    const res = await app.inject({ url: `/api/matches/${match.id}/share.png` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(pngSize(res.rawPayload)).toEqual({ width: 1200, height: 630 });
  });

  it("draws the teams' logos and the result", async () => {
    const match = await newMatch();
    await teams.setLogo(match.ownTeam.id, LOGO);
    await teams.setLogo(match.opponent.id, LOGO);
    storage.vods.push(recording("rec1", match.id, { result: { home: 72, away: 65 } as VodEntry["result"] }));
    const res = await app.inject({ url: `/api/matches/${match.id}/share.png` });
    expect(res.statusCode).toBe(200);
    expect(pngSize(res.rawPayload)).toEqual({ width: 1200, height: 630 });
    expect(storage.downloadBuffer).toHaveBeenCalledWith(`config/teams/${match.opponent.id}`);
  });

  it("gets a new URL when the result or a logo changes", async () => {
    const match = await newMatch();
    const before = await imageUrl(match.id);
    expect(await imageUrl(match.id)).toBe(before);

    storage.vods.push(recording("rec1", match.id, { result: { home: 72, away: 65 } as VodEntry["result"] }));
    const withResult = await imageUrl(match.id);
    expect(withResult).not.toBe(before);

    await teams.setLogo(match.opponent.id, LOGO);
    expect(await imageUrl(match.id)).not.toBe(withResult);
  });

  it("is cached for good under its version, briefly under any other", async () => {
    const match = await newMatch();
    const current = new URL(await imageUrl(match.id));
    const versioned = await app.inject({ url: current.pathname + current.search });
    expect(versioned.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const stale = await app.inject({ url: `${current.pathname}?v=000000000000` });
    expect(stale.statusCode).toBe(200);
    expect(stale.headers["cache-control"]).toBe("public, max-age=300");
  });

  it("404s an unknown match", async () => {
    const res = await app.inject({ url: "/api/matches/nosuchid/share.png" });
    expect(res.statusCode).toBe(404);
  });
});

describe("ShareImages", () => {
  const match = {
    id: "m1",
    date: "2026-11-01",
    ownTeam: { id: "t1", name: "P12", shortName: "P12", color: "#2f6b3a", own: true, logoUrl: "/api/teams/t1/logo?v=1" },
    opponent: { id: "t2", name: "Hornets", shortName: "HOR", color: "#b45309", own: false },
    status: "ended",
    recordingIds: ["rec1"],
    result: { home: 72, away: 65 },
    source: "admin",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
  } as Match;

  function sources(clubLogo = false) {
    return {
      teamLogo: vi.fn(async () => ({ bytes: Buffer.from("logo"), type: "image/png" })),
      clubLogo: vi.fn(async () => (clubLogo ? { bytes: Buffer.from("club"), type: "image/png" } : null)),
      clubLogoVersion: () => (clubLogo ? "2026-10-01T00:00:00.000Z" : null),
      club: () => ({ name: "Test Courtside", accentColor: "#C8A43F" }),
    };
  }

  it("renders once per version", async () => {
    const render = vi.fn(async () => Buffer.from("png"));
    const images = new ShareImages(sources(), render);
    await Promise.all([images.image(match), images.image(match)]);
    await images.image(match);
    expect(render).toHaveBeenCalledTimes(1);

    await images.image({ ...match, result: { home: 74, away: 65 } });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("shows the club's logo for an own team without one", async () => {
    const render = vi.fn(async (_d: ShareDrawing) => Buffer.from("png"));
    const images = new ShareImages(sources(true), render);
    const noLogo = { ...match, ownTeam: { ...match.ownTeam, logoUrl: undefined } };
    await images.image(noLogo);
    expect(render.mock.calls[0][0].own.logo?.bytes.toString()).toBe("club");
    expect(render.mock.calls[0][0].opponent.logo).toBeUndefined();
    // A new club logo is a new picture.
    expect(images.version(noLogo)).not.toBe(new ShareImages(sources(false)).version(noLogo));
  });

  it("draws the time only before the match, and the venue always", async () => {
    const render = vi.fn(async (_d: ShareDrawing) => Buffer.from("png"));
    const images = new ShareImages(sources(), render);
    const planned = { ...match, status: "planned", result: undefined, time: "14:00", venue: "Sporthallen" } as Match;
    await images.image(planned);
    expect(render.mock.calls[0][0]).toMatchObject({ time: "14:00", venue: "Sporthallen" });

    await images.image({ ...planned, status: "ended" });
    expect(render.mock.calls[1][0].time).toBeUndefined();
    expect(render.mock.calls[1][0].venue).toBe("Sporthallen");
    // A moved match is a new picture.
    expect(images.version({ ...planned, venue: "Hallen" })).not.toBe(images.version(planned));
  });

  it("draws without logos when one cannot be read", async () => {
    const render = vi.fn(async (d: ShareDrawing) => {
      if (d.own.logo) throw new Error("ffmpeg could not read the logo");
      return Buffer.from("png");
    });
    const images = new ShareImages(sources(), render);
    expect((await images.image(match)).png.toString()).toBe("png");
    expect(render).toHaveBeenCalledTimes(2);
  });
});

describe("text", () => {
  it("writes the date and title in Swedish", () => {
    expect(formatShareDate("2026-11-07")).toBe("lördag 7 november 2026");
    expect(shareTitle({ ownTeam: { name: "P12" }, opponent: { name: "AIK" } } as Match)).toBe("P12 – AIK");
  });

  it("shrinks a long name, then cuts it", () => {
    expect(fitText("AIK", 360, 54, 34)).toEqual({ text: "AIK", size: 54 });
    const long = fitText("Solna Vikings Basketbollklubb Ungdom Flickor 2012", 360, 54, 34);
    expect(long.size).toBe(34);
    expect(long.text.endsWith("…")).toBe(true);
  });
});
