/**
 * Team registry (ABL-047).
 *
 * What matters: a team is one team however its name is typed, a team typed in
 * the camera app shows up without anyone adding it, and recordings made under
 * an old or duplicate name still find their team after a rename or a merge.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  TeamRegistry,
  TeamError,
  TEAMS_KEY,
  teamLogoKey,
  teamKey,
  deriveShortName,
  deriveColor,
} from "../teams.js";
import { initServices, teams, streamMeta } from "../state.js";
import { createAdminToken, createViewerToken } from "../auth.js";
import teamRoutes from "../routes/team-routes.js";
import streamRoutes from "../routes/streams.js";

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

/** Storage as the registry sees it, kept in a map. */
function memoryStorage() {
  const files = new Map<string, { body: Buffer | string; type: string }>();
  return {
    files,
    readFileIfExists: vi.fn(async (key: string) => {
      const f = files.get(key);
      return f ? f.body.toString() : null;
    }),
    uploadBuffer: vi.fn(async (key: string, body: Buffer | string, type: string) => {
      files.set(key, { body, type });
    }),
    downloadBuffer: vi.fn(async (key: string) => {
      const f = files.get(key);
      if (!f) throw new Error(`NoSuchKey ${key}`);
      return Buffer.from(f.body);
    }),
    deleteObject: vi.fn(async (key: string) => {
      files.delete(key);
    }),
  };
}

const PNG = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;

/** WCAG contrast of a #rrggbb colour against white. */
function contrastWithWhite(hex: string): number {
  const lum = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
  return 1.05 / (l + 0.05);
}

describe("team names", () => {
  it("are the same team whatever the case and spacing", () => {
    expect(teamKey("AIK")).toBe(teamKey("Aik"));
    expect(teamKey("aik ")).toBe(teamKey("AIK"));
    expect(teamKey("  Solna   Vikings ")).toBe(teamKey("solna vikings"));
    expect(teamKey("Älta IF")).toBe(teamKey("ÄLTA if"));
  });

  it("give a short name of three or four letters", () => {
    expect(deriveShortName("AIK")).toBe("AIK");
    expect(deriveShortName("KFUM Uppsala")).toBe("KFUM");
    expect(deriveShortName("P12")).toBe("P12");
    expect(deriveShortName("Älta IF")).toBe("ÄLTA");
    expect(deriveShortName("Täby Basket")).toBe("TÄBY");
    expect(deriveShortName("Solna Vikings")).toBe("SOL");
    expect(deriveShortName("Djurgårdens IF P12")).toBe("DJU");
    expect(deriveShortName("Stockholm Eagles Basket Club Norra")).toBe("SECN");
  });

  it("name the club's own teams by age group, which is what tells them apart", () => {
    expect(deriveShortName("Hornets P12", true)).toBe("P12");
    expect(deriveShortName("Älta IF F14", true)).toBe("F14");
    expect(deriveShortName("Hornets", true)).toBe("HOR");
    expect(deriveShortName("P12", true)).toBe("P12");
    // An opponent keeps its club's letters, so P12 does not meet P12.
    expect(deriveShortName("Hornets P12")).toBe("HOR");
  });

  it("give the same colour every time, readable with white initials", () => {
    for (const name of ["AIK", "Solna Vikings", "Älta IF", "P12", "Täby Basket", "Norrköping Dolphins", "x"]) {
      const colour = deriveColor(name);
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      expect(deriveColor(name.toUpperCase() + "  ")).toBe(colour);
      expect(contrastWithWhite(colour)).toBeGreaterThanOrEqual(4.5);
    }
    expect(deriveColor("AIK")).not.toBe(deriveColor("Solna Vikings"));
  });
});

