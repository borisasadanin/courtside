/**
 * Match schedule routes (ABL-048) — see matches.ts.
 *
 * The schedule is viewer data, like the team registry: it needs the viewer
 * code, a paired camera (the app lists today's matches from it) or an admin.
 * Adding, changing and removing matches is for the admin.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isValidAdminToken, requireAdminAuth, requireViewerOrBroadcasterAuth } from "../auth.js";
import { matches } from "../state.js";
import { MatchError, isMatchDate, type MatchInput } from "../matches.js";
import { say } from "../i18n.js";

/** Answer a refused change with its message; anything else is a server error. */
function refuse(request: FastifyRequest, reply: FastifyReply, err: unknown) {
  if (err instanceof MatchError) return reply.code(err.status).send({ error: say(request, err.text) });
  throw err;
}

/** The viewer code, a paired camera or the admin, as for GET /api/teams. */
async function viewerAccess(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const adminToken = request.headers["x-admin-token"];
  if (typeof adminToken === "string" && isValidAdminToken(adminToken)) return true;
  return requireViewerOrBroadcasterAuth(request, reply);
}

export default async function matchRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/matches?from=YYYY-MM-DD&to=YYYY-MM-DD — by date and time, both ends inclusive and optional
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/matches", async (request, reply) => {
    if (!(await viewerAccess(request, reply))) return;
    const { from, to } = request.query;
    for (const value of [from, to]) {
      if (value !== undefined && !isMatchDate(value)) {
        return reply.code(400).send({ error: "invalid_date", message: say(request, { sv: "Datum ska anges som ÅÅÅÅ-MM-DD.", en: "Dates are written as YYYY-MM-DD." }) });
      }
    }
    return reply.header("Cache-Control", "no-cache").send(await matches.list({ from, to }));
  });

  // GET /api/matches/:id — one match, with its recordings and result
  app.get<{ Params: { id: string } }>("/api/matches/:id", async (request, reply) => {
    if (!(await viewerAccess(request, reply))) return;
    const match = await matches.get(request.params.id);
    if (!match) return reply.code(404).send({ error: "match_not_found", message: say(request, { sv: "Matchen finns inte.", en: "The game does not exist." }) });
    return reply.header("Cache-Control", "no-cache").send(match);
  });

  // POST /api/admin/matches — add a match: date and both teams required, time and venue optional
  app.post<{ Body: MatchInput }>("/api/admin/matches", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return reply.code(201).send(await matches.create(request.body || {}));
    } catch (err) {
      return refuse(request, reply, err);
    }
  });

  // PUT /api/admin/matches/:id — fields left out stay; the match's recordings follow
  app.put<{ Params: { id: string }; Body: MatchInput }>("/api/admin/matches/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return reply.send(await matches.update(request.params.id, request.body || {}));
    } catch (err) {
      return refuse(request, reply, err);
    }
  });

  // DELETE /api/admin/matches/:id — only a match without recordings (409 otherwise)
  app.delete<{ Params: { id: string } }>("/api/admin/matches/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      await matches.remove(request.params.id);
      return reply.code(204).send();
    } catch (err) {
      return refuse(request, reply, err);
    }
  });
}
