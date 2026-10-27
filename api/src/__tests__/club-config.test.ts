/**
 * Club manifest: the public identity contract the website themes itself from.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

function memoryStorage() {
  const files = new Map<string, Buffer>();
  return {
    files,
    async readFileIfExists(key: string) {
      return files.get(key)?.toString() ?? null;
    },
    async uploadBuffer(key: string, body: Buffer | string) {
      files.set(key, Buffer.from(body));
    },
    async downloadBuffer(key: string) {
      const file = files.get(key);
      if (!file) throw new Error("missing");
      return file;
    },
    async deleteObject(key: string) {
      files.delete(key);
    },
  };
}

describe("club manifest", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => vi.resetModules());
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("is served unauthenticated so the PIN screen can be branded", async () => {
    const app = Fastify();
    const { default: clubRoutes } = await import("../routes/club-routes.js");
    const { Branding } = await import("../club-branding.js");
    await app.register(clubRoutes, { branding: new Branding(memoryStorage()) });

    const res = await app.inject({ method: "GET", url: "/api/club" });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Test Courtside");
    await app.close();
  });

  it("falls back to the club name for the short name", async () => {
    process.env.CLUB_NAME = "Hammarby Courtside";
    delete process.env.CLUB_SHORT_NAME;
    const mod = await import("../club-config.js");
    expect(mod.clubManifest.shortName).toBe("Hammarby Courtside");
  });

  it("exposes sport terminology as configuration, not hardcoded rules", async () => {
    const mod = await import("../club-config.js");
    expect(mod.clubManifest.sport.id).toBe("basketball");
    expect(mod.clubManifest.sport.periodCount).toBe(4);
    expect(mod.clubManifest.sport.clipDurationSeconds).toBe(8);
  });

  it("resolves a relative logo against the public site URL", async () => {
    process.env.PUBLIC_SITE_URL = "https://live.example.com";
    process.env.CLUB_LOGO_URL = "/assets/icon.png";
    const mod = await import("../club-config.js");
    expect(mod.absoluteLogoUrl()).toBe("https://live.example.com/assets/icon.png");
  });

  it("passes an absolute logo URL through unchanged", async () => {
    process.env.CLUB_LOGO_URL = "https://cdn.example.com/logo.png";
    const mod = await import("../club-config.js");
    expect(mod.absoluteLogoUrl()).toBe("https://cdn.example.com/logo.png");
  });

  it("returns null for a relative logo with no site URL, rather than a broken link", async () => {
    process.env.PUBLIC_SITE_URL = "";
    process.env.CLUB_LOGO_URL = "/assets/icon.png";
    const mod = await import("../club-config.js");
    expect(mod.absoluteLogoUrl()).toBeNull();
  });
});

describe("club branding from the admin view", () => {
  beforeEach(() => vi.resetModules());

  const PNG = "data:image/png;base64," + Buffer.from("not really a png").toString("base64");

  it("overrides the environment and survives a restart", async () => {
    const { Branding } = await import("../club-branding.js");
    const { clubManifest } = await import("../club-config.js");
    const storage = memoryStorage();

    const first = new Branding(storage);
    await first.load();
    expect(await first.update({ name: "Hammarby Courtside", tagline: "", accentColor: "#112233" })).toBeNull();
    expect(await first.setLogo(PNG)).toBeNull();

    clubManifest.name = "reset";
    await new Branding(storage).load();
    expect(clubManifest.name).toBe("Hammarby Courtside");
    expect(clubManifest.accentColor).toBe("#112233");
    expect(clubManifest.logoUrl).toMatch(/^\/api\/club\/logo\?v=/);
  });

  it("refuses bad input", async () => {
    const { Branding } = await import("../club-branding.js");
    const branding = new Branding(memoryStorage());
    await branding.load();
    expect(await branding.update({ name: "", accentColor: "#112233" })).toMatch(/Namnet/);
    expect(await branding.update({ name: "X", accentColor: "red" })).toMatch(/Färgen/);
    expect(await branding.setLogo("data:image/svg+xml;base64,PHN2Zz4=")).toMatch(/PNG/);
  });

  it("serves the logo publicly and changes it only for an admin", async () => {
    const { default: clubRoutes } = await import("../routes/club-routes.js");
    const { Branding } = await import("../club-branding.js");
    const branding = new Branding(memoryStorage());
    await branding.load();
    const app = Fastify();
    await app.register(clubRoutes, { branding });

    expect((await app.inject({ method: "GET", url: "/api/club/logo" })).statusCode).toBe(404);
    const denied = await app.inject({ method: "PUT", url: "/api/admin/club/logo", payload: { dataUrl: PNG } });
    expect(denied.statusCode).toBe(401);

    await branding.setLogo(PNG);
    const res = await app.inject({ method: "GET", url: "/api/club/logo" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    await app.close();
  });
});
