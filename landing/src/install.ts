/**
 * Raises one club's Courtside in the club's own tenant, step by step, and
 * tears it down again.  Creates what `deploy/main.tf` creates: storage, a
 * parameter store holding every setting, and the app that is both backend and
 * website.  Restreamer is left to the backend, as there.
 */

import crypto from "node:crypto";
import { CONFIG_SERVICE, Osc, Parameter, RESTREAMER_SERVICE, STORAGE_SERVICE, sleep } from "./osc.js";

export interface Source {
  gitUrl: string;
  ref?: string;
  /** Only while the repository is private.  Never handed to tenants outside the allow-list. */
  token?: string;
  tokenTenants?: string[];
}

export interface Request {
  club: string;
  displayName: string;
  tenant: string;
}

export type Step = "check" | "storage" | "token" | "config" | "app" | "build" | "online";
export const STEPS: Step[] = ["check", "storage", "token", "config", "app", "build", "online"];

export interface Job {
  club: string;
  tenant: string;
  step: Step;
  state: "running" | "done" | "failed";
  error?: string;
  siteUrl?: string;
  setupCode?: string;
  startedAt: number;
  finishedAt?: number;
}

export function names(club: string) {
  return {
    storage: `${club}storage`,
    store: `${club}config`,
    app: `${club}api`,
    restreamer: `${club}restreamer`,
    tokenPrefix: `courtside-${club}-`,
  };
}

const CLUB = /^[a-z][a-z0-9]{2,20}$/;

/** The reason a club name cannot be used, or undefined if it can. */
export function invalidClub(club: string): string | undefined {
  if (!CLUB.test(club)) return "Namnet ska vara 3–21 små bokstäver eller siffror och börja med en bokstav.";
  return undefined;
}

/** A setup code that is easy to read aloud: no lower case, no 0/O or 1/I. */
export function setupCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  const s = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function secret(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url").replace(/[-_]/g, "").slice(0, bytes);
}

export interface Timing {
  buildTimeout: number;
  onlineTimeout: number;
  poll: number;
}

const TIMING: Timing = { buildTimeout: 15 * 60_000, onlineTimeout: 5 * 60_000, poll: 5000 };

/** Whether the token for a private repository may go to this tenant. */
function gitToken(source: Source, tenant: string): string | undefined {
  if (!source.token) return undefined;
  return source.tokenTenants?.includes(tenant) ? source.token : undefined;
}

export async function install(
  osc: Osc,
  req: Request,
  source: Source,
  job: Job,
  timing: Timing = TIMING,
  probe: (url: string) => Promise<boolean> = healthy
): Promise<void> {
  const n = names(req.club);
  // What this run has created, so a failure removes exactly that and nothing else.
  const undo: Array<() => Promise<void>> = [];

  try {
    job.step = "check";
    const invalid = invalidClub(req.club);
    if (invalid) throw new Error(invalid);
    if (source.token && !gitToken(source, req.tenant)) {
      throw new Error("Courtside kan inte installeras i det här kontot ännu: källkoden är inte publicerad.");
    }
    const apps = await osc.listApps();
    if (apps.some((a) => a.name === n.app)) throw new Error(`Det finns redan en Courtside som heter ${req.club}.`);
    if (await osc.instanceExists(STORAGE_SERVICE, n.storage)) {
      throw new Error(`Det finns redan lagring som heter ${n.storage}. Välj ett annat namn.`);
    }
    if (await osc.instanceExists(CONFIG_SERVICE, n.store)) {
      throw new Error(`Det finns redan en parameter store som heter ${n.store}. Välj ett annat namn.`);
    }

    job.step = "storage";
    const storagePassword = secret(32);
    undo.push(() => osc.removeInstance(STORAGE_SERVICE, n.storage));
    const storageEndpoint = await osc.createStorage(n.storage, storagePassword);

    job.step = "token";
    const tokenName = `${n.tokenPrefix}${Date.now().toString(36)}`;
    const oscToken = await osc.mintToken(tokenName, `Courtside ${req.club}: starts and stops Restreamer`);
    undo.push(() => osc.revokeTokens(n.tokenPrefix));

    job.step = "config";
    undo.push(() => osc.removeParameterStore(n.store));
    const apiKey = await osc.createParameterStore(n.store);
    const code = setupCode();
    const params: Parameter[] = [
      { key: "API_KEY", value: secret(48), secret: true },
      { key: "SETUP_CODE", value: code, secret: true },
      { key: "OSC_ACCESS_TOKEN", value: oscToken, secret: true },
      { key: "MINIO_SECRET_KEY", value: storagePassword, secret: true },
      { key: "OSC_TENANT", value: req.tenant },
      { key: "OSC_REGION", value: osc.environment },
      { key: "OSC_INSTANCE_NAME", value: n.restreamer },
      { key: "PROCESS_PREFIX", value: `${req.club}-` },
      { key: "MINIO_ENDPOINT", value: storageEndpoint },
      { key: "MINIO_ACCESS_KEY", value: "root" },
      { key: "STORAGE_BUCKET", value: "recordings" },
      { key: "CLUB_NAME", value: req.displayName },
    ];
    await osc.writeParameters(n.store, apiKey, params);

    job.step = "app";
    undo.push(() => osc.removeApp(n.app));
    const app = await osc.createApp({
      name: n.app,
      gitUrl: source.gitUrl,
      sourceRef: source.ref,
      gitToken: gitToken(source, req.tenant),
      configService: n.store,
      configApiKey: apiKey,
    });

    job.step = "build";
    const built = await waitForBuild(osc, app.id, timing);

    job.step = "online";
    const siteUrl = built.url.startsWith("http") ? built.url : `https://${built.url}`;
    await waitUntil(() => probe(`${siteUrl.replace(/\/$/, "")}/health`), timing.onlineTimeout, timing.poll,
      "Courtside byggdes men svarar inte. Försök igen om en stund.");

    job.siteUrl = siteUrl;
    job.setupCode = code;
    job.state = "done";
  } catch (err) {
    job.state = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    for (const step of undo.reverse()) {
      await step().catch(() => undefined);
    }
  } finally {
    job.finishedAt = Date.now();
  }
}

