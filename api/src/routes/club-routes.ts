/**
 * Club manifest route — lets the website theme itself at runtime.
 *
 * Deliberately unauthenticated: the manifest holds nothing secret, and the
 * website needs it before the viewer has entered a PIN (the PIN screen is
 * branded too).
 */
import type { FastifyInstance } from "fastify";
import { clubManifest } from "../club-config.js";
import { requireAdminAuth } from "../auth.js";
import type { Branding } from "../club-branding.js";

export default async function clubRoutes(
  app: FastifyInstance,
  opts: { branding: Branding },
): Promise<void> {
  const { branding } = opts;

  app.get("/api/club", async (_request, reply) => {
    // Revalidate rather than cache: the manifest is a few hundred bytes and
    // fetched once per page load, so caching saves nothing — but a stale copy
    // means a club changes its colours and does not see it happen.
    return reply
      .header("Cache-Control", "no-cache")
      .send(clubManifest);
  });

  // GET /api/club/logo — the logo uploaded in the admin view. Public, like the
  // manifest: the PIN screen shows it. The URL carries a version, so it can be
  // cached hard.
  app.get("/api/club/logo", async (_request, reply) => {
    const logo = await branding.logo();
    if (!logo) return reply.code(404).send({ error: "no_logo" });
    return reply
      .header("Content-Type", logo.type)
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(logo.bytes);
  });

  // PUT /api/admin/club — name, tagline and colour
  app.put<{ Body: { name?: string; tagline?: string; accentColor?: string } }>(
    "/api/admin/club",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      const error = await branding.update(request.body || {});
      if (error) return reply.code(400).send({ error });
      return reply.send(clubManifest);
    },
  );

  // PUT /api/admin/club/privacy — who answers for the recordings
  app.put<{ Body: { controller?: string; contact?: string; policyUrl?: string } }>(
    "/api/admin/club/privacy",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      const error = await branding.updatePrivacy(request.body || {});
      if (error) return reply.code(400).send({ error });
      return reply.send(clubManifest);
    },
  );

  // PUT /api/admin/club/logo — a data URL, resized by the admin view first
  app.put<{ Body: { dataUrl?: string } }>(
    "/api/admin/club/logo",
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      const error = await branding.setLogo(request.body?.dataUrl ?? "");
      if (error) return reply.code(400).send({ error });
      return reply.send(clubManifest);
    },
  );

  // DELETE /api/admin/club/logo — back to the default logo
  app.delete("/api/admin/club/logo", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    await branding.removeLogo();
    return reply.send(clubManifest);
  });
}
