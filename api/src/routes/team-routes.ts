/**
 * Team registry routes (ABL-047) — see teams.ts.
 *
 * The list is viewer data, like the recordings it labels: it needs the viewer
 * code, a paired camera (the app picks the opponent from it) or an admin. The
 * logos are public, like the club logo: they show no people, and a shared
 * match image (ABL-050) must be able to show them to anyone.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { isValidAdminToken, requireAdminAuth, requireViewerOrBroadcasterAuth } from "../auth.js";
import { teams } from "../state.js";
import { TeamError, type TeamInput } from "../teams.js";

/** Answer a refused change with its message; anything else is a server error. */
function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof TeamError) {
    return reply.code(err.status).send({ error: err.message, ...(err.teamId && { teamId: err.teamId }) });
  }
  throw err;
}

export default async function teamRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/teams — every team, own teams first
  app.get("/api/teams", async (request, reply) => {
    const adminToken = request.headers["x-admin-token"];
    const isAdmin = typeof adminToken === "string" && isValidAdminToken(adminToken);
    if (!isAdmin && !(await requireViewerOrBroadcasterAuth(request, reply))) return;
    return reply.header("Cache-Control", "no-cache").send(await teams.list());
  });

  // GET /api/teams/:id/logo — public; the URL carries a version, so it can be cached hard
  app.get<{ Params: { id: string } }>("/api/teams/:id/logo", async (request, reply) => {
    const logo = await teams.logo(request.params.id);
    if (!logo) return reply.code(404).send({ error: "no_logo" });
    return reply
      .header("Content-Type", logo.type)
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(logo.bytes);
  });

  // POST /api/admin/teams — add a team
  app.post<{ Body: TeamInput }>("/api/admin/teams", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return reply.code(201).send(await teams.create(request.body || {}));
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // PUT /api/admin/teams/:id — name, short name, colour, own; fields left out stay
  app.put<{ Params: { id: string }; Body: TeamInput }>("/api/admin/teams/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return reply.send(await teams.update(request.params.id, request.body || {}));
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // DELETE /api/admin/teams/:id — the team and its logo; recordings keep the name
  app.delete<{ Params: { id: string } }>("/api/admin/teams/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      await teams.remove(request.params.id);
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // PUT /api/admin/teams/:id/logo — a data URL, resized by the admin view first
  app.put<{ Params: { id: string }; Body: { dataUrl?: string } }>(
    "/api/admin/teams/:id/logo",
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      try {
        return reply.send(await teams.setLogo(request.params.id, request.body?.dataUrl ?? ""));
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );

  // DELETE /api/admin/teams/:id/logo — back to the short name on the team colour
  app.delete<{ Params: { id: string } }>("/api/admin/teams/:id/logo", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return reply.send(await teams.removeLogo(request.params.id));
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // POST /api/admin/teams/:id/merge — fold the team { from } into this one
  app.post<{ Params: { id: string }; Body: { from?: string } }>("/api/admin/teams/:id/merge", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return reply.send(await teams.merge(request.params.id, String(request.body?.from ?? "")));
    } catch (err) {
      return refuse(reply, err);
    }
  });
}
