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
import { clubManifest } from "../club-config.js";

/** The app's URL scheme, registered in camera/CourtsideCamera/Info.plist. */
export function pairingLink(apiUrl: string, code: string): string {
  return `courtside-camera://pair?url=${encodeURIComponent(apiUrl)}&code=${encodeURIComponent(code)}`;
}

export default async function deviceRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/devices/pairing-code — admin asks for a code to show on screen
  app.post("/api/devices/pairing-code", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;

    const { code, expiresAt } = devices.createPairingCode();

    // The camera needs to know which installation to talk to, and only the
    // request knows how this backend is actually reached.
    const proto = (request.headers["x-forwarded-proto"] as string) || request.protocol;
    const host = (request.headers["x-forwarded-host"] as string) || request.headers.host;
    const apiUrl = `${proto}://${host}`;

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
          message: "Koden stämmer inte eller har gått ut. Be om en ny.",
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
