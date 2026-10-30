/**
 * Changing the PINs from the admin view.
 *
 * A forgotten code cannot be read back, only replaced, and the replacement
 * must survive a restart.  The admin PIN is the key to everything, so a new
 * one needs the current one: an admin session left open must not be enough to
 * lock the club out.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { Setup, SETUP_KEY } from "../setup.js";
import { mutableConfig } from "../config.js";
import { createAdminToken } from "../auth.js";
import setupRoutes from "../routes/setup-routes.js";
import authRoutes from "../routes/auth-routes.js";

function memoryStorage() {
  const files = new Map<string, string>();
  return {
    files,
    failWrites: false,
    async readFileIfExists(key: string) {
      return files.get(key) ?? null;
    },
    async uploadBuffer(key: string, body: Buffer | string) {
      if (this.failWrites) throw new Error("storage down");
      files.set(key, body.toString());
    },
  };
}

const CODE = "ABCD-EFGH";

async function setUp(storage = memoryStorage()) {
  const setup = new Setup(storage, CODE);
  await setup.load();
  await setup.complete({ code: CODE, adminPin: "123456", viewerPin: "2468" });
  return { setup, storage };
}

beforeEach(() => {
  mutableConfig.ADMIN_PIN = "";
  mutableConfig.VIEWER_PIN = "";
});

describe("Setup.changePins", () => {
  it("sets a new viewer PIN that survives a restart", async () => {
    const { setup, storage } = await setUp();
    expect(await setup.changePins({ viewerPin: "1357" })).toBeNull();
    expect(mutableConfig.VIEWER_PIN).toBe("1357");
    expect(mutableConfig.ADMIN_PIN).toBe("123456");

    const restarted = new Setup(storage, CODE);
    await restarted.load();
    expect(mutableConfig.VIEWER_PIN).toBe("1357");
    expect(JSON.parse(storage.files.get(SETUP_KEY)!).changedAt).toBeTruthy();
  });

  it("needs the current admin PIN for a new one", async () => {
    const { setup } = await setUp();
    expect(await setup.changePins({ adminPin: "654321" })).toBe("Fel nuvarande admin-kod.");
    expect(await setup.changePins({ currentAdminPin: "999999", adminPin: "654321" })).toBe("Fel nuvarande admin-kod.");
    expect(mutableConfig.ADMIN_PIN).toBe("123456");
    expect(await setup.changePins({ currentAdminPin: "123456", adminPin: "654321" })).toBeNull();
    expect(mutableConfig.ADMIN_PIN).toBe("654321");
  });

  it("holds new PINs to the rules setup uses", async () => {
    const { setup } = await setUp();
    expect(await setup.changePins({ viewerPin: "12" })).toMatch(/Tittarkoden/);
    expect(await setup.changePins({ currentAdminPin: "123456", adminPin: "123" })).toMatch(/Admin-koden/);
    expect(await setup.changePins({ viewerPin: "123456" })).toMatch(/olika/);
  });

  it("can open watching to anyone, on purpose", async () => {
    const { setup } = await setUp();
    expect(await setup.changePins({ viewerPin: "" })).toBeNull();
    expect(mutableConfig.VIEWER_PIN).toBe("");
  });

  it("keeps the old PINs when they cannot be stored", async () => {
    const { setup, storage } = await setUp();
    storage.failWrites = true;
    await expect(setup.changePins({ viewerPin: "1357" })).rejects.toThrow();
    expect(mutableConfig.VIEWER_PIN).toBe("2468");
  });

  it("refuses when the PINs come from the environment", async () => {
    const setup = new Setup(memoryStorage(), "");
    await setup.load();
    expect(setup.pinsLocked()).toMatch(/serverns inställningar/);
    expect(await setup.changePins({ viewerPin: "1357" })).toMatch(/serverns inställningar/);
  });
});

describe("PIN routes", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;

  beforeEach(async () => {
    const { setup } = await setUp();
    app = Fastify();
    await app.register(rateLimit, { global: false });
    await app.register(authRoutes);
    await app.register(setupRoutes, { setup });
    admin = { "x-admin-token": createAdminToken() };
  });

  it("are for the admin only", async () => {
    expect((await app.inject({ url: "/api/admin/pins" })).statusCode).toBe(401);
    const put = await app.inject({ method: "PUT", url: "/api/admin/pins", payload: { viewerPin: "1357" } });
    expect(put.statusCode).toBe(401);
    expect(mutableConfig.VIEWER_PIN).toBe("2468");
  });

  it("show the viewer PIN but never the admin PIN", async () => {
    const res = await app.inject({ url: "/api/admin/pins", headers: admin });
    expect(res.json()).toEqual({ viewerPin: "2468", changeable: true });
    expect(res.body).not.toContain("123456");
  });

  it("keep the admin signed in after a change, and end everyone else's session", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/pins",
      headers: admin,
      payload: { currentAdminPin: "123456", adminPin: "654321", viewerPin: "1357" },
    });
    expect(res.statusCode).toBe(200);
    const { adminToken, viewerPin } = res.json();
    expect(viewerPin).toBe("1357");

    // The token from before was signed with the old admin PIN.
    expect((await app.inject({ url: "/api/admin/pins", headers: admin })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/admin/pins", headers: { "x-admin-token": adminToken } })).statusCode).toBe(200);

    const login = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { pin: "654321" } });
    expect(login.json().role).toBe("admin");
  });

  it("answer a wrong current admin PIN with 403, not a logout", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/admin/pins",
      headers: admin,
      payload: { currentAdminPin: "000000", adminPin: "654321" },
    });
    expect(res.statusCode).toBe(403);
  });
});
