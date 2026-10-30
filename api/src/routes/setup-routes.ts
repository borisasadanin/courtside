/**
 * First-run setup endpoints, and changing the PINs afterwards from the admin
 * view — see setup.ts.
 */
import type { FastifyInstance } from "fastify";
import { createAdminToken, createViewerToken, requireAdminAuth } from "../auth.js";
import { mutableConfig } from "../config.js";
import type { Setup } from "../setup.js";

export default async function setupRoutes(
  app: FastifyInstance,
  opts: { setup: Setup },
): Promise<void> {
  const { setup } = opts;

  // GET /api/setup — whether the website should show setup instead of the PIN screen
  app.get("/api/setup", async (_request, reply) => {
    return reply.header("Cache-Control", "no-cache").send({
      required: setup.isRequired(),
      keepsViewerPin: setup.keepsViewerPin(),
    });
  });

  // POST /api/setup — choose the PINs, and come out of it logged in as admin
  app.post<{ Body: { code?: string; adminPin?: string; viewerPin?: string } }>(
    "/api/setup",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const error = await setup.complete(request.body || {});
      if (error) {
        const status = error === "Fel uppsättningskod." ? 401 : error.startsWith("Installationen") ? 409 : 400;
        return reply.code(status).send({ error });
      }

      // Tokens are signed with the PINs just chosen, so none from before setup
      // is still valid.
      app.log.info("First-run setup completed");

      return reply.send({
        token: createViewerToken(),
        role: "admin",
        adminToken: createAdminToken(),
      });
    },
  );

  // GET /api/admin/pins — The viewer PIN, for the admin to pass on, and
  // whether the PINs can be changed here.  The admin PIN is never sent.
  app.get("/api/admin/pins", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    const locked = setup.pinsLocked();
    return reply.header("Cache-Control", "no-store").send({
      viewerPin: mutableConfig.VIEWER_PIN,
      changeable: !locked,
      reason: locked ?? undefined,
    });
  });

  // PUT /api/admin/pins — New viewer and/or admin PIN.  An empty viewer PIN
  // opens watching to anyone with the link.
  app.put<{ Body: { currentAdminPin?: string; adminPin?: string; viewerPin?: string } }>(
    "/api/admin/pins",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      let error: string | null;
      try {
        error = await setup.changePins(request.body || {});
      } catch (err) {
        request.log.error(err, "storing new PINs failed");
        return reply.code(502).send({ error: "Kunde inte spara koderna. Försök igen om en stund." });
      }
      if (error) {
        const status = error.startsWith("Fel nuvarande") ? 403 : setup.pinsLocked() ? 409 : 400;
        return reply.code(status).send({ error });
      }

      // Sessions are signed with the PINs, so every one from before is now
      // invalid, the admin's own included: hand the admin fresh ones.
      app.log.info("PINs changed from the admin view");
      return reply.send({
        token: createViewerToken(),
        adminToken: createAdminToken(),
        viewerPin: mutableConfig.VIEWER_PIN,
      });
    },
  );
}
