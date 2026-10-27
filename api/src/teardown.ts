/**
 * Removes this whole installation from the club's OSC account, from the admin
 * view: every recording and setting, the Restreamer, the storage, the
 * parameter store, the app itself and its OSC tokens.
 *
 * Only an installation made from the Courtside page qualifies.  Its resources
 * carry fixed names derived from the club's short name (see
 * landing/src/install.ts), and the app must be found under that name using
 * that parameter store before anything is touched.  Anything else is left
 * alone and the admin is told to remove it in OSC.
 */

import { Context, getInstance, removeInstance } from "@osaas/client-core";
import { config } from "./config.js";
import type { MinioClient } from "./minio.js";

const STORAGE_SERVICE = "minio-minio";
const RESTREAMER_SERVICE = "datarhei-restreamer";
const ACCOUNT = "https://app.osaas.io/api/user/tokens";

export interface Plan {
  club: string;
  app: { id: string; name: string };
  store: string;
  storage: string;
  restreamer: string;
  tokenPrefix: string;
}

export interface Removed {
  what: string;
  ok: boolean;
  detail?: string;
}

/** The club's short name, from the process prefix the installer sets ("myclub-"). */
export function clubOf(prefix: string): string | undefined {
  const m = /^([a-z][a-z0-9]{2,20})-$/.exec(prefix);
  return m?.[1];
}

function deployBase(): string {
  return `https://deploy.svc.${config.OSC_REGION}.osaas.io`;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "x-pat-jwt": `Bearer ${config.OSC_PAT}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok && !(method === "DELETE" && res.status === 404)) {
    throw new Error(`${method} ${new URL(url).pathname} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** What would be removed, or the reason this installation cannot remove itself. */
export async function plan(): Promise<Plan | string> {
  const club = clubOf(config.PROCESS_PREFIX);
  if (!club) {
    return "Den här installationen gjordes inte från Courtside-sidan och kan inte ta bort sig själv. Ta bort den i Open Source Cloud.";
  }
  const name = `${club}api`;
  const store = `${club}config`;
  const apps = await call<Record<string, unknown>[]>("GET", `${deployBase()}/myapps`);
  const own = (apps ?? []).find((a) => a.name === name);
  if (!own || own.configService !== store) {
    return `Hittar ingen Courtside-app som heter ${name} med inställningarna ${store}. Ta bort den i Open Source Cloud.`;
  }
  return {
    club,
    app: { id: String(own.id ?? own.name), name },
    store,
    storage: `${club}storage`,
    restreamer: config.OSC_INSTANCE_NAME,
    tokenPrefix: `courtside-${club}-`,
  };
}

/**
 * Everything but the app and its tokens.  Each step runs even if an earlier
 * one failed, so as much as possible is gone either way.
 */
export async function removeData(p: Plan, minio: MinioClient): Promise<Removed[]> {
  const ctx = new Context({ personalAccessToken: config.OSC_PAT, environment: config.OSC_REGION });
  const out: Removed[] = [];
  const step = async (what: string, f: () => Promise<string | void>) => {
    try {
      out.push({ what, ok: true, detail: (await f()) || undefined });
    } catch (err) {
      out.push({ what, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  await step("Inspelningar, klipp, inställningar och koder", async () => {
    const n = await minio.deleteEverything();
    return `${n} filer raderade`;
  });
  await step(`Sändningsmotorn (${p.restreamer})`, async () => {
    const sat = await ctx.getServiceAccessToken(RESTREAMER_SERVICE);
    if (!(await getInstance(ctx, RESTREAMER_SERVICE, p.restreamer, sat))) return "var redan avstängd";
    await removeInstance(ctx, RESTREAMER_SERVICE, p.restreamer, sat);
  });
  await step(`Lagringen (${p.storage})`, async () => {
    const sat = await ctx.getServiceAccessToken(STORAGE_SERVICE);
    await removeInstance(ctx, STORAGE_SERVICE, p.storage, sat);
  });
  await step(`Inställningar och lösenord (${p.store})`, async () => {
    await call("DELETE", `${deployBase()}/parameter-stores/${encodeURIComponent(p.store)}`);
  });
  return out;
}

/**
 * The app, then its OSC tokens.  Runs after the admin has had the answer:
 * removing the app stops this process, which keeps running just long enough
 * for the token calls.  The newest token is the one in use, so it goes last.
 */
export async function removeSelf(p: Plan, log: { error: (...a: unknown[]) => void }): Promise<void> {
  try {
    await call("DELETE", `${deployBase()}/myapps/${encodeURIComponent(p.app.id)}`);
  } catch (err) {
    log.error(err, "removing own app failed");
  }
  try {
    const tokens = await call<{ id: string; name: string; revoked?: boolean }[]>("GET", ACCOUNT);
    const ours = (tokens ?? []).filter((t) => t.name.startsWith(p.tokenPrefix) && !t.revoked).sort((a, b) => a.name.localeCompare(b.name));
    for (const t of ours) await call("PATCH", `${ACCOUNT}/${encodeURIComponent(t.id)}`, { action: "revoke" });
  } catch (err) {
    log.error(err, "revoking own tokens failed");
  }
}
