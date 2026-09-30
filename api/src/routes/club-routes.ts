/**
 * Club manifest route — lets the website theme itself at runtime.
 *
 * Deliberately unauthenticated: the manifest holds nothing secret, and the
 * website needs it before the viewer has entered a PIN (the PIN screen is
 * branded too).
 */
import type { FastifyInstance } from "fastify";
import { clubManifest } from "../club-config.js";

export default async function clubRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/club", async (_request, reply) => {
    // Revalidate rather than cache: the manifest is a few hundred bytes and
    // fetched once per page load, so caching saves nothing — but a stale copy
    // means a club changes its colours and does not see it happen.
    return reply
      .header("Cache-Control", "no-cache")
      .send(clubManifest);
  });
}
