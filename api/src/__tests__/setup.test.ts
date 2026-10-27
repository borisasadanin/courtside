/**
 * First-run setup.
 *
 * A fresh installation must never be open: until setup is done there is no
 * admin PIN, and only the one-time code gets in.  Afterwards the chosen PINs
 * must survive a restart, and a new code must reopen setup.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { Setup, SETUP_KEY, codeMatches } from "../setup.js";
import { mutableConfig } from "../config.js";
import { isMediaKey } from "../routes/media.js";
import setupRoutes from "../routes/setup-routes.js";
import authRoutes from "../routes/auth-routes.js";

function memoryStorage() {
  const files = new Map<string, string>();
  return {
    files,
    failReads: false,
    async readFileIfExists(key: string) {
      if (this.failReads) throw new Error("storage down");
      return files.get(key) ?? null;
    },
    async uploadBuffer(key: string, body: Buffer | string) {
      files.set(key, body.toString());
    },
  };
}

const CODE = "ABCD-EFGH";

beforeEach(() => {
  mutableConfig.ADMIN_PIN = "";
  mutableConfig.VIEWER_PIN = "";
});

describe("Setup", () => {
  it("does not exist without a setup code", async () => {
    mutableConfig.ADMIN_PIN = "111111";
    const setup = new Setup(memoryStorage(), "");
    await setup.load();
    expect(setup.isRequired()).toBe(false);
    expect(mutableConfig.ADMIN_PIN).toBe("111111");
  });

  it("opens on a fresh installation, with no admin PIN in force", async () => {
    mutableConfig.ADMIN_PIN = "999999"; // left over from the environment
    const setup = new Setup(memoryStorage(), CODE);
    await setup.load();
    expect(setup.isRequired()).toBe(true);
    expect(mutableConfig.ADMIN_PIN).toBe("");
  });

  it("refuses the wrong code", async () => {
    const setup = new Setup(memoryStorage(), CODE);
    await setup.load();
    expect(await setup.complete({ code: "WRNG-CODE", adminPin: "123456" })).toMatch(/Fel/);
    expect(setup.isRequired()).toBe(true);
  });

  it("validates the PINs", async () => {
    const setup = new Setup(memoryStorage(), CODE);
    await setup.load();
    expect(await setup.complete({ code: CODE, adminPin: "1234" })).toMatch(/6–8/);
    expect(await setup.complete({ code: CODE, adminPin: "123456", viewerPin: "12" })).toMatch(/4–8/);
    expect(await setup.complete({ code: CODE, adminPin: "123456", viewerPin: "123456" })).toMatch(/olika/);
  });

  it("accepts the code typed loosely", () => {
    expect(codeMatches(" abcd-efgh ", CODE)).toBe(true);
  });

  it("stores the choices and closes", async () => {
    const storage = memoryStorage();
    const setup = new Setup(storage, CODE);
    await setup.load();
    expect(await setup.complete({ code: CODE, adminPin: "123456", viewerPin: "2468" })).toBeNull();
    expect(setup.isRequired()).toBe(false);
    expect(mutableConfig.ADMIN_PIN).toBe("123456");
    expect(mutableConfig.VIEWER_PIN).toBe("2468");
    expect(storage.files.has(SETUP_KEY)).toBe(true);
    expect(await setup.complete({ code: CODE, adminPin: "654321" })).toMatch(/redan/);
  });

  it("restores the PINs after a restart", async () => {
    const storage = memoryStorage();
    const first = new Setup(storage, CODE);
    await first.load();
    await first.complete({ code: CODE, adminPin: "123456", viewerPin: "2468" });

    mutableConfig.ADMIN_PIN = "";
    mutableConfig.VIEWER_PIN = "";
    const restarted = new Setup(storage, CODE);
    await restarted.load();
    expect(restarted.isRequired()).toBe(false);
    expect(mutableConfig.ADMIN_PIN).toBe("123456");
    expect(mutableConfig.VIEWER_PIN).toBe("2468");
  });

  it("reopens with a new code — the forgotten-PIN path", async () => {
    const storage = memoryStorage();
    const first = new Setup(storage, CODE);
    await first.load();
    await first.complete({ code: CODE, adminPin: "123456" });

    const reset = new Setup(storage, "NEWC-ODE2");
    await reset.load();
    expect(reset.isRequired()).toBe(true);
    expect(mutableConfig.ADMIN_PIN).toBe("");
  });

  it("keeps the viewer PIN through a reset, so matches never stand open", async () => {
    const storage = memoryStorage();
    const first = new Setup(storage, CODE);
    await first.load();
    await first.complete({ code: CODE, adminPin: "123456", viewerPin: "4321" });

    mutableConfig.VIEWER_PIN = "";
    const reset = new Setup(storage, "NEWC-ODE2");
    await reset.load();
    expect(mutableConfig.VIEWER_PIN).toBe("4321");

    expect(await reset.complete({ code: "NEWC-ODE2", adminPin: "654321" })).toBeNull();
    expect(mutableConfig.VIEWER_PIN).toBe("4321");
  });

  it("does not mistake a storage outage for a fresh installation", async () => {
    const storage = memoryStorage();
    storage.failReads = true;
    const setup = new Setup(storage, CODE);
    await expect(setup.load()).rejects.toThrow();
    expect(setup.isRequired()).toBe(false);
    expect(mutableConfig.ADMIN_PIN).toBe("");
  });
});

describe("setup routes", () => {
  let app: FastifyInstance;
  let setup: Setup;

  beforeEach(async () => {
    setup = new Setup(memoryStorage(), CODE);
    await setup.load();
    app = Fastify();
    await app.register(rateLimit, { global: false });
    await app.register(authRoutes);
    await app.register(setupRoutes, { setup });
  });

  it("tells the website that setup is needed", async () => {
    const res = await app.inject({ url: "/api/setup" });
    expect(res.json()).toEqual({ required: true, keepsViewerPin: false });
  });

  it("lets nobody in as admin before setup", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/admin", payload: { pin: "" } });
    expect(res.statusCode).toBe(401);
  });

  it("logs the club in as admin when setup completes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { code: CODE, adminPin: "123456", viewerPin: "2468" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("admin");
    expect(res.json().adminToken).toBeTruthy();

    const login = await app.inject({ method: "POST", url: "/api/auth/admin", payload: { pin: "123456" } });
    expect(login.statusCode).toBe(200);
  });

  it("answers a wrong code with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { code: "WRNG-CODE", adminPin: "123456" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("media route allowlist", () => {
  it("signs media", () => {
    for (const key of ["s1/p1_seg4.ts", "clips/s1/c1.mp4", "s1/thumb.jpg"]) {
      expect(isMediaKey(key)).toBe(true);
    }
  });

  it("never signs the installation's own state", () => {
    for (const key of [SETUP_KEY, "devices.json", "vod-index.json", "active-streams.json"]) {
      expect(isMediaKey(key)).toBe(false);
    }
  });
});