describe("TeamRegistry", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let registry: TeamRegistry;

  beforeEach(() => {
    storage = memoryStorage();
    registry = new TeamRegistry(storage);
  });

  it("starts empty when nothing is stored", async () => {
    expect(await registry.list()).toEqual([]);
  });

  it("stores a team in the club's storage and fills in what was left out", async () => {
    const team = await registry.create({ name: "  Solna   Vikings " });
    expect(team.name).toBe("Solna Vikings");
    expect(team.shortName).toBe("SOL");
    expect(team.color).toBe(deriveColor("Solna Vikings"));
    expect(team.own).toBe(false);
    expect(team.logoUrl).toBeUndefined();

    const stored = JSON.parse(storage.files.get(TEAMS_KEY)!.body.toString());
    expect(stored.teams).toHaveLength(1);
    // Derived values are not stored, so they follow a rename.
    expect(stored.teams[0].shortName).toBeUndefined();
    expect(stored.teams[0].color).toBeUndefined();

    const reloaded = new TeamRegistry(storage);
    expect(await reloaded.get(team.id)).toEqual(team);
  });

  it("keeps a chosen short name and colour", async () => {
    const team = await registry.create({ name: "Galatasaray", shortName: "gala", color: "#A90432", own: false });
    expect(team.shortName).toBe("GALA");
    expect(team.color).toBe("#a90432");
  });

  it("refuses a bad short name or colour", async () => {
    await expect(registry.create({ name: "X", shortName: "TOOLONG" })).rejects.toThrow(/Kortnamnet/);
    await expect(registry.create({ name: "X", color: "red" })).rejects.toThrow(/#RRGGBB/);
    await expect(registry.create({ name: "   " })).rejects.toThrow(/Namnet/);
  });

  it("lists own teams first, then by name", async () => {
    await registry.create({ name: "Solna Vikings" });
    await registry.create({ name: "P12", own: true });
    await registry.create({ name: "AIK" });
    await registry.create({ name: "F14", own: true });
    expect((await registry.list()).map((t) => t.name)).toEqual(["F14", "P12", "AIK", "Solna Vikings"]);
  });

  it("finds a team by name whatever the case and spacing, and refuses a duplicate", async () => {
    const aik = await registry.create({ name: "AIK" });
    expect((await registry.findByName("aik "))?.id).toBe(aik.id);
    expect((await registry.findByName("Aik"))?.id).toBe(aik.id);
    expect(await registry.findByName("Hammarby")).toBeNull();

    const err = await registry.create({ name: "Aik" }).catch((e) => e);
    expect(err).toBeInstanceOf(TeamError);
    expect(err.status).toBe(409);
    expect(err.teamId).toBe(aik.id);
  });

  it("ensure finds a name longer than it stores", async () => {
    const long = "Idrottsföreningen med ett mycket långt namn som aldrig tar slut";
    const first = await registry.ensure(long);
    expect((await registry.ensure(long))?.id).toBe(first?.id);
    expect(await registry.list()).toHaveLength(1);
  });

  it("ensure creates an unknown team once, and only marks a new one as own", async () => {
    const first = await registry.ensure("Hammarby ", { own: false });
    const again = await registry.ensure("HAMMARBY");
    expect(again?.id).toBe(first?.id);
    expect(await registry.list()).toHaveLength(1);

    const p12 = await registry.ensure("P12", { own: true });
    expect(p12?.own).toBe(true);
    // An existing opponent is not turned into an own team by a camera.
    expect((await registry.ensure("Hammarby", { own: true }))?.own).toBe(false);

    expect(await registry.ensure("   ")).toBeNull();
  });

  it("two cameras naming the same new team at once make one team", async () => {
    await Promise.all([registry.ensure("AIK"), registry.ensure("aik"), registry.ensure("Aik ")]);
    expect(await registry.list()).toHaveLength(1);
  });

  it("a renamed team still answers to its old name", async () => {
    const team = await registry.create({ name: "Aik" });
    const renamed = await registry.update(team.id, { name: "AIK Basket" });
    expect(renamed.name).toBe("AIK Basket");
    expect(renamed.aliases).toEqual(["Aik"]);
    expect((await registry.findByName("aik"))?.id).toBe(team.id);

    // Back to the old name: no longer an alias of itself.
    const back = await registry.update(team.id, { name: "AIK" });
    expect(back.aliases).toEqual(["AIK Basket"]);
  });

  it("an update changes only what is sent, and an empty value goes back to the derived one", async () => {
    const team = await registry.create({ name: "Solna Vikings", shortName: "SVK", color: "#123456" });
    const own = await registry.update(team.id, { own: true });
    expect(own).toMatchObject({ name: "Solna Vikings", shortName: "SVK", color: "#123456", own: true });

    const cleared = await registry.update(team.id, { shortName: "", color: null });
    expect(cleared.shortName).toBe("SOL");
    expect(cleared.color).toBe(deriveColor("Solna Vikings"));
  });

  it("refuses to rename a team to another team's name", async () => {
    await registry.create({ name: "AIK" });
    const other = await registry.create({ name: "Hammarby" });
    await expect(registry.update(other.id, { name: "aik" })).rejects.toMatchObject({ status: 409 });
  });

  it("stores a logo under the team and removes it with the team", async () => {
    const team = await registry.create({ name: "AIK" });
    const withLogo = await registry.setLogo(team.id, PNG);
    expect(withLogo.logoUrl).toMatch(new RegExp(`^/api/teams/${team.id}/logo\\?v=`));
    expect(storage.files.get(teamLogoKey(team.id))?.type).toBe("image/png");
    expect((await registry.logo(team.id))?.bytes.toString()).toBe("png-bytes");

    await expect(registry.setLogo(team.id, "data:image/gif;base64,AAAA")).rejects.toThrow(/PNG/);
    const big = `data:image/png;base64,${Buffer.alloc(1024 * 1024 + 1).toString("base64")}`;
    await expect(registry.setLogo(team.id, big)).rejects.toThrow(/max 1 MB/);

    await registry.remove(team.id);
    expect(storage.files.has(teamLogoKey(team.id))).toBe(false);
    expect(await registry.list()).toEqual([]);
  });

  it("removes a logo on its own", async () => {
    const team = await registry.create({ name: "AIK" });
    await registry.setLogo(team.id, PNG);
    const without = await registry.removeLogo(team.id);
    expect(without.logoUrl).toBeUndefined();
    expect(storage.files.has(teamLogoKey(team.id))).toBe(false);
    expect(await registry.logo(team.id)).toBeNull();
  });

  it("merges a duplicate: its names follow, and its logo when the kept team has none", async () => {
    const keep = await registry.create({ name: "AIK", own: false });
    const drop = await registry.create({ name: "A.I.K.", shortName: "AIKB", color: "#000000" });
    await registry.setLogo(drop.id, PNG);

    const merged = await registry.merge(keep.id, drop.id);
    expect(merged.id).toBe(keep.id);
    expect(merged.aliases).toEqual(["A.I.K."]);
    expect(merged.shortName).toBe("AIKB");
    expect(merged.logoUrl).toBeDefined();
    expect((await registry.logo(keep.id))?.bytes.toString()).toBe("png-bytes");
    expect(storage.files.has(teamLogoKey(drop.id))).toBe(false);

    expect(await registry.get(drop.id)).toBeNull();
    expect((await registry.findByName("a.i.k."))?.id).toBe(keep.id);
    // A camera typing the old name again does not bring the duplicate back.
    expect((await registry.ensure("A.I.K."))?.id).toBe(keep.id);
    expect(await registry.list()).toHaveLength(1);
  });

  it("refuses to merge a team with itself or with one that does not exist", async () => {
    const team = await registry.create({ name: "AIK" });
    await expect(registry.merge(team.id, team.id)).rejects.toMatchObject({ status: 400 });
    await expect(registry.merge(team.id, "nope")).rejects.toMatchObject({ status: 404 });
  });
});

