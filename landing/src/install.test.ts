import { describe, expect, it } from "vitest";
import { install, invalidClub, Job, renewToken, resetAdmin, setupCode, uninstall } from "./install.js";
import { App, CONFIG_SERVICE, NewApp, Osc, Parameter, RESTREAMER_SERVICE, STORAGE_SERVICE } from "./osc.js";

/** An OSC tenant in memory. */
function fakeTenant(opts: { failAt?: string; buildStatus?: string; takenDomain?: string; fixedByRebuild?: boolean } = {}) {
  const instances = new Set<string>();
  const stores = new Map<string, Map<string, Parameter>>();
  const apps = new Map<string, App & { body: NewApp }>();
  const tokens = new Map<string, boolean>();
  const domains = new Map<string, string>();
  const calls: string[] = [];
  const fail = (what: string) => {
    calls.push(what);
    if (opts.failAt === what) throw new Error(`${what} failed`);
  };

  const osc: Osc = {
    environment: "prod",
    async instanceExists(service, name) {
      return instances.has(`${service}/${name}`);
    },
    async createStorage(name) {
      fail("createStorage");
      instances.add(`${STORAGE_SERVICE}/${name}`);
      return `https://tenant-${name}.minio-minio.auto.prod.osaas.io`;
    },
    async removeInstance(service, name) {
      calls.push(`remove ${service}/${name}`);
      instances.delete(`${service}/${name}`);
    },
    async createParameterStore(name) {
      fail("createParameterStore");
      instances.add(`${CONFIG_SERVICE}/${name}`);
      stores.set(name, new Map());
      return "store-key";
    },
    async parameterStoreKey(name) {
      return stores.has(name) ? "store-key" : undefined;
    },
    async removeParameterStore(name) {
      calls.push(`remove store ${name}`);
      stores.delete(name);
      instances.delete(`${CONFIG_SERVICE}/${name}`);
    },
    async writeParameters(store, apiKey, params) {
      fail("writeParameters");
      if (apiKey !== "store-key") throw new Error("wrong key");
      for (const p of params) stores.get(store)!.set(p.key, p);
    },
    async listApps() {
      return [...apps.values()];
    },
    async domainAvailable(domain) {
      return !domains.has(domain) && !(opts.takenDomain === domain);
    },
    async addDomain(app, domain) {
      fail("addDomain");
      domains.set(domain, app);
    },
    async removeDomain(_app, domain) {
      calls.push(`remove domain ${domain}`);
      domains.delete(domain);
    },
    async listDomains() {
      const out = new Map<string, string[]>();
      for (const [d, a] of domains) out.set(a, [...(out.get(a) ?? []), d]);
      return out;
    },
    async createApp(body) {
      fail("createApp");
      const app = { id: body.name, name: body.name, url: "", gitUrl: body.gitUrl, buildStatus: "building", body };
      apps.set(app.id, app);
      return app;
    },
    async getApp(id) {
      const a = apps.get(id);
      if (!a) return undefined;
      return { ...a, buildStatus: opts.buildStatus ?? "running", url: `https://abc123.apps.osaas.io` };
    },
    async restartApp(id, rebuild) {
      calls.push(rebuild ? `rebuild ${id}` : `restart ${id}`);
      if (rebuild && opts.buildStatus === "failed" && opts.fixedByRebuild) opts.buildStatus = "running";
    },
    async removeApp(id) {
      calls.push(`remove app ${id}`);
      apps.delete(id);
    },
    async mintToken(name) {
      fail("mintToken");
      tokens.set(name, true);
      return `pat-${name}`;
    },
    async revokeTokens(prefix, keep) {
      for (const name of tokens.keys()) if (name.startsWith(prefix) && name !== keep) tokens.set(name, false);
    },
    async tokensLeft() {
      return 500;
    },
    async plan() {
      return "PERSONAL";
    },
  };
  return { osc, instances, stores, apps, tokens, calls, domains };
}

const fast = { buildTimeout: 1000, onlineTimeout: 200, poll: 1, rebuildAfter: 10, failedGrace: 50 };
const source = { gitUrl: "https://github.com/x/courtside" };
const newJob = (): Job => ({ club: "alta", tenant: "t1", step: "check", state: "running", startedAt: Date.now() });
const req = { club: "alta", displayName: "Älta IF Basket", tenant: "t1" };

