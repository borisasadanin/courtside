/**
 * The sponsors over HTTP (#121, phase 0): their logos (#128), the admin's
 * routes (#129) and what viewers get for a match (#130).
 *
 * What matters: a logo is always a PNG of at most 512 px and never SVG;
 * every admin route wants the admin PIN; v0.8's upload call still works; and
 * a viewer never sees more than the sponsors of the match in front of them.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { initServices, matches, sponsors, sponsorQueue, streamMeta, teams } from "../state.js";
import { createAdminToken, createViewerToken } from "../auth.js";
import { defaultHomeTeam } from "../club-config.js";
import { SPONSORS_KEY, originalKey, sponsorLogoKey } from "../sponsors.js";
import sponsorRoutes from "../routes/sponsor-routes.js";
import { SURFACES } from "../sponsor-surfaces.js";
import { V081_FILE, memoryStorage } from "./sponsor-fakes.js";

vi.mock("@osaas/client-core", () => ({
  Context: class MockContext {},
  getInstance: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(),
}));
vi.mock("../stream-meta-store.js", () => ({ saveStreamMetaSoon: vi.fn() }));

const require = createRequire(import.meta.url);
const ffmpeg: string = require("ffmpeg-static");

/** A picture made by ffmpeg, as a data URL. */
async function picture(width: number, height: number, ext = "png"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sponsor-logo-test-"));
  try {
    const out = join(dir, `pic.${ext}`);
    await promisify(execFile)(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=red:s=${width}x${height}`, "-frames:v", "1", out]);
    const type = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return `data:${type};base64,${(await readFile(out)).toString("base64")}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Width and height from a PNG's header. */
function pngSize(bytes: Buffer): [number, number] {
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function fakeTranscode() {
  return async () => ({
    durationSeconds: 10,
    files: [
      { name: "seg_00000.ts", body: Buffer.from("a"), contentType: "video/mp2t" },
      { name: "index.m3u8", body: Buffer.from("#EXTM3U\n#EXTINF:10.0,\nseg_00000.ts\n#EXT-X-ENDLIST\n"), contentType: "application/vnd.apple.mpegurl" },
    ],
  });
}

describe("sponsorship routes", () => {
  let app: FastifyInstance;
  let storage: ReturnType<typeof memoryStorage>;
  const admin = () => ({ "x-admin-token": createAdminToken() });
  const viewer = () => ({ authorization: `Bearer ${createViewerToken()}` });

  beforeEach(async () => {
    storage = memoryStorage();
    initServices({} as never, storage as never, {} as never);
    (sponsorQueue as unknown as { transcode: unknown }).transcode = fakeTranscode();
    app = Fastify();
    await app.register(sponsorRoutes);
  });

  afterAll(async () => {
    await app?.close();
  });

  const inject = (method: string, url: string, payload?: unknown, headers: Record<string, string> = admin()) =>
    app.inject({ method: method as "GET", url, headers, ...(payload !== undefined && { payload: payload as object }) });

  /** A clip uploaded through the routes and transcoded, ready to play. */
  async function readyClip(name: string, sponsorId?: string, slots = ["start"]) {
    const res = await inject("POST", "/api/admin/sponsors/uploads", { name, sizeBytes: 4, contentType: "video/mp4", ...(sponsorId && { sponsorId }) });
    expect(res.statusCode).toBe(201);
    const { clip } = res.json();
    storage.files.set(originalKey(clip.id), { body: "film", type: "video/mp4" });
    await inject("POST", `/api/admin/sponsors/${clip.id}/uploaded`);
    await sponsorQueue.idle();
    await inject("PATCH", `/api/admin/sponsors/${clip.id}`, { slots });
    return clip as { id: string; sponsorId: string };
  }

  // --- #129 ---

  describe("admin (#129)", () => {
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/admin/sponsorship"],
      ["POST", "/api/admin/sponsorship/sponsors", { name: "X" }],
      ["PUT", "/api/admin/sponsorship/sponsors/order", { ids: [] }],
      ["PATCH", "/api/admin/sponsorship/sponsors/aaaaaaaaaaaa", { name: "X" }],
      ["DELETE", "/api/admin/sponsorship/sponsors/aaaaaaaaaaaa"],
      ["PUT", "/api/admin/sponsorship/sponsors/aaaaaaaaaaaa/logo", { dataUrl: "x" }],
      ["DELETE", "/api/admin/sponsorship/sponsors/aaaaaaaaaaaa/logo"],
      ["PATCH", "/api/admin/sponsorship/surfaces", { p1: false }],
      ["PATCH", "/api/admin/sponsorship/season", { seasonStart: "2026-08-01" }],
    ];

    it.each(routes)("%s %s wants the admin PIN", async (method, url, payload) => {
      expect((await inject(method, url, payload, {})).statusCode).toBe(401);
      expect((await inject(method, url, payload, viewer())).statusCode).toBe(401);
      expect((await inject(method, url, payload)).statusCode).not.toBe(401);
    });

    it("shows sponsors, packages, the released surfaces, clips and the season start", async () => {
      storage.files.set(SPONSORS_KEY, { body: V081_FILE, type: "application/json" });
      const body = (await inject("GET", "/api/admin/sponsorship")).json();
      expect(body.sponsors.map((x: { name: string }) => x.name)).toEqual(["ICA Maxi", "Bilfirman", "Pizzerian"]);
      expect(body.sponsors[0]).toMatchObject({ packageId: "gold", teamIds: [], off: [], active: true, clipCount: 1 });
      expect(body.packages.map((p: { name: string }) => p.name)).toEqual(["Platinum", "Guld", "Silver"]);
      expect(body.surfaces.find((x: { id: string }) => x.id === "corner")).toMatchObject({ label: "Hörnlogga", available: false, on: false, exclusive: true });
      expect(body.surfaces.find((x: { id: string }) => x.id === "start")).toMatchObject({ available: true, on: true });
      expect(body.clips).toHaveLength(3);
      expect(body.seasonStart).toBeNull();
      expect(body.breakSeconds.p2).toBe(600);
    });

    it("creates, changes, orders and removes sponsors", async () => {
      const a = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "ICA", url: "https://ica.se" })).json().sponsor;
      expect(a).toMatchObject({ name: "ICA", url: "https://ica.se/", packageId: "gold", clipCount: 0 });
      const b = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "Coop", packageId: "silver" })).json().sponsor;

      const changed = await inject("PATCH", `/api/admin/sponsorship/sponsors/${a.id}`, { active: false, off: ["p1"] });
      expect(changed.json().sponsor).toMatchObject({ active: false, off: ["p1"] });
      expect((await inject("PATCH", `/api/admin/sponsorship/sponsors/${a.id}`, { url: "ftp://x" })).statusCode).toBe(400);

      const ordered = await inject("PUT", "/api/admin/sponsorship/sponsors/order", { ids: [b.id, a.id] });
      expect(ordered.json().sponsors.map((x: { id: string }) => x.id)).toEqual([b.id, a.id]);
      expect((await inject("PUT", "/api/admin/sponsorship/sponsors/order", { ids: [a.id] })).statusCode).toBe(409);

      expect((await inject("DELETE", `/api/admin/sponsorship/sponsors/${b.id}`)).statusCode).toBe(204);
      expect((await inject("DELETE", `/api/admin/sponsorship/sponsors/${b.id}`)).statusCode).toBe(404);
    });

    it("answers 409 to a second sponsor on an exclusive surface, and to removing a sponsor with clips", async () => {
      const corner = SURFACES.find((x) => x.id === "corner") as { available: boolean };
      corner.available = true; // as when phase 1 releases the corner logo
      await inject("POST", "/api/admin/sponsorship/sponsors", { name: "ICA", packageId: "platinum" });
      const second = await inject("POST", "/api/admin/sponsorship/sponsors", { name: "Coop", packageId: "platinum" });
      corner.available = false;
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("Klubben har redan huvudsponsor: ICA.");

      const clip = await readyClip("Reklam");
      const removing = await inject("DELETE", `/api/admin/sponsorship/sponsors/${clip.sponsorId}`);
      expect(removing.statusCode).toBe(409);
      expect(removing.json().error).toMatch(/har ett klipp/);
    });

    it("takes v0.8's upload call without a sponsor, and gives the clip one named after it", async () => {
      const clip = await readyClip("Bageriet");
      const body = (await inject("GET", "/api/admin/sponsorship")).json();
      expect(body.sponsors).toEqual([expect.objectContaining({ id: clip.sponsorId, name: "Bageriet", clipCount: 1 })]);
      // The v0.8 list still has the clips, now with their sponsor.
      expect((await inject("GET", "/api/admin/sponsors")).json().clips[0]).toMatchObject({ id: clip.id, sponsorId: clip.sponsorId, status: "ready" });
    });

    it("uploads a clip under a sponsor, and moves it to another", async () => {
      const a = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "A" })).json().sponsor;
      const b = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "B" })).json().sponsor;
      const clip = await readyClip("Film", a.id);
      expect(clip.sponsorId).toBe(a.id);
      const moved = await inject("PATCH", `/api/admin/sponsors/${clip.id}`, { sponsorId: b.id });
      expect(moved.json().clip.sponsorId).toBe(b.id);
      expect((await inject("PATCH", `/api/admin/sponsors/${clip.id}`, { sponsorId: "aaaaaaaaaaaa" })).statusCode).toBe(404);
      const unknown = await inject("POST", "/api/admin/sponsors/uploads", { name: "X", sizeBytes: 4, contentType: "video/mp4", sponsorId: "aaaaaaaaaaaa" });
      expect(unknown.statusCode).toBe(404);
    });

    it("switches surfaces and sets the season start", async () => {
      const res = await inject("PATCH", "/api/admin/sponsorship/surfaces", { p1: false });
      expect(res.json().surfaces.find((x: { id: string }) => x.id === "p1").on).toBe(false);
      expect((await inject("PATCH", "/api/admin/sponsorship/surfaces", { corner: true })).statusCode).toBe(400);
      expect((await inject("PATCH", "/api/admin/sponsorship/season", { seasonStart: "2026-08-01" })).json()).toEqual({ seasonStart: "2026-08-01" });
      expect((await inject("PATCH", "/api/admin/sponsorship/season", { seasonStart: "igår" })).statusCode).toBe(400);
    });
  });

  // --- #128 ---

  describe("logos (#128)", () => {
    it("stores a 2000 px PNG as a PNG of at most 512 px, served to anyone and cached hard", async () => {
      const x = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "ICA" })).json().sponsor;
      const put = await inject("PUT", `/api/admin/sponsorship/sponsors/${x.id}/logo`, { dataUrl: await picture(2000, 1000) });
      expect(put.statusCode).toBe(200);
      const { logoUrl } = put.json().sponsor;
      expect(logoUrl).toMatch(new RegExp(`^/api/sponsor-logos/${x.id}\\?v=`));

      const logo = await app.inject({ url: logoUrl });
      expect(logo.statusCode).toBe(200);
      expect(logo.headers["content-type"]).toBe("image/png");
      expect(logo.headers["cache-control"]).toContain("immutable");
      expect(pngSize(logo.rawPayload)).toEqual([512, 256]);
      expect(storage.files.has(sponsorLogoKey(x.id))).toBe(true);
    }, 20_000);

    it("keeps a small logo's size and takes JPEG and WebP", async () => {
      const x = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "ICA" })).json().sponsor;
      const small = await inject("PUT", `/api/admin/sponsorship/sponsors/${x.id}/logo`, { dataUrl: await picture(200, 100, "jpg") });
      expect(small.statusCode).toBe(200);
      expect(pngSize((await app.inject({ url: small.json().sponsor.logoUrl })).rawPayload)).toEqual([200, 100]);
      const webp = await inject("PUT", `/api/admin/sponsorship/sponsors/${x.id}/logo`, { dataUrl: await picture(64, 64, "webp") });
      expect(webp.statusCode).toBe(200);
    }, 20_000);

    it("refuses SVG, GIF, files over 1 MB and a file that is no picture", async () => {
      const x = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "ICA" })).json().sponsor;
      const put = (dataUrl: string) => inject("PUT", `/api/admin/sponsorship/sponsors/${x.id}/logo`, { dataUrl });
      const svg = `data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")}`;
      expect((await put(svg)).statusCode).toBe(400);
      expect((await put(svg)).json().error).toMatch(/PNG, JPG eller WebP/);
      expect((await put(await picture(32, 32, "gif"))).statusCode).toBe(400);
      const big = `data:image/png;base64,${Buffer.alloc(1024 * 1024 + 1, 1).toString("base64")}`;
      expect((await put(big)).json().error).toMatch(/1 MB/);
      const fake = `data:image/png;base64,${Buffer.from("not a picture").toString("base64")}`;
      expect((await put(fake)).statusCode).toBe(400);
      expect((await inject("GET", "/api/admin/sponsorship")).json().sponsors[0].logoUrl).toBeUndefined();
    }, 20_000);

    it("gives a new logo a new address, removes it, and removes it with the sponsor", async () => {
      const x = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "ICA" })).json().sponsor;
      const url = `/api/admin/sponsorship/sponsors/${x.id}/logo`;
      const one = (await inject("PUT", url, { dataUrl: await picture(64, 64) })).json().sponsor.logoUrl;
      const two = (await inject("PUT", url, { dataUrl: await picture(64, 32) })).json().sponsor.logoUrl;
      expect(two).not.toBe(one);

      const removed = await inject("DELETE", url);
      expect(removed.json().sponsor.logoUrl).toBeUndefined();
      expect((await app.inject({ url: two })).statusCode).toBe(404);

      await inject("PUT", url, { dataUrl: await picture(64, 64) });
      await inject("DELETE", `/api/admin/sponsorship/sponsors/${x.id}`);
      expect(storage.files.has(sponsorLogoKey(x.id))).toBe(false);
    }, 20_000);

    it("keeps the logo when a clip with the same id is removed", async () => {
      // A sponsor made for a bare upload has the clip's id.
      const clip = await readyClip("Bageriet");
      expect(clip.sponsorId).toBe(clip.id);
      const logoUrl = (await inject("PUT", `/api/admin/sponsorship/sponsors/${clip.id}/logo`, { dataUrl: await picture(64, 64) })).json().sponsor.logoUrl;
      expect((await inject("DELETE", `/api/admin/sponsors/${clip.id}`)).statusCode).toBe(204);
      expect([...storage.files.keys()].some((k) => k.startsWith(`sponsors/${clip.id}/`))).toBe(false);
      expect((await app.inject({ url: logoUrl })).statusCode).toBe(200);
    }, 20_000);
  });

  // --- #130 ---

  describe("viewers (#130)", () => {
    let p12: string;
    let f14: string;

    beforeEach(async () => {
      p12 = (await teams.create({ name: "Älta P12", own: true })).id;
      f14 = (await teams.create({ name: "Älta F14", own: true })).id;
    });

    it("wants the viewer PIN", async () => {
      expect((await app.inject({ url: "/api/sponsors" })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/sponsors", headers: viewer() })).statusCode).toBe(200);
    });

    it("gives a P12 match P12's and the club's sponsors, not F14's, and never the registry", async () => {
      const club = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "Klubbens", url: "https://klubb.se" })).json().sponsor;
      const own = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "P12:s", teamIds: [p12] })).json().sponsor;
      const other = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "F14:s", teamIds: [f14] })).json().sponsor;
      const off = (await inject("POST", "/api/admin/sponsorship/sponsors", { name: "Avstängd", active: false })).json().sponsor;
      const clubClip = await readyClip("K", club.id);
      await readyClip("P", own.id);
      await readyClip("F", other.id);
      await readyClip("A", off.id);

      const match = await matches.create({ date: "2026-12-01", ownTeamId: p12, opponentName: "AIK" });
      const res = await app.inject({ url: `/api/sponsors?match=${match.id}`, headers: viewer() });
      const body = res.json();
      expect(Object.keys(body)).toEqual(["teamName", "surfaces"]);
      expect(body.teamName).toBe("Älta P12");
      // Only surfaces that are on and have someone to show.
      expect(Object.keys(body.surfaces)).toEqual(["start"]);
      expect(body.surfaces.start.map((x: { name: string }) => x.name)).toEqual(["P12:s", "Klubbens"]);
      expect(body.surfaces.start[1]).toEqual({
        id: club.id, name: "Klubbens", url: "https://klubb.se/",
        clips: [{ id: clubClip.id, durationSec: 10, hlsUrl: `/api/sponsors/${clubClip.id}/index.m3u8` }],
      });
      for (const word of ["packageId", "teamIds", "\"off\"", "active", "F14:s", "Avstängd", "packages", "slots", "status"]) {
        expect(res.body).not.toContain(word);
      }

      // The same for a stream of the match, and for a stream that only names the team.
      streamMeta.set("s1", { matchId: match.id, homeTeam: "Älta P12" } as never);
      streamMeta.set("s2", { homeTeam: "Älta F14" } as never);
      const s1 = (await app.inject({ url: "/api/sponsors?stream=s1", headers: viewer() })).json();
      expect(s1.surfaces.start.map((x: { name: string }) => x.name)).toEqual(["P12:s", "Klubbens"]);
      const s2 = (await app.inject({ url: "/api/sponsors?stream=s2", headers: viewer() })).json();
      expect(s2.surfaces.start.map((x: { name: string }) => x.name)).toEqual(["F14:s", "Klubbens"]);
      // A replay.
      storage.vods.push({ id: "v1", matchId: match.id, homeTeam: "Älta P12" });
      const v1 = (await app.inject({ url: "/api/sponsors/play?surface=start&vod=v1", headers: viewer() })).json();
      expect(v1.clips.map((c: { name: string }) => c.name)).toEqual(["P12:s", "Klubbens"]);
      // Nothing known: only the club's.
      const none = (await app.inject({ url: "/api/sponsors/play?surface=start", headers: viewer() })).json();
      expect(none).toMatchObject({ teamName: defaultHomeTeam, clips: [{ name: "Klubbens" }] });
      streamMeta.delete("s1");
      streamMeta.delete("s2");
    });

    it("leaves out surfaces switched off", async () => {
      await readyClip("K", undefined, ["start", "end"]);
      await inject("PATCH", "/api/admin/sponsorship/surfaces", { start: false });
      const body = (await app.inject({ url: "/api/sponsors", headers: viewer() })).json();
      expect(Object.keys(body.surfaces)).toEqual(["end"]);
      expect((await app.inject({ url: "/api/sponsors/play?surface=start", headers: viewer() })).json().clips).toEqual([]);
    });

    it("plays the same clips as v0.8.1 after the migration, with the sponsor's name in the banner", async () => {
      storage.files.set(SPONSORS_KEY, { body: V081_FILE, type: "application/json" });
      const original = JSON.parse(V081_FILE).clips as { id: string; name: string; status: string; slots: string[]; durationSeconds?: number }[];
      for (const surface of ["start", "p1", "p2", "p3", "ot", "end"]) {
        const v081 = original.filter((c) => c.status === "ready" && c.slots.includes(surface))
          .map((c) => ({ id: c.id, sponsorId: c.id, name: c.name, durationSec: c.durationSeconds, hlsUrl: `/api/sponsors/${c.id}/index.m3u8` }));
        const res = (await app.inject({ url: `/api/sponsors/play?surface=${surface}`, headers: viewer() })).json();
        expect(res).toEqual({ surface, teamName: defaultHomeTeam, clips: v081 });
      }

      // Renaming the sponsor renames the banner, not the clip.
      const first = original[0].id;
      await inject("PATCH", `/api/admin/sponsorship/sponsors/${first}`, { name: "ICA Maxi Stormarknad" });
      const res = (await app.inject({ url: "/api/sponsors/play?surface=start", headers: viewer() })).json();
      expect(res.clips[0]).toMatchObject({ id: first, name: "ICA Maxi Stormarknad" });
    });
  });
});
