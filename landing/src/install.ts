/**
 * Raises one club's Courtside in the club's own tenant, step by step, and
 * tears it down again.  Creates what `deploy/main.tf` creates: storage, a
 * parameter store holding every setting, and the app that is both backend and
 * website.  Restreamer is left to the backend, as there.
 */

import crypto from "node:crypto";
import { CONFIG_SERVICE, Osc, OscError, Parameter, RESTREAMER_SERVICE, STORAGE_SERVICE, sleep } from "./osc.js";

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

export type Reason = "taken" | "source" | "build" | "slow" | "unreachable" | "signin" | "unknown";

/** A failure the installer understands, with what the user can do about it. */
export class InstallError extends Error {
  constructor(message: string, readonly reason: Reason) {
    super(message);
  }
}

function reasonOf(err: unknown): Reason {
  if (err instanceof InstallError) return err.reason;
  if (err instanceof OscError && (err.status === 401 || err.status === 403)) return "signin";
  if (err instanceof OscError && err.status !== undefined && (err.status === 429 || err.status >= 500)) return "unreachable";
  return "unknown";
}

export interface Job {
  club: string;
  tenant: string;
  step: Step;
  state: "running" | "done" | "failed";
  error?: string;
  /** Why it failed, so the page can say what to do about it. */
  reason?: Reason;
  /** The first build failed and is being tried again. */
  retrying?: boolean;
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

/**
 * The club's own address on the platform, e.g. myclub.apps.osaas.io.  These
 * names are shared by every OSC tenant, so one is only ever handed out once.
 */
export function siteDomain(club: string, environment = "prod"): string {
  return environment === "prod" ? `${club}.apps.osaas.io` : `${club}.apps.${environment}.osaas.io`;
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
  /** How long "failed" lasts before the app is rebuilt once. */
  rebuildAfter: number;
  /** How long "failed" must last, after that rebuild, before it is believed. */
  failedGrace: number;
}

const TIMING: Timing = {
  buildTimeout: 15 * 60_000,
  onlineTimeout: 5 * 60_000,
  poll: 5000,
  rebuildAfter: 60_000,
  failedGrace: 4 * 60_000,
};

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
  // Work started but not yet awaited, settled before anything is undone.
  const inFlight: Promise<unknown>[] = [];
  let stepStart = Date.now();
  const lap = () => console.log(JSON.stringify({ msg: "install step", club: req.club, step: job.step, ms: Date.now() - stepStart }));
  const at = (step: Job["step"]) => {
    lap();
    job.step = step;
    stepStart = Date.now();
  };

  try {
    job.step = "check";
    const invalid = invalidClub(req.club);
    if (invalid) throw new InstallError(invalid, "taken");
    if (source.token && !gitToken(source, req.tenant)) {
      throw new InstallError("Courtside kan inte installeras i det här kontot ännu: källkoden är inte publicerad.", "source");
    }
    const apps = await osc.listApps();
    if (apps.some((a) => a.name === n.app)) throw new InstallError(`Det finns redan en Courtside som heter ${req.club}.`, "taken");
    if (await osc.instanceExists(STORAGE_SERVICE, n.storage)) {
      throw new InstallError(`Det finns redan lagring som heter ${n.storage}. Välj ett annat namn.`, "taken");
    }
    if (await osc.instanceExists(CONFIG_SERVICE, n.store)) {
      throw new InstallError(`Det finns redan en parameter store som heter ${n.store}. Välj ett annat namn.`, "taken");
    }
    const domain = siteDomain(req.club, osc.environment);
    // Unknown is not a no: if the check itself fails, the address is tried
    // after the build and the platform's own address is used if it is taken.
    if ((await osc.domainAvailable(domain).catch(() => true)) === false) {
      throw new InstallError(`Adressen ${domain} är redan tagen. Välj ett annat kortnamn.`, "taken");
    }

    // Storage and the parameter store each take a minute or two to come up
    // and do not depend on each other, so both are created at once.
    at("storage");
    const storagePassword = secret(32);
    undo.push(() => osc.removeInstance(STORAGE_SERVICE, n.storage));
    const storage = osc.createStorage(n.storage, storagePassword);
    undo.push(() => osc.removeParameterStore(n.store));
    const store = osc.createParameterStore(n.store);
    inFlight.push(storage, store);
    for (const p of inFlight) p.catch(() => undefined);

    const tokenName = `${n.tokenPrefix}${Date.now().toString(36)}`;
    undo.push(() => osc.revokeTokens(n.tokenPrefix));
    const oscToken = await osc.mintToken(tokenName, `Courtside ${req.club}: starts and stops Restreamer`);
    const [storageEndpoint, apiKey] = await Promise.all([storage, store]);

    at("config");
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

    at("app");
    undo.push(() => osc.removeApp(n.app));
    const app = await osc.createApp({
      name: n.app,
      gitUrl: source.gitUrl,
      sourceRef: source.ref,
      gitToken: gitToken(source, req.tenant),
      configService: n.store,
      configApiKey: apiKey,
    });

    at("build");
    const built = await waitForBuild(osc, app.id, timing, probe, () => (job.retrying = true));

    at("online");
    const siteUrl = built.url.startsWith("http") ? built.url : `https://${built.url}`;
    await waitUntil(() => probe(`${siteUrl.replace(/\/$/, "")}/health`), timing.onlineTimeout, timing.poll,
      new InstallError("Courtside byggdes men svarar inte.", "slow"));

    job.siteUrl = (await ownAddress(osc, n.app, domain, undo, timing, probe)) ?? siteUrl;
    job.setupCode = code;
    lap();
    job.state = "done";
  } catch (err) {
    job.state = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    job.reason = reasonOf(err);
    console.log(JSON.stringify({ msg: "install failed", club: req.club, step: job.step, error: job.error }));
    await Promise.allSettled(inFlight);
    for (const step of undo.reverse()) {
      await step().catch(() => undefined);
    }
  } finally {
    job.finishedAt = Date.now();
  }
}

