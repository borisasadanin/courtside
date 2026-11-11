/**
 * Camera pairing.
 *
 * An admin opens the club's own admin view, which asks for a pairing code and
 * shows it along with this installation's address.  The camera app — one build
 * from the App Store, with no club baked into it — reads both and exchanges the
 * code for its own token.
 *
 * The code is the capability, so it is short-lived, single-use and rate
 * limited.  Pairing needs no admin credentials of its own: whoever can see the
 * code on the admin screen is the person holding the phone.
 */
import type { FastifyInstance } from "fastify";
import { requireAdminAuth } from "../auth.js";
import { devices } from "../state.js";
import { normaliseDeviceName } from "../devices.js";
import { clubManifest } from "../club-config.js";

/** The app's URL scheme, registered in camera/CourtsideCamera/Info.plist. */
export function pairingLink(apiUrl: string, code: string): string {
  return `courtside-camera://pair?url=${encodeURIComponent(apiUrl)}&code=${encodeURIComponent(code)}`;
}

/**
 * Where an invite sends the person who receives it: the landing site's /join
 * page, which explains how to get the app and opens it paired.  Everything
 * after # stays in the browser, so the code never reaches the landing site's
 * server or its logs.  One landing page serves every installation, because the
 * installation's address travels in the link.
 */
export const JOIN_PAGE_URL = "https://courtside.apps.osaas.io/join/";

export function inviteLink(apiUrl: string, code: string, club: string): string {
  const params = new URLSearchParams({ u: apiUrl, c: code, n: club });
  return `${JOIN_PAGE_URL}#${params.toString()}`;
}

/** How this backend is reached, as the request saw it. */
function apiUrlOf(request: { headers: Record<string, unknown>; protocol: string }): string {
  const proto = (request.headers["x-forwarded-proto"] as string) || request.protocol;
  const host = (request.headers["x-forwarded-host"] as string) || (request.headers.host as string);
  return `${proto}://${host}`;
}

export default async function deviceRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/devices/pairing-code — admin asks for a code to show on screen
  app.post("/api/devices/pairing-code", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;

    const { code, expiresAt } = devices.createPairingCode();

    // The camera needs to know which installation to talk to, and only the
    // request knows how this backend is actually reached.
    const apiUrl = apiUrlOf(request);

    return reply.send({
      code,
      expiresAt,
      apiUrl,
      club: clubManifest.name,
      /**
       * What the QR code should contain: a link the camera app is registered
       * for, so the phone's own camera opens the app instead of the website.
       */
      payload: pairingLink(apiUrl, code),
    });
  });

  // POST /api/devices/pair — the camera redeems a code
  app.post<{ Body: { code?: string; name?: string } }>(
    "/api/devices/pair",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { code, name } = request.body || {};
      if (!code || typeof code !== "string") {
        return reply.code(400).send({ error: "missing_code", message: "Parningskod saknas" });
      }

      const result = await devices.pair(code, typeof name === "string" ? name : "");
      if (!result) {
        return reply.code(401).send({
          error: "invalid_code",
          message: "Koden stämmer inte, är redan använd eller har gått ut. Be om en ny.",
        });
      }

      return reply.code(201).send({
        deviceId: result.device.id,
        name: result.device.name,
        // Shown once. The backend keeps only a hash.
        token: result.token,
        club: clubManifest.name,
      });
    }
  );

  // POST /api/devices/invites — admin invites someone to pair their own camera
  app.post<{ Body: { name?: unknown } }>("/api/devices/invites", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;

    const name = normaliseDeviceName(request.body?.name);
    if (!name) {
      return reply.code(400).send({ error: "missing_name", message: "Skriv vems kamera det är." });
    }

    const { invite, code } = await devices.createInvite(name);
    const apiUrl = apiUrlOf(request);

    return reply.code(201).send({
      ...invite,
      // Shown once. The backend keeps only a hash.
      code,
      apiUrl,
      club: clubManifest.name,
      /** The link to send: the landing site's /join page. */
      link: inviteLink(apiUrl, code, clubManifest.name),
      /** Opens the camera app directly, for a phone that already has it. */
      appLink: pairingLink(apiUrl, code),
    });
  });

  // GET /api/devices/invites — invites and what became of them
  app.get("/api/devices/invites", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    return reply.send(await devices.listInvites());
  });

  // DELETE /api/devices/invites/:id — withdraw an invite nobody has used
  app.delete<{ Params: { id: string } }>("/api/devices/invites/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;

    const result = await devices.revokeInvite(request.params.id);
    if (result === "not_found") return reply.code(404).send({ error: "invite_not_found" });
    if (result === "not_pending") {
      return reply.code(409).send({
        error: "invite_not_pending",
        message: "Inbjudan är redan använd, återkallad eller har gått ut.",
      });
    }
    return reply.code(204).send();
  });

  // PATCH /api/devices/:id — rename a camera
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    "/api/devices/:id",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;

      const name = normaliseDeviceName(request.body?.name);
      if (!name) {
        return reply.code(400).send({ error: "missing_name", message: "Kameran behöver ett namn." });
      }
      const device = await devices.rename(request.params.id, name);
      if (!device) return reply.code(404).send({ error: "device_not_found" });
      return reply.send(device);
    }
  );

  // GET /api/devices — which cameras are paired
  app.get("/api/devices", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    return reply.send(await devices.list());
  });

  // DELETE /api/devices/self — a camera disconnecting itself from the club
  app.delete("/api/devices/self", async (request, reply) => {
    const header = request.headers["x-device-token"];
    const device = typeof header === "string" && header ? await devices.verify(header) : null;
    if (!device) {
      return reply.code(401).send({ error: "not_paired" });
    }
    await devices.revoke(device.id);
    return reply.code(204).send();
  });

  // DELETE /api/devices/:id — revoke one camera
  app.delete<{ Params: { id: string } }>("/api/devices/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;

    const revoked = await devices.revoke(request.params.id);
    if (!revoked) {
      return reply.code(404).send({ error: "device_not_found" });
    }
    return reply.code(204).send();
  });
}
