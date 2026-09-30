/**
 * Club manifest: the public identity contract the website themes itself from.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

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
    await app.register(clubRoutes);

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