/**
 * Gives the app its own address.  Never fails the installation: if the name
 * was taken in the meantime or does not answer in time, the platform's own
 * address is used instead.
 */
async function ownAddress(
  osc: Osc,
  app: string,
  domain: string,
  undo: Array<() => Promise<void>>,
  timing: Timing,
  probe: (url: string) => Promise<boolean>
): Promise<string | undefined> {
  try {
    await osc.addDomain(app, domain);
  } catch {
    return undefined;
  }
  undo.push(() => osc.removeDomain(app, domain));
  const url = `https://${domain}`;
  try {
    await waitUntil(() => probe(`${url}/health`), timing.onlineTimeout, timing.poll, new InstallError("", "slow"));
    return url;
  } catch {
    return undefined;
  }
}

async function waitForBuild(
  osc: Osc,
  id: string,
  timing: Timing,
  probe: (url: string) => Promise<boolean>,
  onRebuild: () => void
) {
  const deadline = Date.now() + timing.buildTimeout;
  // The platform reports "failed" for minutes during some first builds that
  // then come up fine, so the status alone is not trusted: an app that answers
  // on /health is built, whatever the status says, and a failure only counts
  // once it has lasted well past that.
  let failedSince = 0;
  let rebuilt = false;
  for (;;) {
    const app = await osc.getApp(id).catch(() => undefined);
    if (app?.url) {
      const url = app.url.startsWith("http") ? app.url : `https://${app.url}`;
      if (app.buildStatus === "running" || (await probe(`${url.replace(/\/$/, "")}/health`).catch(() => false))) {
        return app;
      }
    }
    if (app?.buildStatus === "failed") {
      failedSince ||= Date.now();
      // A first build that fails usually started before something it needs
      // was reachable.  One fresh rebuild fixes that, in far less time than
      // waiting for the platform to try again by itself.
      if (!rebuilt && Date.now() - failedSince > timing.rebuildAfter) {
        rebuilt = true;
        onRebuild();
        console.log(JSON.stringify({ msg: "build failed, rebuilding once", app: id }));
        await osc.restartApp(id, true).catch(() => undefined);
        failedSince = 0;
      } else if (Date.now() - failedSince > timing.failedGrace) {
        console.error(JSON.stringify({ msg: "build failed", app }));
        throw new InstallError("Bygget av Courtside misslyckades.", "build");
      }
    } else {
      failedSince = 0;
    }
    if (Date.now() > deadline) throw new InstallError("Bygget av Courtside tog för lång tid.", "slow");
    await sleep(timing.poll);
  }
}

async function waitUntil(check: () => Promise<boolean>, timeout: number, poll: number, failure: Error) {
  const deadline = Date.now() + timeout;
  while (!(await check().catch(() => false))) {
    if (Date.now() > deadline) throw failure;
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
  await attempt("address", () => osc.removeDomain(n.app, siteDomain(club, osc.environment)));
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

/**
 * Lets the owner back into a club's admin view, whatever they forgot.  A new
 * setup code reopens first-run setup when the backend restarts; the viewer PIN
 * and every recording stay as they are.  Signing in with the OSC account that
 * owns the installation is the proof of ownership, so nobody else — Eyevinn
 * included — is needed for this.
 */
export async function resetAdmin(osc: Osc, club: string): Promise<string> {
  const n = names(club);
  const app = (await osc.listApps()).find((a) => a.name === n.app);
  if (!app) throw new Error(`Hittar ingen Courtside som heter ${club}.`);
  const apiKey = await osc.parameterStoreKey(n.store);
  if (!apiKey) throw new Error(`Parameter storen ${n.store} saknar nyckel.`);
  const code = setupCode();
  await osc.writeParameters(n.store, apiKey, [{ key: "SETUP_CODE", value: code, secret: true }]);
  await osc.restartApp(app.id);
  return code;
}

export function sameRepo(a: string, b: string): boolean {
  const norm = (u: string) => u.toLowerCase().replace(/\.git$/, "").replace(/\/$/, "");
  return norm(a) === norm(b);
}
