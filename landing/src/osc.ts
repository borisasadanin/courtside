/**
 * The OSC calls the installer makes, all with the signed-in user's own token,
 * so everything is created in the club's tenant and none of it in ours.
 *
 * These are the same platform APIs the Terraform provider uses for
 * `deploy/main.tf` — the two ways to install create the same thing.
 */

import {
  Context,
  createInstance,
  getInstance,
  removeInstance,
  waitForInstanceReady,
} from "@osaas/client-core";

export const STORAGE_SERVICE = "minio-minio";
export const CONFIG_SERVICE = "eyevinn-app-config-svc";
export const RESTREAMER_SERVICE = "datarhei-restreamer";

export interface Parameter {
  key: string;
  value: string;
  secret?: boolean;
}

export interface App {
  id: string;
  name: string;
  url: string;
  gitUrl: string;
  buildStatus?: string;
  configService?: string;
}

export interface NewApp {
  name: string;
  gitUrl: string;
  gitToken?: string;
  sourceRef?: string;
  configService: string;
  configApiKey: string;
}

/** Everything the installer needs from OSC.  Tests replace it with a fake. */
export interface Osc {
  environment: string;
  instanceExists(service: string, name: string): Promise<boolean>;
  createStorage(name: string, password: string): Promise<string>;
  removeInstance(service: string, name: string): Promise<void>;
  createParameterStore(name: string): Promise<string>;
  parameterStoreKey(name: string): Promise<string | undefined>;
  removeParameterStore(name: string): Promise<void>;
  writeParameters(store: string, apiKey: string, params: Parameter[]): Promise<void>;
  listApps(): Promise<App[]>;
  createApp(app: NewApp): Promise<App>;
  getApp(id: string): Promise<App | undefined>;
  restartApp(id: string): Promise<void>;
  removeApp(id: string): Promise<void>;
  mintToken(name: string, purpose: string): Promise<string>;
  /** Revokes every token whose name starts with prefix, except the one named keep. */
  revokeTokens(prefix: string, keep?: string): Promise<void>;
  tokensLeft(): Promise<number | undefined>;
  plan(): Promise<string | undefined>;
}

const DEPLOY = (env: string) => `https://deploy.svc.${env}.osaas.io`;
const ACCOUNT = "https://app.osaas.io/api/user/tokens";
const MONEY = "https://money.svc.prod.osaas.io";

export class OscError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function oscFor(token: string, environment = "prod"): Osc {
  const ctx = new Context({ personalAccessToken: token, environment });
  const pat = { "x-pat-jwt": `Bearer ${token}` };