describe("install", () => {
  it("creates storage, configuration and the app, and hands back address and setup code", async () => {
    const t = fakeTenant();
    const job = newJob();
    await install(t.osc, req, source, job, fast, async () => true);

    expect(job.state).toBe("done");
    expect(job.siteUrl).toBe("https://alta.apps.osaas.io");
    expect(t.domains.get("alta.apps.osaas.io")).toBe("altaapi");
    expect(job.setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    expect(t.instances.has(`${STORAGE_SERVICE}/altastorage`)).toBe(true);
    const params = t.stores.get("altaconfig")!;
    expect(params.get("SETUP_CODE")?.value).toBe(job.setupCode);
    expect(params.get("SETUP_CODE")?.secret).toBe(true);
    expect(params.get("OSC_ACCESS_TOKEN")?.value).toMatch(/^pat-courtside-alta-/);
    expect(params.get("OSC_TENANT")?.value).toBe("t1");
    expect(params.get("OSC_INSTANCE_NAME")?.value).toBe("altarestreamer");
    expect(params.get("MINIO_ENDPOINT")?.value).toContain("altastorage");
    expect(params.get("CLUB_NAME")?.value).toBe("Älta IF Basket");
    expect(params.has("ADMIN_PIN")).toBe(false);

    const app = t.apps.get("altaapi")!;
    expect(app.body.configService).toBe("altaconfig");
    expect(app.body.configApiKey).toBe("store-key");
    expect(app.body.gitToken).toBeUndefined();
  });

  it.each(["createStorage", "mintToken", "createParameterStore", "writeParameters", "createApp"])(
    "removes what it created when %s fails",
    async (failAt) => {
      const t = fakeTenant({ failAt });
      const job = newJob();
      await install(t.osc, req, source, job, fast, async () => true);

      expect(job.state).toBe("failed");
      expect(job.error).toContain(failAt);
      expect(t.instances.size).toBe(0);
      expect(t.stores.size).toBe(0);
      expect(t.apps.size).toBe(0);
      expect([...t.tokens.values()].some(Boolean)).toBe(false);
    }
  );

  it("removes everything when the build fails", async () => {
    const t = fakeTenant({ buildStatus: "failed" });
    const job = newJob();
    await install(t.osc, req, source, job, { ...fast, buildTimeout: 200 }, async () => false);
    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/misslyckades/);
    expect(t.apps.size).toBe(0);
    expect(t.instances.size).toBe(0);
  });

  it("rebuilds a failed first build once, and carries on when that helps", async () => {
    const t = fakeTenant({ buildStatus: "failed", fixedByRebuild: true });
    const job = newJob();
    await install(t.osc, req, source, job, fast, async () => t.calls.includes("rebuild altaapi"));
    expect(t.calls.filter((c) => c === "rebuild altaapi")).toHaveLength(1);
    expect(job.state).toBe("done");
  });

  it("rebuilds only once before giving up", async () => {
    const t = fakeTenant({ buildStatus: "failed" });
    const job = newJob();
    await install(t.osc, req, source, job, { ...fast, buildTimeout: 500 }, async () => false);
    expect(t.calls.filter((c) => c === "rebuild altaapi")).toHaveLength(1);
    expect(job.state).toBe("failed");
  });

  it("refuses an address another account already has, before creating anything", async () => {
    const t = fakeTenant({ takenDomain: "alta.apps.osaas.io" });
    const job = newJob();
    await install(t.osc, req, source, job, fast, async () => true);
    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/redan tagen/);
    expect(t.calls).not.toContain("createStorage");
  });

  it("falls back to the platform's address if the own one cannot be mapped", async () => {
    const t = fakeTenant({ failAt: "addDomain" });
    const job = newJob();
    await install(t.osc, req, source, job, fast, async () => true);
    expect(job.state).toBe("done");
    expect(job.siteUrl).toBe("https://abc123.apps.osaas.io");
  });

  it("trusts an app that answers even while the platform still says failed", async () => {
    const t = fakeTenant({ buildStatus: "failed" });
    const job = newJob();
    await install(t.osc, req, source, job, fast, async () => true);
    expect(job.state).toBe("done");
    expect(t.apps.size).toBe(1);
  });

  it("removes everything when the app never answers", async () => {
    const t = fakeTenant();
    const job = newJob();
    await install(t.osc, req, source, job, fast, async () => false);
    expect(job.state).toBe("failed");
    expect(job.step).toBe("online");
    expect(t.apps.size).toBe(0);
  });

  it("refuses a name already in use, and leaves the existing installation alone", async () => {
    const t = fakeTenant();
    await install(t.osc, req, source, newJob(), fast, async () => true);
    const before = t.calls.length;

    const job = newJob();
    await install(t.osc, req, source, job, fast, async () => true);
    expect(job.state).toBe("failed");
    expect(job.error).toContain("finns redan");
    expect(t.calls.slice(before).filter((c) => c.startsWith("remove"))).toEqual([]);
    expect(t.apps.has("altaapi")).toBe(true);
  });

  it("refuses when storage of that name already exists", async () => {
    const t = fakeTenant();
    t.instances.add(`${STORAGE_SERVICE}/altastorage`);
    const job = newJob();
    await install(t.osc, req, source, job, fast, async () => true);
    expect(job.state).toBe("failed");
    expect(t.instances.has(`${STORAGE_SERVICE}/altastorage`)).toBe(true);
  });

  it("gives the repository token only to allowed tenants", async () => {
    const withToken = { ...source, token: "ghp_secret", tokenTenants: ["t1"] };

    const allowed = fakeTenant();
    await install(allowed.osc, req, withToken, newJob(), fast, async () => true);
    expect(allowed.apps.get("altaapi")!.body.gitToken).toBe("ghp_secret");

    const other = fakeTenant();
    const job = newJob();
    await install(other.osc, { ...req, tenant: "t2" }, withToken, job, fast, async () => true);
    expect(job.state).toBe("failed");
    expect(other.apps.size).toBe(0);
    expect(other.calls).not.toContain("createStorage");
  });
});

