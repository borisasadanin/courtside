/**
 * Token stores, token creation/validation, and auth middleware.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config, mutableConfig } from "./config.js";
import { devices } from "./state.js";

// --- Session tokens ---
//
// Signed rather than remembered, so a session outlives a restart: an update
// or a redeploy must not quietly log out every viewer and the admin, leaving
// an admin view whose saves all fail. The PIN is part of the signing key, so
// changing a PIN still ends every session made with the old one.

type Role = "viewer" | "admin";

function sign(payload: string, role: Role): string {
  const pin = role === "admin" ? mutableConfig.ADMIN_PIN : mutableConfig.VIEWER_PIN;
  return createHmac("sha256", `${config.API_KEY}\0${pin}`).update(payload).digest("base64url");
}

/** role.expiresAt.nonce.signature */
function createToken(role: Role, ttlMs: number): string {
  const payload = `${role}.${Date.now() + ttlMs}.${randomBytes(9).toString("base64url")}`;
  return `${payload}.${sign(payload, role)}`;
}

function isValidToken(token: string, role: Role): boolean {
  const [r, expText, nonce, sig, ...rest] = token.split(".");
  if (r !== role || !nonce || !sig || rest.length) return false;
  const exp = Number(expText);
  if (!Number.isSafeInteger(exp) || Date.now() > exp) return false;
  const expected = Buffer.from(sign(`${r}.${expText}.${nonce}`, role));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createViewerToken(): string {
  return createToken("viewer", config.VIEWER_TOKEN_TTL_MS);
}

export function createAdminToken(): string {
  return createToken("admin", config.ADMIN_TOKEN_TTL_MS);
}

export function isValidViewerToken(token: string): boolean {
  return isValidToken(token, "viewer");
}

export function isValidAdminToken(token: string): boolean {
  return isValidToken(token, "admin");
}

// --- Auth middleware ---

type RequestLike = { headers: Record<string, string | string[] | undefined> };
type ReplyLike = { code: (n: number) => { send: (o: unknown) => void } };

export function requireApiKey(request: RequestLike, reply: ReplyLike): boolean {
  const key = request.headers["x-api-key"];
  if (!config.API_KEY || key !== config.API_KEY) {
    reply.code(401).send({ error: "Invalid or missing API key" });
    return false;
  }
  return true;
}

/**
 * Permission to broadcast: a paired camera's own token, or the installation's
 * API key.
 *
 * Cameras authenticate with a device token so one can be revoked without
 * touching the others, and so the app does not need the key compiled in. The
 * API key still works, for scripts and for an installation that has not paired
 * anything yet.
 */
export async function requireBroadcasterAuth(
  request: RequestLike,
  reply: ReplyLike
): Promise<boolean> {
  const key = request.headers["x-api-key"];
  if (config.API_KEY && key === config.API_KEY) return true;

  const header = request.headers["x-device-token"];
  const token = typeof header === "string" ? header : "";
  if (token) {
    const device = await devices.verify(token);
    if (device) {
      void devices.touch(device);
      return true;
    }
  }

  reply.code(401).send({
    error: "not_paired",
    message: "Kameran är inte parad med den här installationen.",
  });
  return false;
}

/**
 * Viewer access, or a paired camera. The camera shows its own viewer count, and
 * it should not need the viewer PIN for that.
 */
export async function requireViewerOrBroadcasterAuth(
  request: RequestLike,
  reply: ReplyLike
): Promise<boolean> {
  const header = request.headers["x-device-token"];
  if (typeof header === "string" && header && (await devices.verify(header))) return true;
  return requireViewerAuth(request, reply);
}

/** Check API key OR valid viewer token. Returns true if authorized. */
export function requireViewerAuth(request: RequestLike, reply: ReplyLike): boolean {
  // No PIN configured -> open access
  if (!mutableConfig.VIEWER_PIN) return true;

  // API key always works (for the iOS app)
  const key = request.headers["x-api-key"];
  if (config.API_KEY && key === config.API_KEY) return true;

  // Check viewer token from Authorization header
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (isValidViewerToken(token)) return true;
  }

  reply.code(401).send({ error: "Åtkomst nekad. Ange kod för att titta." });
  return false;
}

/** Check admin token from X-Admin-Token header. Returns true if authorized. */
export function requireAdminAuth(request: RequestLike, reply: ReplyLike): boolean {
  const token = request.headers["x-admin-token"];
  if (typeof token === "string" && isValidAdminToken(token)) return true;

  // API key also works as admin
  const key = request.headers["x-api-key"];
  if (config.API_KEY && key === config.API_KEY) return true;

  reply.code(401).send({ error: "Admin-åtkomst krävs" });
  return false;
}
