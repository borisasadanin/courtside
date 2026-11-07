/**
 * Guest access (#51, #54).
 *
 * The opponent's coach logs in with the guest space's code and must reach that
 * space's clips and nothing else: none of the club's matches, recordings, live
 * streams, clips or admin.  The club's viewer and admin sessions, for their
 * part, open nothing under /api/guest/*.  Shared guest clips are neutral.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { initServices, guestSpaces } from "../state.js";
import { GUEST_INDEX_KEY, GUEST_RETENTION_MS, type GuestSpace } from "../guest-spaces.js";
import { createAdminToken, createViewerToken, createGuestToken } from "../auth.js";
import { crc32 } from "../zip.js";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function clip(id: string, msAgo: number) {
  return {
    id,
    mp4Url: `/api/guest/clips/${id}/media/${id}.mp4`,
    thumbnailUrl: `/api/guest/clips/${id}/media/${id}.jpg`,
    durationSeconds: 8,
    createdAt: iso(msAgo),
  };
}

function spaces(): GuestSpace[] {
  return [
    {
      id: "spaceaaaa",
      code: "ABCD2345",
      streamIds: ["streamA"],
      homeTeam: "Klubben U15",
      awayTeam: "Gästerna BK",
      venue: "Testhallen",
      matchDate: iso(3 * 3600_000),
      endedAt: iso(3600_000),
      result: { home: 50, away: 48 },
      createdAt: iso(3 * 3600_000),
      clips: [clip("guestclip0001", 2 * 3600_000), clip("guestclip0002", 1.5 * 3600_000)],
    },
    {
      id: "spacebbbb",
      code: "WXYZ6789",
      streamIds: ["streamB"],
      homeTeam: "Klubben U17",
      awayTeam: "Andra IF",
      matchDate: iso(4 * 3600_000),
      endedAt: iso(3600_000),
      createdAt: iso(4 * 3600_000),
      clips: [clip("guestclip0003", 2 * 3600_000)],
    },
    {
      // Past its 14 days, not yet deleted.
      id: "spacecccc",
      code: "OLDC0DE7",
      streamIds: ["streamC"],
      homeTeam: "Klubben",
      awayTeam: "Förr IF",
      matchDate: iso(GUEST_RETENTION_MS + 5 * 3600_000),
      endedAt: iso(GUEST_RETENTION_MS + 3600_000),
      createdAt: iso(GUEST_RETENTION_MS + 5 * 3600_000),
      clips: [clip("guestclip0004", GUEST_RETENTION_MS + 2 * 3600_000)],
    },
  ];
}

const OWN_CLIP = {
  id: "ownclip0001",
  streamId: "streamA",
  hlsUrl: "/api/clips/ownclip0001/playlist.m3u8",
  durationSeconds: 8,
  createdAt: iso(3600_000),
};

let store: Map<string, string>;

function mockMinio() {
  return {
    readFileIfExists: vi.fn(async (key: string) => store.get(key) ?? null),
    uploadBuffer: vi.fn(async (key: string, body: Buffer | string) => { store.set(key, String(body)); }),
    deletePrefix: vi.fn(async () => 0),
    readClipsIndex: vi.fn(async () => [OWN_CLIP]),
    readVodIndex: vi.fn(async () => [
      { id: "streamA", matchTitle: "Klubben U15 – Gästerna BK", result: { home: 52, away: 48, setBy: "admin", setAt: iso(0) } },
    ]),
    readFile: vi.fn(async () => null),
    presignGet: vi.fn(async (key: string) => `https://storage.example.com/${key}?sig=abc`),
    downloadBuffer: vi.fn(async (key: string) => Buffer.from(`mp4 bytes of ${key}`)),
    clipManifestKey: (s: string, c: string) => `clips/${s}/${c}.m3u8`,
    clipMp4Key: (s: string, c: string) => `clips/${s}/${c}.mp4`,
    clipThumbnailKey: (s: string, c: string) => `clips/${s}/${c}.jpg`,
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(rateLimit, { global: false, max: 1000 });
  initServices({} as never, mockMinio() as never, { getState: () => "stopped" } as never);
  for (const mod of [
    "../routes/guest-routes.js",
    "../routes/clip-routes.js",
    "../routes/media.js",
    "../routes/vod.js",
    "../routes/streams.js",
    "../routes/admin.js",
    "../routes/match-routes.js",
  ]) {
    await app.register((await import(mod)).default);
  }
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  store = new Map([[GUEST_INDEX_KEY, JSON.stringify(spaces())]]);
});

// Login is limited per address, so each test login comes from an address of its own.
let addressCount = 0;
async function login(code: string, remoteAddress = `10.0.${Math.floor(++addressCount / 250)}.${addressCount % 250}`) {
  return app.inject({ method: "POST", url: "/api/guest/login", payload: { code }, remoteAddress });
}

async function tokenFor(code: string): Promise<string> {
  const res = await login(code);
  expect(res.statusCode).toBe(200);
  return res.json().token;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("POST /api/guest/login", () => {
  it("gives a token and the space for the right code, typed loosely", async () => {
    const res = await login("abcd-2345");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toMatch(/^guest\.spaceaaaa\./);
    expect(body.space.awayTeam).toBe("Gästerna BK");
    // The code itself is never sent back.
    expect(JSON.stringify(body)).not.toContain("ABCD2345");
  });

  it("turns a wrong code away", async () => {
    const res = await login("NOPE2345");
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("Koden fungerar inte, eller så har klippen tagits bort.");
  });

  it("answers a deleted space's code exactly like a wrong one", async () => {
    const wrong = await login("NOPE2345");
    const expired = await login("OLDC0DE7");
    expect(expired.statusCode).toBe(401);
    expect(expired.body).toBe(wrong.body);
  });

  it("limits login attempts per address", async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await login("NOPE2345", "192.0.2.1")).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("does not let a session outlive the space", async () => {
    const res = await login("ABCD2345");
    const deleteAfter = new Date(res.json().space.deleteAfter).getTime();
    expect(new Date(res.json().expiresAt).getTime()).toBeLessThanOrEqual(deleteAfter);
  });
});

describe("GET /api/guest/space", () => {
  it("shows the match, the current result, the deletion date and the clips newest first", async () => {
    const res = await app.inject({ url: "/api/guest/space", headers: bearer(await tokenFor("ABCD2345")) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.homeTeam).toBe("Klubben U15");
    expect(body.venue).toBe("Testhallen");
    // The recording's result wins over the space's copy: admin may have corrected it.
    expect(body.result).toEqual({ home: 52, away: 48 });
    expect(new Date(body.deleteAfter).getTime()).toBe(now - 3600_000 + GUEST_RETENTION_MS);
    expect(body.clips.map((c: { id: string }) => c.id)).toEqual(["guestclip0002", "guestclip0001"]);
    expect(body.product.name).toBeTruthy();
    expect(body.privacy.controller).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("ABCD2345");
  });

  it("falls back to the space's own result when the recording has none", async () => {
    const res = await app.inject({ url: "/api/guest/space", headers: bearer(await tokenFor("WXYZ6789")) });
    expect(res.json().result).toBeNull();
  });

  it("refuses a request without a guest token", async () => {
    expect((await app.inject({ url: "/api/guest/space" })).statusCode).toBe(401);
  });

  it("refuses the club's viewer and admin tokens and the API key", async () => {
    for (const headers of [
      bearer(createViewerToken()),
      bearer(createAdminToken()),
      { "x-admin-token": createAdminToken() },
      { "x-api-key": "test-api-key" },
    ]) {
      expect((await app.inject({ url: "/api/guest/space", headers })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/guest/clips.zip", headers })).statusCode).toBe(401);
    }
  });

  it("keeps space A's token to space A", async () => {
    const tokenA = await tokenFor("ABCD2345");
    const res = await app.inject({ url: "/api/guest/space", headers: bearer(tokenA) });
    expect(res.json().clips.map((c: { id: string }) => c.id)).not.toContain("guestclip0003");

    // Pointing A's token at B breaks its signature.
    const forged = tokenA.replace("guest.spaceaaaa.", "guest.spacebbbb.");
    expect((await app.inject({ url: "/api/guest/space", headers: bearer(forged) })).statusCode).toBe(401);
  });

  it("ends old sessions when the space gets a new code", async () => {
    const token = await tokenFor("ABCD2345");
    await guestSpaces.newCode("spaceaaaa");
    expect((await app.inject({ url: "/api/guest/space", headers: bearer(token) })).statusCode).toBe(401);
    expect((await login("ABCD2345")).statusCode).toBe(401);
  });

  it("ends sessions once the space is past its 14 days", async () => {
    const expired = spaces()[2];
    const { token } = createGuestToken({ ...expired, endedAt: new Date().toISOString() });
    expect((await app.inject({ url: "/api/guest/space", headers: bearer(token) })).statusCode).toBe(401);
  });
});

describe("a guest token outside /api/guest", () => {
  const routes: [string, string][] = [
    ["GET", "/api/clips"],
    ["GET", "/api/clips/ownclip0001"],
    ["GET", "/api/streams"],
    ["GET", "/api/streams/streamA/clips"],
    ["GET", "/api/vod"],
    ["GET", "/api/vod/streamA"],
    ["GET", "/api/media/streamA/p1_seg1.ts"],
    ["GET", "/api/matches"],
    ["GET", "/api/admin/storage"],
    ["GET", "/api/admin/deletions"],
    ["POST", "/api/admin/matches"],
  ];

  it.each(routes)("gets 401 on %s %s", async (method, url) => {
    const token = await tokenFor("ABCD2345");
    for (const headers of [bearer(token), { "x-admin-token": token }]) {
      const res = await app.inject({ method: method as "GET", url, headers, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("GET /api/guest/clips.zip", () => {
  /** Names and contents from a stored-only zip, checked against the CRCs. */
  function readZip(zip: Buffer): { name: string; data: string }[] {
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(end).toBeGreaterThan(0);
    const count = zip.readUInt16LE(end + 10);
    let p = zip.readUInt32LE(end + 16);
    const files = [];
    for (let i = 0; i < count; i++) {
      expect(zip.readUInt32LE(p)).toBe(0x02014b50);
      const crc = zip.readUInt32LE(p + 16);
      const size = zip.readUInt32LE(p + 20);
      const nameLen = zip.readUInt16LE(p + 28);
      const local = zip.readUInt32LE(p + 42);
      const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      expect(zip.readUInt32LE(local)).toBe(0x04034b50);
      const start = local + 30 + zip.readUInt16LE(local + 26);
      const data = zip.subarray(start, start + size);
      expect(crc32(data)).toBe(crc);
      files.push({ name, data: data.toString() });
      p += 46 + nameLen;
    }
    return files;
  }

  it("holds every clip of the space and nothing else", async () => {
    const token = await tokenFor("ABCD2345");
    const res = await app.inject({ url: "/api/guest/clips.zip", headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-disposition"]).toContain("attachment");
    const files = readZip(res.rawPayload);
    expect(files.map((f) => f.data)).toEqual([
      "mp4 bytes of guest/spaceaaaa/guestclip0001.mp4",
      "mp4 bytes of guest/spaceaaaa/guestclip0002.mp4",
    ]);
    for (const f of files) expect(f.name).toMatch(/^Klubben U15 - Gästerna BK \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.mp4$/);
  });

  it("takes the token as ?token= for a plain download link", async () => {
    const token = await tokenFor("ABCD2345");
    const res = await app.inject({ url: `/api/guest/clips.zip?token=${encodeURIComponent(token)}` });
    expect(res.statusCode).toBe(200);
    expect(readZip(res.rawPayload)).toHaveLength(2);
  });

  it("does not take ?token= anywhere else", async () => {
    const token = await tokenFor("ABCD2345");
    const res = await app.inject({ url: `/api/guest/space?token=${encodeURIComponent(token)}` });
    expect(res.statusCode).toBe(401);
  });
});

