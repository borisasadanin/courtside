/**
 * Camera invites (#67).
 *
 * An admin sends an invite to someone who pairs their own camera later, without
 * the admin's screen.  What matters: an invite pairs exactly one camera, for
 * three days, and the camera carries the name the admin gave it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  DeviceRegistry,
  INVITE_TTL_MS,
  INVITE_RETENTION_MS,
  normaliseDeviceName,
  type Device,
  type DeviceInvite,
} from "../devices.js";
import { initServices, devices } from "../state.js";
import { inviteLink } from "../routes/device-routes.js";

const ADMIN = { "x-api-key": "test-api-key" };

function mockMinio() {
  let stored: Device[] = [];
  let invites: DeviceInvite[] = [];
  return {
    readDeviceIndex: vi.fn(async () => stored),
    writeDeviceIndex: vi.fn(async (d: Device[]) => { stored = JSON.parse(JSON.stringify(d)); }),
    readInviteIndex: vi.fn(async () => invites),
    writeInviteIndex: vi.fn(async (i: DeviceInvite[]) => { invites = JSON.parse(JSON.stringify(i)); }),
    get stored() { return stored; },
    get invites() { return invites; },
  };
}

describe("invites in the registry", () => {
  let minio: ReturnType<typeof mockMinio>;
  let registry: DeviceRegistry;

  beforeEach(() => {
    minio = mockMinio();
    registry = new DeviceRegistry(minio as never);
  });

  afterEach(() => vi.useRealTimers());

  it("pairs a camera that takes the invite's name, keeping the phone's own beside it", async () => {
    const { code } = await registry.createInvite("Anna – P13");
    const result = await registry.pair(code, "Annas iPhone");

    expect(result).not.toBeNull();
    expect(result!.device.name).toBe("Anna – P13");
    expect(result!.device.deviceName).toBe("Annas iPhone");
    expect(await registry.verify(result!.token)).not.toBeNull();
  });

  it("pairs only one camera", async () => {
    const { code, invite } = await registry.createInvite("Anna");
    const first = await registry.pair(code, "Första");
    expect(first).not.toBeNull();
    expect(await registry.pair(code, "Andra")).toBeNull();

    const [listed] = await registry.listInvites();
    expect(listed.id).toBe(invite.id);
    expect(listed.status).toBe("used");
    expect(listed.deviceId).toBe(first!.device.id);
    expect((await registry.list()).find((d) => d.id === first!.device.id)?.inviteId).toBe(invite.id);
  });

  it("pairs only one camera when two redeem it at the same moment", async () => {
    const { code } = await registry.createInvite("Anna");
    const fresh = new DeviceRegistry(minio as never); // nothing loaded yet
    const results = await Promise.all([fresh.pair(code, "A"), fresh.pair(code, "B"), fresh.pair(code, "C")]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(minio.stored).toHaveLength(1);
  });

  it("works for three days, not longer", async () => {
    vi.useFakeTimers();
    const early = await registry.createInvite("Tidig");
    const late = await registry.createInvite("Sen");

    vi.advanceTimersByTime(INVITE_TTL_MS - 60_000);
    expect(await registry.pair(early.code, "")).not.toBeNull();

    vi.advanceTimersByTime(120_000);
    expect(await registry.pair(late.code, "")).toBeNull();
    expect((await registry.listInvites()).find((i) => i.id === late.invite.id)?.status).toBe("expired");
  });

  it("cannot be used once revoked, and a used invite cannot be revoked", async () => {
    const a = await registry.createInvite("A");
    expect(await registry.revokeInvite(a.invite.id)).toBe("revoked");
    expect(await registry.pair(a.code, "")).toBeNull();
    expect(await registry.revokeInvite(a.invite.id)).toBe("not_pending");

    const b = await registry.createInvite("B");
    await registry.pair(b.code, "");
    expect(await registry.revokeInvite(b.invite.id)).toBe("not_pending");
    expect(await registry.revokeInvite("nosuchinvite")).toBe("not_found");
  });

  it("survives a restart", async () => {
    const { code } = await registry.createInvite("Anna");
    const afterRestart = new DeviceRegistry(minio as never);
    expect(await afterRestart.pair(code, "")).not.toBeNull();
  });

  it("keeps only a hash of the code", async () => {
    const { code } = await registry.createInvite("Anna");
    expect(JSON.stringify(minio.invites)).not.toContain(code);
    expect(await registry.listInvites()).not.toContainEqual(expect.objectContaining({ codeHash: expect.anything() }));
  });

  it("is accepted typed in lower case", async () => {
    const { code } = await registry.createInvite("Anna");
    expect(await registry.pair(` ${code.toLowerCase()} `, "")).not.toBeNull();
  });

  it("drops invites that finished long ago, and keeps recent ones", async () => {
    vi.useFakeTimers();
    await registry.createInvite("Gick ut");
    const used = await registry.createInvite("Använd");
    await registry.pair(used.code, "");

    vi.advanceTimersByTime(INVITE_RETENTION_MS + INVITE_TTL_MS + 60_000);
    const recent = await registry.createInvite("Använd nyss");
    await registry.pair(recent.code, "");
    await registry.createInvite("Ny"); // a write prunes

    expect(minio.invites.map((i) => i.name)).toEqual(["Använd nyss", "Ny"]);
    expect((await registry.listInvites()).map((i) => i.name)).toEqual(["Ny", "Använd nyss"]);
  });

  it("leaves pairing codes working as before", async () => {
    const { code } = registry.createPairingCode();
    const result = await registry.pair(code, "Boris iPhone");
    expect(result!.device.name).toBe("Boris iPhone");
    expect(result!.device.inviteId).toBeUndefined();
  });

  it("renames a camera, but not a disconnected one", async () => {
    const { device } = (await registry.pair(registry.createPairingCode().code, "iPhone"))!;
    expect((await registry.rename(device.id, "Läktaren"))?.name).toBe("Läktaren");
    expect(minio.stored[0].name).toBe("Läktaren");

    await registry.revoke(device.id);
    expect(await registry.rename(device.id, "Igen")).toBeNull();
    expect(await registry.rename("nosuchdevice", "X")).toBeNull();
  });
});

describe("camera names", () => {
  it("are trimmed, collapsed and capped, and empty is refused", () => {
    expect(normaliseDeviceName("  Anna   P13 ")).toBe("Anna P13");
    expect(normaliseDeviceName("x".repeat(100))).toHaveLength(60);
    expect(normaliseDeviceName("   ")).toBeNull();
    expect(normaliseDeviceName(42)).toBeNull();
    expect(normaliseDeviceName(undefined)).toBeNull();
  });
});

describe("the invite link", () => {
  it("goes to the landing site's /join page, with everything after #", () => {
    const link = new URL(inviteLink("https://club.apps.osaas.io", "ABCD-2345", "Älta IF"));
    expect(link.origin + link.pathname).toBe("https://courtside.apps.osaas.io/join/");
    expect(link.search).toBe("");
    const params = new URLSearchParams(link.hash.slice(1));
    expect(params.get("u")).toBe("https://club.apps.osaas.io");
    expect(params.get("c")).toBe("ABCD-2345");
    expect(params.get("n")).toBe("Älta IF");
  });
});

describe("invite routes", () => {
  let app: FastifyInstance;
  let minio: ReturnType<typeof mockMinio>;

  beforeEach(async () => {
    minio = mockMinio();
    initServices({} as never, minio as never, {} as never);
    app = Fastify();
    const { default: routes } = await import("../routes/device-routes.js");
    await app.register(routes);
  });

  async function invite(name: unknown = "Anna – P13") {
    return app.inject({ method: "POST", url: "/api/devices/invites", headers: { ...ADMIN, host: "club.example.com" }, payload: { name } });
  }

  it("need an admin", async () => {
    const res = await app.inject({ method: "POST", url: "/api/devices/invites", payload: { name: "Anna" } });
    expect(res.statusCode).toBe(401);
    expect((await app.inject({ url: "/api/devices/invites" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PATCH", url: "/api/devices/x", payload: { name: "y" } })).statusCode).toBe(401);
  });

  it("need a name", async () => {
    expect((await invite("")).statusCode).toBe(400);
    const noName = await app.inject({ method: "POST", url: "/api/devices/invites", headers: ADMIN, payload: {} });
    expect(noName.statusCode).toBe(400);
  });

  it("make an invite the camera app can redeem with the pairing endpoint it already uses", async () => {
    const res = await invite();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ name: "Anna – P13", status: "pending", apiUrl: "http://club.example.com" });
    expect(body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(body.link).toContain("courtside.apps.osaas.io/join/#");
    expect(body.appLink).toContain(`code=${encodeURIComponent(body.code)}`);
    expect(body).not.toHaveProperty("codeHash");

    const pair = await app.inject({ method: "POST", url: "/api/devices/pair", payload: { code: body.code, name: "Annas iPhone" } });
    expect(pair.statusCode).toBe(201);
    expect(pair.json().name).toBe("Anna – P13");

    const again = await app.inject({ method: "POST", url: "/api/devices/pair", payload: { code: body.code, name: "Någon annan" } });
    expect(again.statusCode).toBe(401);

    const list = await app.inject({ url: "/api/devices/invites", headers: ADMIN });
    expect(list.json()[0]).toMatchObject({ status: "used", deviceId: pair.json().deviceId });
  });

  it("revoke an open invite, and say so when it is already used", async () => {
    const { id, code } = (await invite()).json();
    const del = await app.inject({ method: "DELETE", url: `/api/devices/invites/${id}`, headers: ADMIN });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/api/devices/pair", payload: { code } })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: `/api/devices/invites/${id}`, headers: ADMIN })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: "/api/devices/invites/nope", headers: ADMIN })).statusCode).toBe(404);
  });

  it("rename a camera", async () => {
    const { code } = (await invite()).json();
    const { deviceId } = (await app.inject({ method: "POST", url: "/api/devices/pair", payload: { code } })).json();

    const res = await app.inject({ method: "PATCH", url: `/api/devices/${deviceId}`, headers: ADMIN, payload: { name: "Anna – P14" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Anna – P14");
    expect((await devices.list())[0].name).toBe("Anna – P14");

    expect((await app.inject({ method: "PATCH", url: `/api/devices/${deviceId}`, headers: ADMIN, payload: { name: " " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/devices/nope", headers: ADMIN, payload: { name: "X" } })).statusCode).toBe(404);
  });
});
