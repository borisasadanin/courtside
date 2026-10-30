/**
 * Courtside's landing page and installer.
 *
 * A club signs in with its OSC account and the installer raises Courtside in
 * the club's own tenant with the club's own token — the same pattern as the
 * other OSC product pages.  Nothing is stored here beyond the browser session
 * and the progress of a running installation; restarting this app loses
 * neither an installation nor a recording.
 *
 * Needs no configuration.  Optional:
 *   PORT                      default 8080
 *   PUBLIC_URL                this page's address, if the Host header cannot be trusted
 *   COURTSIDE_GIT_URL         repository a club's app is built from
 *   COURTSIDE_GIT_REF         branch or tag to build; default the newest release tag (vX.Y.Z)
 *   COURTSIDE_GIT_TOKEN       only while the repository is private, and
 *   COURTSIDE_GIT_TOKEN_TENANTS  then only for these tenants (comma-separated)
 */

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import * as oauth from "./oauth.js";
import { oscFor } from "./osc.js";
import { isNewer, latestRelease } from "./release.js";
import { install, invalidClub, Job, maxClubLength, names, NotNow, renewToken, repair, resetAdmin, sameRepo, siteDomain, Source, uninstall, upgrade } from "./install.js";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/$/, "");
const SOURCE: Source = {
  gitUrl: process.env.COURTSIDE_GIT_URL ?? "https://github.com/borisasadanin/courtside",
  ref: process.env.COURTSIDE_GIT_REF || undefined,
  token: process.env.COURTSIDE_GIT_TOKEN || undefined,
  tokenTenants: (process.env.COURTSIDE_GIT_TOKEN_TENANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
};

// --------------------------------------------------------------- sessions

interface Session {
  token?: string;
  refreshToken?: string;
  expiresAt?: number;
  client?: oauth.Client;
  verifier?: string;
  state?: string;
  redirectUri?: string;
  returnTo?: string;
  touched: number;
  signedInAt?: number;
}

const COOKIE = "courtside_session";
/**
 * A sign-in ends after half an hour without use, and four hours after it
 * began whatever happens, so a forgotten tab on a shared computer does not
 * stay in charge of the club's OSC account.
 */
const IDLE_TTL = 30 * 60_000;
const SESSION_TTL = 4 * 60 * 60_000;
const sessions = new Map<string, Session>();

function session(req: FastifyRequest, reply: FastifyReply): Session {
  const id = req.cookies[COOKIE];
  const existing = id ? sessions.get(id) : undefined;
  if (existing) {
    const now = Date.now();
    if (existing.token && (now - existing.touched > IDLE_TTL || now - (existing.signedInAt ?? now) > SESSION_TTL)) {
      existing.token = existing.refreshToken = existing.expiresAt = existing.signedInAt = undefined;
    }
    existing.touched = now;
    return existing;
  }
  const fresh: Session = { touched: Date.now() };
  const newId = crypto.randomBytes(32).toString("base64url");
  sessions.set(newId, fresh);
  reply.setCookie(COOKIE, newId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: origin(req)?.startsWith("https:") ?? false,
    maxAge: SESSION_TTL / 1000,
  });
  return fresh;
}

/** The session's access token, refreshed if it has expired. */
async function token(s: Session): Promise<string | undefined> {
  if (!s.token) return undefined;
  if (s.expiresAt && Date.now() > s.expiresAt) {
    if (!s.refreshToken || !s.client) {
      s.token = undefined;
      return undefined;
    }
    try {
      store(s, await oauth.refresh(s.client, s.refreshToken));
    } catch {
      s.token = undefined;
      return undefined;
    }
  }
  return s.token;
}

function store(s: Session, t: oauth.Tokens) {
  s.token = t.access_token;
  if (t.refresh_token) s.refreshToken = t.refresh_token;
  s.expiresAt = t.expires_in ? Date.now() + (t.expires_in - 60) * 1000 : undefined;
}

// ------------------------------------------------------------- the server

const app = Fastify({ logger: true, trustProxy: true });
await app.register(cookie);
await app.register(fastifyStatic, {
  root: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public"),
});

