/**
 * Website — served from the same origin as the API.
 *
 * One address per club: the page calls /api relatively, so there is no backend
 * URL to configure after deploy and no CORS to get right.  Video does not pass
 * through here; the media routes redirect to signed storage URLs.
 *
 * Registered only when a built website exists, so the API still runs on its own
 * (tests, or a club that hosts the website elsewhere).
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

const here = dirname(fileURLToPath(import.meta.url));

/** web/dist relative to api/dist/routes (built) or api/src/routes (tsx). */
export const DEFAULT_WEB_DIST = resolve(here, "../../../web/dist");

export function webDistDir(): string | null {
  const dir = process.env.WEB_DIST_DIR
    ? resolve(process.env.WEB_DIST_DIR)
    : DEFAULT_WEB_DIST;
  return existsSync(join(dir, "index.html")) ? dir : null;
}

// Same origin, so the website needs no backend URL.  Overrides the file in the
// bundle, which may still carry a URL from a separately hosted deployment.
const SAME_ORIGIN_CONFIG = "window.COURTSIDE_CONFIG = { apiUrl: \"\" };\n";

export default async function webRoutes(
  app: FastifyInstance,
  opts: { root: string },
): Promise<void> {
  app.get("/runtime-config.js", async (_request, reply) => {
    return reply
      .type("application/javascript; charset=utf-8")
      .header("Cache-Control", "no-cache")
      .send(SAME_ORIGIN_CONFIG);
  });

  await app.register(fastifyStatic, {
    root: opts.root,
    // Hashed assets never change under the same name; HTML must always be
    // revalidated or a deploy is invisible until the cache expires.
    cacheControl: false,
    setHeaders(res, path) {
      res.setHeader(
        "Cache-Control",
        /\/assets\/[^/]+-[0-9a-f]{8}\.\w+$/.test(path)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
    },
  });
}