  async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? pat : { ...pat, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new OscError(`${method} ${new URL(url).pathname} → ${res.status}: ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const deploy = <T>(method: string, path: string, body?: unknown) =>
    call<T>(method, DEPLOY(environment) + path, body);

  async function instance(service: string, name: string): Promise<Record<string, unknown> | undefined> {
    const sat = await ctx.getServiceAccessToken(service);
    return (await getInstance(ctx, service, name, sat)) ?? undefined;
  }

  // A store that was just created answers 404 or a gateway error until its
  // routes are up, and the parameter API sits behind it.  Retry those.
  async function configCall(url: string, init: RequestInit): Promise<Response> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      let res: Response | undefined;
      try {
        res = await fetch(url, init);
        if (res.ok || ![404, 502, 503, 504].includes(res.status)) return res;
      } catch {
        // Not reachable yet.
      }
      if (Date.now() > deadline) {
        if (res) return res;
        throw new OscError(`Parameter store at ${new URL(url).host} did not answer`);
      }
      await sleep(3000);
    }
  }

  function toApp(a: Record<string, unknown>): App {
    return {
      id: String(a.id ?? a.name),
      name: String(a.name),
      url: String(a.url ?? ""),
      gitUrl: String(a.gitUrl || a.gitHubUrl || "").split("#")[0],
      buildStatus: a.buildStatus as string | undefined,
      configService: a.configService === "undefined" ? undefined : (a.configService as string | undefined),
    };
  }

  return {
    environment,

    async instanceExists(service, name) {
      return (await instance(service, name)) !== undefined;
    },

    async createStorage(name, password) {
      const sat = await ctx.getServiceAccessToken(STORAGE_SERVICE);
      await createInstance(ctx, STORAGE_SERVICE, sat, { name, RootUser: "root", RootPassword: password });
      await waitForInstanceReady(STORAGE_SERVICE, name, ctx);
      const created = await instance(STORAGE_SERVICE, name);
      const url = created?.url;
      if (typeof url !== "string" || !url) throw new OscError(`Storage ${name} has no address`);
      return url;
    },

    async removeInstance(service, name) {
      const sat = await ctx.getServiceAccessToken(service);
      await removeInstance(ctx, service, name, sat);
    },

    async createParameterStore(name) {
      const created = await deploy<{ configApiKey?: string }>("POST", "/parameter-stores", { name, enableSecrets: true });
      if (!created?.configApiKey) throw new OscError(`Parameter store ${name} returned no API key`);
      await waitForInstanceReady(CONFIG_SERVICE, name, ctx);
      return created.configApiKey;
    },

    async parameterStoreKey(name) {
      const info = await deploy<{ configApiKey?: string }>("GET", `/parameter-stores/${encodeURIComponent(name)}`);
      return info?.configApiKey || undefined;
    },

    async removeParameterStore(name) {
      try {
        await deploy("DELETE", `/parameter-stores/${encodeURIComponent(name)}`);
      } catch (err) {
        if (!(err instanceof OscError && err.status === 404)) throw err;
      }
    },

    async writeParameters(store, apiKey, params) {
      const found = await instance(CONFIG_SERVICE, store);
      const base = typeof found?.url === "string" ? found.url.replace(/\/$/, "") : "";
      if (!base) throw new OscError(`Parameter store ${store} has no address yet`);
      const sat = await ctx.getServiceAccessToken(CONFIG_SERVICE);
      const headers = { "x-jwt": `Bearer ${sat}`, "x-config-api-key": apiKey, "Content-Type": "application/json" };
      for (const p of params) {
        const body = JSON.stringify({ key: p.key, value: p.value, secret: p.secret ?? false });
        let res = await configCall(`${base}/api/v1/config`, { method: "POST", headers, body });
        // An existing key is updated in place.
        if (res.status === 409 || res.status === 400) {
          res = await configCall(`${base}/api/v1/config/${encodeURIComponent(p.key)}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ value: p.value, secret: p.secret ?? false }),
          });
        }
        if (!res.ok) throw new OscError(`Writing ${p.key} to ${store} → ${res.status}`, res.status);
      }
    },

    async listApps() {
      const apps = await deploy<Record<string, unknown>[]>("GET", "/myapps");
      return (apps ?? []).map(toApp);
    },

    async createApp(app) {
      const body: Record<string, unknown> = {
        name: app.name,
        type: "nodejs",
        gitUrl: app.gitUrl,
        configService: app.configService,
        configApiKey: app.configApiKey,
      };
      if (app.sourceRef) body.sourceRef = app.sourceRef;
      if (app.gitToken) body.gitToken = app.gitToken;
      return toApp(await deploy<Record<string, unknown>>("POST", "/myapps", body));
    },

    async getApp(id) {
      try {
        const a = await deploy<Record<string, unknown>>("GET", `/myapps/${encodeURIComponent(id)}`);
        return a?.id || a?.name ? toApp(a) : undefined;
      } catch (err) {
        if (err instanceof OscError && err.status === 404) return undefined;
        throw err;
      }
    },

    async restartApp(id) {
      await deploy("PUT", `/myapps/${encodeURIComponent(id)}`);
    },

    async removeApp(id) {
      try {
        await deploy("DELETE", `/myapps/${encodeURIComponent(id)}`);
      } catch (err) {
        if (!(err instanceof OscError && err.status === 404)) throw err;
      }
    },

    // A token of the installation's own, so the backend does not depend on
    // the user's one-hour session token.  OSC caps it at 90 days; signing in
    // again on this page renews it.
    async mintToken(name, purpose) {
      const out = await call<{ token?: string }>("POST", ACCOUNT, { name, purpose, expiryDays: 90 });
      if (!out?.token) throw new OscError("OSC returned no token");
      return out.token;
    },

    async revokeTokens(prefix, keep) {
      const tokens = await call<{ id: string; name: string; revoked?: boolean }[]>("GET", ACCOUNT);
      for (const t of tokens ?? []) {
        if (t.name.startsWith(prefix) && t.name !== keep && !t.revoked) {
          await call("PATCH", `${ACCOUNT}/${encodeURIComponent(t.id)}`, { action: "revoke" });
        }
      }
    },

    async tokensLeft() {
      try {
        const out = await call<{ remainingTokens?: number }>("GET", `${MONEY}/mytokencount`);
        return out?.remainingTokens;
      } catch {
        return undefined;
      }
    },

    async plan() {
      try {
        const out = await call<{ plan?: string; planName?: string }>("GET", `${MONEY}/mytenantplan`);
        return out?.plan ?? out?.planName;
      } catch {
        return undefined;
      }
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