// --- Routes ---

describe("team routes", () => {
  let app: FastifyInstance;
  let storage: ReturnType<typeof memoryStorage>;
  let admin: Record<string, string>;
  let viewer: Record<string, string>;

  beforeAll(async () => {
    storage = memoryStorage();
    initServices({} as never, storage as never, {} as never);
    admin = { "x-admin-token": createAdminToken() };
    viewer = { authorization: `Bearer ${createViewerToken()}` };
    app = Fastify();
    await app.register(teamRoutes);
  });

  afterAll(async () => {
    await app.close();
  });

  it("lists teams for viewers and admins, not for anyone", async () => {
    await teams.create({ name: "AIK" });
    expect((await app.inject({ url: "/api/teams" })).statusCode).toBe(401);

    const asViewer = await app.inject({ url: "/api/teams", headers: viewer });
    expect(asViewer.statusCode).toBe(200);
    expect(asViewer.json().map((t: { name: string }) => t.name)).toContain("AIK");

    expect((await app.inject({ url: "/api/teams", headers: admin })).statusCode).toBe(200);
  });

  it("lets only an admin change the registry", async () => {
    const asViewer = await app.inject({ method: "POST", url: "/api/admin/teams", headers: viewer, payload: { name: "Hammarby" } });
    expect(asViewer.statusCode).toBe(401);

    const created = await app.inject({ method: "POST", url: "/api/admin/teams", headers: admin, payload: { name: "Hammarby" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const dup = await app.inject({ method: "POST", url: "/api/admin/teams", headers: admin, payload: { name: "hammarby" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ teamId: id });

    const updated = await app.inject({ method: "PUT", url: `/api/admin/teams/${id}`, headers: admin, payload: { shortName: "HAM" } });
    expect(updated.json().shortName).toBe("HAM");

    const missing = await app.inject({ method: "PUT", url: "/api/admin/teams/nope", headers: admin, payload: { own: true } });
    expect(missing.statusCode).toBe(404);

    const removed = await app.inject({ method: "DELETE", url: `/api/admin/teams/${id}`, headers: admin });
    expect(removed.statusCode).toBe(204);
  });

  it("serves an uploaded logo to anyone, cached by version", async () => {
    const team = await teams.create({ name: "Solna Vikings" });
    const none = await app.inject({ url: `/api/teams/${team.id}/logo` });
    expect(none.statusCode).toBe(404);

    const put = await app.inject({ method: "PUT", url: `/api/admin/teams/${team.id}/logo`, headers: admin, payload: { dataUrl: PNG } });
    expect(put.statusCode).toBe(200);

    const logo = await app.inject({ url: put.json().logoUrl });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers["content-type"]).toBe("image/png");
    expect(logo.headers["cache-control"]).toContain("immutable");

    const bad = await app.inject({ method: "PUT", url: `/api/admin/teams/${team.id}/logo`, headers: admin, payload: { dataUrl: "nope" } });
    expect(bad.statusCode).toBe(400);
  });

  it("merges two teams", async () => {
    const keep = await teams.create({ name: "Täby Basket" });
    const drop = await teams.create({ name: "Täby" });
    const res = await app.inject({ method: "POST", url: `/api/admin/teams/${keep.id}/merge`, headers: admin, payload: { from: drop.id } });
    expect(res.statusCode).toBe(200);
    expect(res.json().aliases).toEqual(["Täby"]);
    expect(await teams.get(drop.id)).toBeNull();
  });
});

// --- A match started in the camera app ---

describe("starting a stream", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const storage = { ...memoryStorage(), addVodEntry: vi.fn(async () => {}) };
    const restreamer = {
      rtmpHost: "rtmp.example.com",
      baseUrlValue: "https://restreamer.example.com",
      createProcess: vi.fn(async () => ({})),
      rtmpUrl: (id: string) => `rtmp://rtmp.example.com/live/${id}`,
      hlsUrl: (id: string) => `https://restreamer.example.com/memfs/${id}.m3u8`,
    };
    const osc = {
      getState: () => "running",
      isUp: () => true,
      getInfo: () => ({ url: "https://restreamer.example.com", rtmpHost: "rtmp.example.com" }),
      streamStarted: vi.fn(),
    };
    initServices(restreamer as never, storage as never, osc as never);
    app = Fastify();
    await app.register(streamRoutes);
  });

  afterAll(async () => {
    await app.close();
    streamMeta.clear();
  });

  it("adds an unknown opponent, and an unknown home team as one of the club's own", async () => {
    await teams.create({ name: "AIK" });
    const res = await app.inject({
      method: "POST",
      url: "/api/streams",
      headers: { "x-api-key": "test-api-key" },
      payload: { name: "Läktaren", team: "P12", opponent: "aik " },
    });
    expect(res.statusCode).toBe(201);

    await vi.waitFor(async () => expect(await teams.findByName("P12")).not.toBeNull());
    expect((await teams.findByName("P12"))?.own).toBe(true);
    // The known opponent is not added again.
    expect((await teams.list()).map((t) => t.name).sort()).toEqual(["AIK", "P12"]);

    const next = await app.inject({
      method: "POST",
      url: "/api/streams",
      headers: { "x-api-key": "test-api-key" },
      payload: { name: "Läktaren 2", team: "P12", opponent: "Solna Vikings" },
    });
    expect(next.statusCode).toBe(201);
    await vi.waitFor(async () => expect(await teams.findByName("solna vikings")).not.toBeNull());
    expect((await teams.findByName("Solna Vikings"))?.own).toBe(false);
  });
});
