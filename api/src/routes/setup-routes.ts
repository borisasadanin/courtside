/**
 * First-run setup endpoints — see setup.ts.
 */
import type { FastifyInstance } from "fastify";
import { createAdminToken, createViewerToken } from "../auth.js";
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
}
