/**
 * Sign-in with an OSC account: OAuth 2.0 authorization code flow with PKCE
 * against app.osaas.io.  The same flow the other OSC product pages use (Open
 * Intercom, Open Media Convert).  The client registers itself dynamically, so
 * the landing page needs no credentials of its own.
 */

import crypto from "node:crypto";

const ISSUER = "https://app.osaas.io";

interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

export interface Client {
  client_id: string;
  client_secret?: string;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

let metadata: Metadata | undefined;

async function discover(): Promise<Metadata> {
  if (metadata) return metadata;
  try {
    const res = await fetch(`${ISSUER}/.well-known/oauth-authorization-server`);
    if (res.ok) {
      metadata = (await res.json()) as Metadata;
      return metadata;
    }
  } catch {
    // Fall through to the known endpoints.
  }
  return {
    authorization_endpoint: `${ISSUER}/api/connect/authorize`,
    token_endpoint: `${ISSUER}/api/connect/token`,
    registration_endpoint: `${ISSUER}/api/connect/register`,
  };
}

// One registration per redirect URI is enough; the page serves every visitor.
const clients = new Map<string, Promise<Client>>();

export function client(redirectUri: string): Promise<Client> {
  let c = clients.get(redirectUri);
  if (!c) {
    c = register(redirectUri);
    c.catch(() => clients.delete(redirectUri));
    clients.set(redirectUri, c);
  }
  return c;
}

async function register(redirectUri: string): Promise<Client> {
  const { registration_endpoint } = await discover();
  const res = await fetch(registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Courtside",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    }),
  });
  if (!res.ok) throw new Error(`Client registration failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as Client;
}

export function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, state: crypto.randomBytes(16).toString("base64url") };
}

export async function authorizationUrl(
  c: Client,
  redirectUri: string,
  challenge: string,
  state: string
): Promise<string> {
  const { authorization_endpoint } = await discover();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: c.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${authorization_endpoint}?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const { token_endpoint } = await discover();
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as Tokens;
}

export function exchangeCode(c: Client, code: string, verifier: string, redirectUri: string): Promise<Tokens> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: c.client_id,
    code_verifier: verifier,
    ...(c.client_secret ? { client_secret: c.client_secret } : {}),
  });
}

export function refresh(c: Client, refreshToken: string): Promise<Tokens> {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: c.client_id,
    ...(c.client_secret ? { client_secret: c.client_secret } : {}),
  });
}

/** The tenant a token belongs to.  Read, not verified: OSC verifies it on every call. */
export function tenantOf(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.tenantId === "string" ? payload.tenantId : undefined;
  } catch {
    return undefined;
  }
}