describe("guest clip media", () => {
  it("redirects to the clip's MP4 and thumbnail without a code", async () => {
    for (const ext of ["mp4", "jpg"]) {
      const res = await app.inject({ url: `/api/guest/clips/guestclip0001/media/guestclip0001.${ext}` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain(`guest/spaceaaaa/guestclip0001.${ext}`);
    }
  });

  it("serves no other file through a clip", async () => {
    for (const file of ["guestclip0002.mp4", "p1_seg1.ts", "..%2Fguest-spaces.json"]) {
      const res = await app.inject({ url: `/api/guest/clips/guestclip0001/media/${file}` });
      expect(res.statusCode).toBe(403);
    }
  });

  it("stops serving a clip once its space is past its 14 days", async () => {
    const res = await app.inject({ url: "/api/guest/clips/guestclip0004/media/guestclip0004.mp4" });
    expect(res.statusCode).toBe(404);
  });
});

describe("sharing a guest clip", () => {
  it("describes the clip with the match and the product, without the club", async () => {
    const res = await app.inject({ url: "/api/guest/clips/guestclip0001/public" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.awayTeam).toBe("Gästerna BK");
    expect(body.product.url).toMatch(/^https?:\/\//);
    expect(JSON.stringify(body)).not.toContain(process.env.CLUB_NAME);
    expect(body).not.toHaveProperty("code");
  });

  it("gives a crawler a neutral preview with the clip's thumbnail", async () => {
    const res = await app.inject({
      url: "/g/guestclip0001",
      headers: { host: "club.apps.osaas.io", "x-forwarded-proto": "https", "user-agent": "WhatsApp/2.23" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      'og:image" content="https://club.apps.osaas.io/api/guest/clips/guestclip0001/media/guestclip0001.jpg',
    );
    expect(res.body).toContain("Gästerna BK");
    expect(res.body).not.toContain(process.env.CLUB_NAME);
    expect(res.body).not.toContain("logo");
    expect(res.body).not.toContain("http-equiv=\"refresh\"");
  });

  it("sends a person on to the neutral clip page", async () => {
    const res = await app.inject({
      url: "/g/guestclip0001",
      headers: { host: "club.apps.osaas.io", "x-forwarded-proto": "https", "user-agent": "Mozilla/5.0 (iPhone)" },
    });
    expect(res.body).toContain("/guest-clip.html#guestclip0001");
    expect(res.body).not.toContain("/clip.html");
  });

  it("never resolves a guest clip in the club's own clip routes", async () => {
    for (const url of [
      "/api/clips/guestclip0001/public",
      "/api/clips/guestclip0001/og",
      "/c/guestclip0001",
      "/api/clips/guestclip0001/playlist.m3u8",
      "/api/clips/guestclip0001/media/guestclip0001.mp4",
      "/api/clips/guestclip0001/media/guestclip0001.jpg",
    ]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
  });

  it("never resolves the club's own clip in the guest routes", async () => {
    for (const url of [
      "/api/guest/clips/ownclip0001/public",
      "/g/ownclip0001",
      "/api/guest/clips/ownclip0001/media/ownclip0001.mp4",
    ]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
  });
});
