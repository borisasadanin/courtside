/**
 * Match schedule routes (ABL-048) — see matches.ts.
 *
 * The schedule is viewer data, like the team registry: it needs the viewer
 * code, a paired camera (the app lists today's matches from it) or an admin.
 * Adding, changing and removing matches is for the admin.
 *
 * A match with an MVP (#162) shows it with the sponsor of the surface "mvp"
 * for its own team, or the club's, when there is one: a jersey number and a
 * sponsor, never a name.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isValidAdminToken, requireAdminAuth, requireViewerOrBroadcasterAuth } from "../auth.js";
import { matches, minio, sponsors } from "../state.js";
import { MatchError, isMatchDate, type Match, type MatchInput } from "../matches.js";
import { publicSponsorOf, sponsorsFor, type PublicSponsor } from "../sponsor-surfaces.js";
import type { SponsorSettings } from "../sponsors.js";

/** A match as viewers get it: its MVP with the sponsor of "mvp", when it has one. */
type ShownMatch = Omit<Match, "mvp"> & { mvp?: Match["mvp"] & { sponsor?: PublicSponsor } };

function withMvpSponsor(match: Match, settings: SponsorSettings | null): ShownMatch {
  if (!match.mvp || !settings) return match;
  const sponsor = sponsorsFor(settings, match.ownTeam.id || null, "mvp")[0]?.sponsor;
  return sponsor ? { ...match, mvp: { ...match.mvp, sponsor: publicSponsorOf(sponsor) } } : match;
}

/** The sponsors, read only when a match has an MVP to show; null when they cannot be read. */
async function settingsFor(list: Match[]): Promise<SponsorSettings | null> {
  return list.some((m) => m.mvp) ? sponsors.readAll().catch(() => null) : null;
}

/** Answer a refused change with its message; anything else is a server error. */
function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof MatchError) return reply.code(err.status).send({ error: err.message });
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
        return reply.code(400).send({ error: "invalid_date", message: "Datum ska anges som ÅÅÅÅ-MM-DD." });
      }
    }
    const list = await matches.list({ from, to });
    const settings = await settingsFor(list);
    return reply.header("Cache-Control", "no-cache").send(list.map((m) => withMvpSponsor(m, settings)));
  });

  // GET /api/matches/:id — one match, with its recordings and result
  app.get<{ Params: { id: string } }>("/api/matches/:id", async (request, reply) => {
    if (!(await viewerAccess(request, reply))) return;
    const match = await matches.get(request.params.id);
    if (!match) return reply.code(404).send({ error: "match_not_found", message: "Matchen finns inte." });
    return reply.header("Cache-Control", "no-cache").send(withMvpSponsor(match, await settingsFor([match])));
  });

  // POST /api/admin/matches — add a match: date and both teams required, time and venue optional
  app.post<{ Body: MatchInput }>("/api/admin/matches", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return reply.code(201).send(await matches.create(request.body || {}));
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // PUT /api/admin/matches/:id — fields left out stay; the match's recordings follow
  app.put<{ Params: { id: string }; Body: MatchInput }>("/api/admin/matches/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return reply.send(await matches.update(request.params.id, request.body || {}));
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // DELETE /api/admin/matches/:id — only a match without recordings (409 otherwise)
  app.delete<{ Params: { id: string } }>("/api/admin/matches/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      await matches.remove(request.params.id);
      return reply.code(204).send();
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // GET /api/admin/matches/:id/clips — the match's own clips, to choose its MVP from (#163)
  app.get<{ Params: { id: string } }>("/api/admin/matches/:id/clips", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    const match = await matches.get(request.params.id);
    if (!match) return reply.code(404).send({ error: "Matchen finns inte." });
    const own = new Set(match.recordingIds);
    const clips = (await minio.readClipsIndex())
      .filter((c) => own.has(c.streamId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ id, label, thumbnailUrl, durationSeconds, createdAt }) => ({ id, label, thumbnailUrl, durationSeconds, createdAt }));
    return reply.header("Cache-Control", "no-cache").send(clips);
  });

  // PUT /api/admin/matches/:id/mvp — { clipId, jersey }: one of the match's clips and 0–99 or 00 (#162)
  app.put<{ Params: { id: string }; Body: { clipId?: unknown; jersey?: unknown } }>("/api/admin/matches/:id/mvp", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      const match = await matches.setMvp(request.params.id, request.body || {});
      return reply.send(withMvpSponsor(match, await settingsFor([match])));
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // DELETE /api/admin/matches/:id/mvp — the match has no MVP any more
  app.delete<{ Params: { id: string } }>("/api/admin/matches/:id/mvp", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return reply.send(await matches.clearMvp(request.params.id));
    } catch (err) {
      return refuse(reply, err);
    }
  });
}
