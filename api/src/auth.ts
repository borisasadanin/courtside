/**
 * Token stores, token creation/validation, and auth middleware.
 */
import { config, mutableConfig } from "./config.js";
import { devices } from "./state.js";

// --- Token stores ---

export const viewerTokens = new Map<string, number>(); // token -> expiresAt timestamp
export const adminTokens = new Map<string, number>(); // token -> expiresAt timestamp

// --- Token creation ---

export function createViewerToken(): string {
  const token = crypto.randomUUID();
  viewerTokens.set(token, Date.now() + config.VIEWER_TOKEN_TTL_MS);
  return token;
}

export function createAdminToken(): string {
  const token = crypto.randomUUID();
  adminTokens.set(token, Date.now() + config.ADMIN_TOKEN_TTL_MS);
  return token;
}

// --- Token validation ---

export function isValidViewerToken(token: string): boolean {
  const exp = viewerTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    viewerTokens.delete(token);
    return false;
  }
  return true;
}

export function isValidAdminToken(token: string): boolean {
  const exp = adminTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}

// --- Periodic cleanup (call once from index.ts) ---

export function startTokenCleanup(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const now = Date.now();
    for (const [token, exp] of viewerTokens) {
      if (now > exp) viewerTokens.delete(token);
    }
    for (const [token, exp] of adminTokens) {
      if (now > exp) adminTokens.delete(token);
    }
  }, 60 * 60 * 1000);
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