app.addHook("onSend", async (_req, reply) => {
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

/** This page's own origin.  Only hosts it can legitimately be reached on. */
function origin(req: FastifyRequest): string | undefined {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.host;
  const ok = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.osaas\.io$/.test(host);
  return ok ? `${req.protocol}://${host}` : undefined;
}

/** Only paths on this page may be returned to after sign-in. */
function safeReturn(v: unknown): string {
  return typeof v === "string" && /^\/(?!\/)[^\\\s]*$/.test(v) ? v : "/";
}

/** The page the sign-in started from, with the reason it did not finish. */
function backTo(returnTo: string, reason: "denied" | "failed" | "unavailable"): string {
  return `${returnTo.split(/[?#]/)[0]}?auth=${reason}#kom-igang`;
}

app.get("/health", async () => ({ ok: true }));

app.get("/auth/signin", async (req, reply) => {
  const base = origin(req);
  if (!base) return reply.code(400).send("Okänd adress");
  const s = session(req, reply);
  const redirectUri = `${base}/auth/callback`;
  try {
    s.client = await oauth.client(redirectUri);
  } catch (err) {
    req.log.error(err, "OAuth client registration failed");
    return reply.redirect(backTo(safeReturn((req.query as Record<string, unknown>).returnTo), "unavailable"));
  }
  const { verifier, challenge, state } = oauth.pkce();
  Object.assign(s, { verifier, state, redirectUri, returnTo: safeReturn((req.query as Record<string, unknown>).returnTo) });
  return reply.redirect(await oauth.authorizationUrl(s.client, redirectUri, challenge, state));
});

// OSC sends the user back here with a GET when they approve, but posts the
// form when they press Deny. A cross-site POST carries no session cookie
// (SameSite=Lax), so the sign-in is found by its state rather than the cookie.
app.addContentTypeParser(
  "application/x-www-form-urlencoded",
  { parseAs: "string" },
  (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
);

function pendingSignIn(state: string | undefined): Session | undefined {
  if (!state) return undefined;
  for (const s of sessions.values()) if (s.state === state) return s;
  return undefined;
}

async function callback(req: FastifyRequest, reply: FastifyReply) {
  const params = {
    ...(req.query as Record<string, string | undefined>),
    ...((req.body as Record<string, string | undefined> | undefined) ?? {}),
  };
  const { code, state, error } = params;
  const s = pendingSignIn(state) ?? session(req, reply);
  const returnTo = s.returnTo ?? "/";
  const valid = !!code && !!state && state === s.state && !!s.client && !!s.verifier && !!s.redirectUri;
  // 303 so a POST is followed by a GET of the page, not a re-post.
  if (!valid) {
    // The user pressed Deny on OSC's consent page (error=access_denied), or
    // the session expired on the way. Back to the page, which explains it.
    s.verifier = s.state = s.returnTo = undefined;
    return reply.redirect(backTo(returnTo, error === "access_denied" ? "denied" : "failed"), 303);
  }
  try {
    store(s, await oauth.exchangeCode(s.client!, code!, s.verifier!, s.redirectUri!));
    s.signedInAt = Date.now();
  } catch (err) {
    req.log.error(err, "OAuth code exchange failed");
    s.verifier = s.state = s.returnTo = undefined;
    return reply.redirect(backTo(returnTo, "failed"), 303);
  }
  s.verifier = s.state = s.returnTo = undefined;
  return reply.redirect(returnTo, 303);
}

app.get("/auth/callback", callback);
app.post("/auth/callback", callback);

app.get("/auth/status", async (req, reply) => {
  // Every page asks this on load. A visitor who has not signed in gets no
  // cookie just for looking: only a session that already exists is read.
  const id = req.cookies[COOKIE];
  const t = id && sessions.has(id) ? await token(session(req, reply)) : undefined;
  return { authenticated: !!t, tenant: t ? oauth.tenantOf(t) : undefined };
});

app.post("/auth/signout", async (req, reply) => {
  const id = req.cookies[COOKIE];
  if (id) sessions.delete(id);
  reply.clearCookie(COOKIE, { path: "/" });
  return { ok: true };
});

// ------------------------------------------------------- installations

// Progress of running and recently finished installations, per tenant.  Kept
// in memory: an installation in progress is lost if this app restarts, but
// whatever it created is then visible in the club's tenant and can be removed.
const jobs = new Map<string, Job>();
const key = (tenant: string, club: string) => `${tenant}/${club}`;
const JOB_TTL = 60 * 60_000;

async function signedIn(req: FastifyRequest, reply: FastifyReply) {
  const t = await token(session(req, reply));
  const tenant = t ? oauth.tenantOf(t) : undefined;
  if (!t || !tenant) {
    reply.code(401).send({ error: "Logga in igen." });
    return undefined;
  }
  return { token: t, tenant, osc: oscFor(t) };
}

app.get("/api/account", async (req, reply) => {
  const who = await signedIn(req, reply);
  if (!who) return;
  const [tokensLeft, plan] = await Promise.all([who.osc.tokensLeft(), who.osc.plan()]);
  return { tenant: who.tenant, tokensLeft, plan };
});

app.get("/api/installations", async (req, reply) => {
  const who = await signedIn(req, reply);
  if (!who) return;
  let apps;
  let domains = new Map<string, string[]>();
  // Without it the list still shows, only without an offer to update.
  const latest = releaseToOffer().catch(() => undefined);
  try {
    [apps, domains] = await Promise.all([who.osc.listApps(), who.osc.listDomains().catch(() => domains)]);
  } catch (err) {
    req.log.error(err, "listing apps failed");
    return reply.code(502).send({ error: "Kunde inte läsa era installationer från Open Source Cloud." });
  }
  const installed = apps
    .filter((a) => sameRepo(a.gitUrl, SOURCE.gitUrl) && a.name.endsWith("api"))
    .map((a) => {
      const club = a.name.slice(0, -3);
      // The club's own address when it has one, else the platform's.
      const own = domains.get(a.name)?.find((d) => d === siteDomain(club, who.osc.environment));
      const url = own ? `https://${own}` : a.url ? (a.url.startsWith("http") ? a.url : `https://${a.url}`) : undefined;
      return { club, url, own: !!own, address: siteDomain(club, who.osc.environment), status: a.buildStatus, version: a.sourceRef };
    });
  const offer = await latest;
  for (const i of installed) Object.assign(i, { upgradeTo: offer && i.version !== offer && isNewer(offer, i.version) ? offer : undefined });
  const running = [...jobs.values()]
    .filter((j) => j.tenant === who.tenant && j.state === "running" && !installed.some((i) => i.club === j.club))
    .map((j) => ({ club: j.club, status: "installing" }));
  return { installations: [...running, ...installed] };
});

// Gives an installation its own address (club.apps.osaas.io) afterwards:
// for one made before installations got one, or where it was not free or did
// not answer in time when it was made.
app.post("/api/installations/:club/address", async (req, reply) => {
  const who = await signedIn(req, reply);
  if (!who) return;
  const { club } = req.params as { club: string };
  if (invalidClub(club)) return reply.code(400).send({ error: "Okänt namn." });
  const domain = siteDomain(club, who.osc.environment);
  try {
    const app = (await who.osc.listApps()).find((a) => a.name === names(club).app && sameRepo(a.gitUrl, SOURCE.gitUrl));
    if (!app) return reply.code(404).send({ error: `Hittar ingen Courtside som heter ${club}.` });
    if ((await who.osc.listDomains()).get(app.name)?.includes(domain)) return { url: `https://${domain}` };
    if (club.length > maxClubLength(who.tenant)) {
      return reply.code(409).send({ error: `Kortnamnet ${club} är för långt för en egen adress i ert konto, där högst ${maxClubLength(who.tenant)} tecken får plats. Plattformen fungerar på sin nuvarande adress.` });
    }
    if (!(await who.osc.domainAvailable(domain))) {
      return reply.code(409).send({ error: `Adressen ${domain} är redan tagen av någon annan. Plattformen fungerar på sin nuvarande adress.` });
    }
    await who.osc.addDomain(app.name, domain);
    return { url: `https://${domain}` };
  } catch (err) {
    req.log.error(err, "adding address failed");
    return reply.code(502).send({ error: "Det gick inte att ge plattformen en egen adress just nu. Försök igen om en stund." });
  }
});

// Moves an installation to the newest release.  Only ever forward: going
// back is for when a release goes wrong, and is done in OSC by hand.
app.post("/api/installations/:club/upgrade", async (req, reply) => {
  const who = await signedIn(req, reply);
  if (!who) return;
  const { club } = req.params as { club: string };
  if (invalidClub(club)) return reply.code(400).send({ error: "Okänt namn." });
  let to: string | undefined;
  try {
    to = await releaseToOffer();
  } catch (err) {
    req.log.error(err, "reading releases failed");
    return reply.code(503).send({ error: "Kunde inte läsa vilken version av Courtside som är senast. Försök igen om en stund." });
  }
  if (!to) return reply.code(409).send({ error: "Det finns ingen version att uppdatera till." });
  try {
    await upgrade(who.osc, club, to);
    req.log.info({ club, tenant: who.tenant, to }, "upgrade started");
    return reply.code(202).send({ version: to });
  } catch (err) {
    if (err instanceof NotNow) return reply.code(409).send({ error: err.message });
    req.log.error(err, "upgrade failed");
    return reply.code(502).send({ error: "Uppdateringen kunde inte startas. Försök igen om en stund." });
  }
});

/** The version a new or updated installation gets. */
async function releaseToOffer(): Promise<string | undefined> {
  return SOURCE.ref ?? (await latestRelease(SOURCE.gitUrl, SOURCE.token));
}

// Whether a short name is free, as the club types it: both the address,
// shared by every OSC account, and the names in this account.
app.get("/api/available/:club", async (req, reply) => {
  const who = await signedIn(req, reply);
  if (!who) return;
  const { club } = req.params as { club: string };
  const domain = siteDomain(club, who.osc.environment);
  if (invalidClub(club)) return { club, domain, available: false, reason: invalidClub(club) };
  const max = maxClubLength(who.tenant);
  if (club.length > max) return { club, domain, available: false, tooLong: max, reason: `Kortnamnet får vara högst ${max} tecken i ert konto.` };
  try {
    const [free, apps] = await Promise.all([who.osc.domainAvailable(domain), who.osc.listApps()]);
    if (apps.some((a) => a.name === names(club).app)) return { club, domain, available: false, reason: `Ni har redan en Courtside som heter ${club}.` };
    if (!free) return { club, domain, available: false, reason: `Adressen ${domain} är redan tagen.` };
    return { club, domain, available: true };
  } catch {
    return { club, domain, available: undefined };
  }
});

app.post("/api/installations", async (req, reply) => {
  const who = await signedIn(req, reply);
  if (!who) return;
  const body = (req.body ?? {}) as { club?: unknown; displayName?: unknown };
  const club = String(body.club ?? "").trim().toLowerCase();
  const displayName = String(body.displayName ?? "").trim().slice(0, 80);
  const invalid = invalidClub(club);
  if (invalid) return reply.code(400).send({ error: invalid });
  if (!displayName) return reply.code(400).send({ error: "Skriv föreningens namn." });

  const k = key(who.tenant, club);
  if (jobs.get(k)?.state === "running") return reply.code(409).send({ error: "Installationen pågår redan." });

  const tokensLeft = await who.osc.tokensLeft();
  if (tokensLeft !== undefined && tokensLeft < 40) {
    return reply.code(402).send({ error: "Kontot har för få tokens kvar. Courtside behöver runt 40 tokens per dygn." });
  }

  // A new club gets the newest release, not the latest push.
  let ref: string | undefined;
  try {
    ref = await releaseToOffer();
  } catch (err) {
    req.log.error(err, "reading releases failed");
    return reply.code(503).send({ error: "Kunde inte läsa vilken version av Courtside som är senast. Försök igen om en stund." });
  }

  const job: Job = { club, tenant: who.tenant, step: "check", state: "running", startedAt: Date.now() };
  jobs.set(k, job);
  // The run outlives this request.  It holds the token it was started with,
  // which lasts an hour; an installation takes about ten minutes.
  void install(who.osc, { club, displayName, tenant: who.tenant }, { ...SOURCE, ref }, job).then(() =>
    req.log.info({ club, tenant: who.tenant, ref, state: job.state, error: job.error }, "installation finished")
  );
  return reply.code(202).send(publicJob(job));
});

app.get("/api/installations/:club/job", async (req, reply) => {
  const who = await signedIn(req, reply);
  if (!who) return;
  const job = jobs.get(key(who.tenant, (req.params as { club: string }).club));
  if (!job) return reply.code(404).send({ error: "Ingen installation pågår." });
  return publicJob(job);
});

app.post("/api/installations/:club/renew", async (req, reply) => {
  const who = await signedIn(req, reply);
  if (!who) return;
  const { club } = req.params as { club: string };
  if (invalidClub(club)) return reply.code(400).send({ error: "Okänt namn." });
  try {
    await renewToken(who.osc, club);
    return { ok: true };
  } catch (err) {
    req.log.error(err, "token renewal failed");
    return reply.code(502).send({ error: err instanceof Error ? err.message : "Förnyelsen misslyckades." });
  }
});

app.post("/api/installations/:club/reset-admin", async (req, reply) => {
  const who = await signedIn(req, reply);
  if (!who) return;
  const { club } = req.params as { club: string };
  if (invalidClub(club)) return reply.code(400).send({ error: "Okänt namn." });
  try {
    return { setupCode: await resetAdmin(who.osc, club) };
  } catch (err) {
    req.log.error(err, "admin reset failed");
    return reply.code(502).send({ error: err instanceof Error ? err.message : "Återställningen misslyckades." });
  }
});

// Writes the settings back when a platform's parameter store has lost them.
app.post("/api/installations/:club/repair", async (req, reply) => {
  const who = await signedIn(req, reply);
  if (!who) return;
  const { club } = req.params as { club: string };
  if (invalidClub(club)) return reply.code(400).send({ error: "Okänt namn." });
  try {
    const setupCode = await repair(who.osc, club, who.tenant);
    req.log.info({ club, tenant: who.tenant }, "platform repaired");
    return { setupCode };
  } catch (err) {
    req.log.error(err, "repair failed");
    return reply.code(502).send({ error: err instanceof Error ? err.message : "Reparationen misslyckades." });
  }
});

app.delete("/api/installations/:club", async (req, reply) => {
  const who = await signedIn(req, reply);
  if (!who) return;
  const { club } = req.params as { club: string };
  const confirm = String(((req.body ?? {}) as { confirm?: unknown }).confirm ?? "");
  if (invalidClub(club)) return reply.code(400).send({ error: "Okänt namn." });
  if (confirm !== club) return reply.code(400).send({ error: `Skriv ${club} för att bekräfta.` });
  if (jobs.get(key(who.tenant, club))?.state === "running") {
    return reply.code(409).send({ error: "Vänta tills installationen är klar." });
  }
  try {
    await uninstall(who.osc, club);
    jobs.delete(key(who.tenant, club));
    return { ok: true, removed: names(club) };
  } catch (err) {
    req.log.error(err, "uninstall failed");
    return reply.code(502).send({ error: err instanceof Error ? err.message : "Borttagningen misslyckades." });
  }
});

function publicJob(j: Job) {
  return {
    club: j.club,
    step: j.step,
    state: j.state,
    error: j.error,
    reason: j.reason,
    retrying: j.retrying,
    // Whether it got its own address, or the platform's numbered one.
    own: !!j.siteUrl && new URL(j.siteUrl).hostname.startsWith(`${j.club}.apps.`),
    // Measured here, so a wrong clock on the user's computer does not matter.
    elapsed: (j.finishedAt ?? Date.now()) - j.startedAt,
    siteUrl: j.siteUrl,
    setupCode: j.setupCode,
  };
}

// Housekeeping: forget idle sessions and finished jobs.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL) sessions.delete(id);
  for (const [k, j] of jobs) if (j.finishedAt && now - j.finishedAt > JOB_TTL) jobs.delete(k);
}, 10 * 60_000).unref();

await app.listen({ port: PORT, host: "0.0.0.0" });
