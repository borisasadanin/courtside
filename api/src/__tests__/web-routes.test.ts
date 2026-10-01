/**
 * Website served from the API's origin.
 *
 * The point is one address per club: the page must find the API without being
 * told where it is, and a deploy must be visible on the next page load.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webRoutes, { webDistDir } from "../routes/web.js";

let root: string;
let app: FastifyInstance;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "courtside-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Courtside</title>");
  writeFileSync(join(root, "clip.html"), "<!doctype html><title>Clip</title>");
  writeFileSync(join(root, "assets", "bundle-1a2b3c4d.js"), "console.log(1)");
  // A URL left over from a separately hosted deployment.
  writeFileSync(join(root, "runtime-config.js"), 'window.COURTSIDE_CONFIG = { apiUrl: "https://elsewhere.example.com" };');

  app = Fastify();
  app.get("/api/club", async () => ({ name: "Test" }));
  await app.register(webRoutes, { root });
});

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("website routes", () => {
  it("serves the page at the root, uncached", async () => {
    const res = await app.inject({ url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Courtside</title>");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("serves the clip page", async () => {
    const res = await app.inject({ url: "/clip.html" });
    expect(res.statusCode).toBe(200);
  });

  it("caches hashed assets for good", async () => {
    const res = await app.inject({ url: "/assets/bundle-1a2b3c4d.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("points the page at its own origin, whatever the bundle says", async () => {
    const res = await app.inject({ url: "/runtime-config.js" });
    expect(res.body).toContain('apiUrl: ""');
    expect(res.body).not.toContain("elsewhere");
  });

  it("leaves the API alone", async () => {
    const res = await app.inject({ url: "/api/club" });
    expect(res.json()).toEqual({ name: "Test" });
  });
});

describe("webDistDir", () => {
  it("finds a built website", () => {
    process.env.WEB_DIST_DIR = root;
    expect(webDistDir()).toBe(root);
  });

  it("returns null when nothing is built, so the API runs alone", () => {
    process.env.WEB_DIST_DIR = join(root, "missing");
    expect(webDistDir()).toBeNull();
    delete process.env.WEB_DIST_DIR;
  });
});