async function waitForBuild(osc: Osc, id: string, timing: Timing) {
  const deadline = Date.now() + timing.buildTimeout;
  // The platform reports "failed" for a while during some builds before they
  // come up, so a failure only counts once it has lasted.
  let failedSince = 0;
  for (;;) {
    const app = await osc.getApp(id).catch(() => undefined);
    if (app?.buildStatus === "running" && app.url) return app;
    if (app?.buildStatus === "failed") {
      failedSince ||= Date.now();
      if (Date.now() - failedSince > 90_000) throw new Error("Bygget av Courtside misslyckades.");
    } else {
      failedSince = 0;
    }
    if (Date.now() > deadline) throw new Error("Bygget av Courtside tog för lång tid.");
    await sleep(timing.poll);
  }
}

async function waitUntil(check: () => Promise<boolean>, timeout: number, poll: number, message: string) {
  const deadline = Date.now() + timeout;
  while (!(await check().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(poll);
  }
}

async function healthy(url: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return res.ok;
}

/** Removes a club's whole installation, recordings included. */
export async function uninstall(osc: Osc, club: string): Promise<void> {
  const n = names(club);
  const errors: string[] = [];
  const attempt = async (what: string, f: () => Promise<void>) => {
    await f().catch((err) => errors.push(`${what}: ${err instanceof Error ? err.message : err}`));
  };
  await attempt("app", () => osc.removeApp(n.app));
  await attempt("restreamer", async () => {
    if (await osc.instanceExists(RESTREAMER_SERVICE, n.restreamer)) await osc.removeInstance(RESTREAMER_SERVICE, n.restreamer);
  });
  await attempt("config", () => osc.removeParameterStore(n.store));
  await attempt("storage", () => osc.removeInstance(STORAGE_SERVICE, n.storage));
  await attempt("token", () => osc.revokeTokens(n.tokenPrefix));
  if (errors.length) throw new Error(`Allt kunde inte tas bort: ${errors.join("; ")}`);
}

/**
 * Gives the installation a fresh OSC token.  OSC caps a minted token at 90
 * days, so a club renews it by signing in here; the backend gets it at restart.
 */
export async function renewToken(osc: Osc, club: string): Promise<void> {
  const n = names(club);
  const app = (await osc.listApps()).find((a) => a.name === n.app);
  if (!app) throw new Error(`Hittar ingen Courtside som heter ${club}.`);
  const apiKey = await osc.parameterStoreKey(n.store);
  if (!apiKey) throw new Error(`Parameter storen ${n.store} saknar nyckel.`);
  const tokenName = `${n.tokenPrefix}${Date.now().toString(36)}`;
  const token = await osc.mintToken(tokenName, `Courtside ${club}: starts and stops Restreamer`);
  await osc.writeParameters(n.store, apiKey, [{ key: "OSC_ACCESS_TOKEN", value: token, secret: true }]);
  await osc.restartApp(app.id);
  await osc.revokeTokens(n.tokenPrefix, tokenName);
}

export function sameRepo(a: string, b: string): boolean {
  const norm = (u: string) => u.toLowerCase().replace(/\.git$/, "").replace(/\/$/, "");
  return norm(a) === norm(b);
}