describe("uninstall", () => {
  it("removes the app, Restreamer, configuration, storage and token", async () => {
    const t = fakeTenant();
    await install(t.osc, req, source, newJob(), fast, async () => true);
    t.instances.add(`${RESTREAMER_SERVICE}/altarestreamer`);

    await uninstall(t.osc, "alta");
    expect(t.apps.size).toBe(0);
    expect(t.instances.size).toBe(0);
    expect(t.stores.size).toBe(0);
    expect([...t.tokens.values()].some(Boolean)).toBe(false);
  });
});

describe("renewToken", () => {
  it("writes a new token, restarts the app and revokes only the old one", async () => {
    const t = fakeTenant();
    await install(t.osc, req, source, newJob(), fast, async () => true);
    const old = t.stores.get("altaconfig")!.get("OSC_ACCESS_TOKEN")!.value;
    await new Promise((r) => setTimeout(r, 2));

    await renewToken(t.osc, "alta");
    const fresh = t.stores.get("altaconfig")!.get("OSC_ACCESS_TOKEN")!.value;
    expect(fresh).not.toBe(old);
    expect(t.calls).toContain("restart altaapi");
    expect(t.tokens.get(old.replace(/^pat-/, ""))).toBe(false);
    expect(t.tokens.get(fresh.replace(/^pat-/, ""))).toBe(true);
  });
});

describe("resetAdmin", () => {
  it("writes a new setup code and restarts the app, leaving the rest alone", async () => {
    const t = fakeTenant();
    await install(t.osc, req, source, newJob(), fast, async () => true);
    const store = t.stores.get("altaconfig")!;
    const old = store.get("SETUP_CODE")!.value;
    const apiKey = store.get("API_KEY")?.value;

    const code = await resetAdmin(t.osc, "alta");
    expect(code).not.toBe(old);
    expect(store.get("SETUP_CODE")!.value).toBe(code);
    expect(store.get("API_KEY")?.value).toBe(apiKey);
    expect(t.calls).toContain("restart altaapi");
  });

  it("refuses a club that is not installed", async () => {
    await expect(resetAdmin(fakeTenant().osc, "nobody")).rejects.toThrow(/Hittar ingen/);
  });
});

describe("names and codes", () => {
  it("accepts names OSC accepts", () => {
    expect(invalidClub("alta")).toBeUndefined();
    expect(invalidClub("altaif2")).toBeUndefined();
    for (const bad of ["al", "Alta", "älta", "2alta", "alta-if", "a".repeat(22), ""]) {
      expect(invalidClub(bad)).toBeDefined();
    }
  });

  it("makes setup codes without look-alike characters", () => {
    for (let i = 0; i < 200; i++) expect(setupCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });
});
