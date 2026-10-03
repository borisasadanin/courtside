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
 *   COURTSIDE_GIT_REF         branch or tag to build
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
import { install, invalidClub, Job, names, renewToken, sameRepo, Source, uninstall } from "./install.js";

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
}

const COOKIE = "courtside_session";
const SESSION_TTL = 12 * 60 * 60_000;
const sessions = new Map<string, Session>();

function session(req: FastifyRequest, reply: FastifyReply): Session {
  const id = req.cookies[COOKIE];
  const existing = id ? sessions.get(id) : undefined;
  if (existing) {
    existing.touched = Date.now();
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
    return reply.code(502).send("Kunde inte nå Open Source Cloud. Försök igen om en stund.");
  }
  const { verifier, challenge, state } = oauth.pkce();
  Object.assign(s, { verifier, state, redirectUri, returnTo: safeReturn((req.query as Record<string, unknown>).returnTo) });
  return reply.redirect(await oauth.authorizationUrl(s.client, redirectUri, challenge, state));
});

app.get("/auth/callback", async (req, reply) => {
  const s = session(req, reply);
  const { code, state } = req.query as Record<string, string | undefined>;
  if (!code || !state || state !== s.state || !s.client || !s.verifier || !s.redirectUri) {
    return reply.code(400).send("Inloggningen gick inte att slutföra. Försök igen.");
  }
  try {
    store(s, await oauth.exchangeCode(s.client, code, s.verifier, s.redirectUri));
  } catch (err) {
    req.log.error(err, "OAuth code exchange failed");
    return reply.code(502).send("Inloggningen misslyckades. Försök igen.");
  }
  const returnTo = s.returnTo ?? "/";
  s.verifier = s.state = s.returnTo = undefined;
  return reply.redirect(returnTo);
});

app.get("/auth/status", async (req, reply) => {
  const t = await token(session(req, reply));
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
  try {
    apps = await who.osc.listApps();
  } catch (err) {
    req.log.error(err, "listing apps failed");
    return reply.code(502).send({ error: "Kunde inte läsa era installationer från Open Source Cloud." });
  }
  const installed = apps
    .filter((a) => sameRepo(a.gitUrl, SOURCE.gitUrl) && a.name.endsWith("api"))
    .map((a) => ({ club: a.name.slice(0, -3), url: a.url ? (a.url.startsWith("http") ? a.url : `https://${a.url}`) : undefined, status: a.buildStatus }));
  const running = [...jobs.values()]
    .filter((j) => j.tenant === who.tenant && j.state === "running" && !installed.some((i) => i.club === j.club))
    .map((j) => ({ club: j.club, status: "installing" }));
  return { installations: [...running, ...installed] };
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

  const job: Job = { club, tenant: who.tenant, step: "check", state: "running", startedAt: Date.now() };
  jobs.set(k, job);
  // The run outlives this request.  It holds the token it was started with,
  // which lasts an hour; an installation takes about ten minutes.
  void install(who.osc, { club, displayName, tenant: who.tenant }, SOURCE, job).then(() =>
    req.log.info({ club, tenant: who.tenant, state: job.state, error: job.error }, "installation finished")
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
  return { club: j.club, step: j.step, state: j.state, error: j.error, siteUrl: j.siteUrl, setupCode: j.setupCode };
}

// Housekeeping: forget idle sessions and finished jobs.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL) sessions.delete(id);
  for (const [k, j] of jobs) if (j.finishedAt && now - j.finishedAt > JOB_TTL) jobs.delete(k);
}, 10 * 60_000).unref();

await app.listen({ port: PORT, host: "0.0.0.0" });
