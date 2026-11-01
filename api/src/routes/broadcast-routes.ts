/**
 * Broadcast state routes: public status for website viewers,
 * manual control for iOS app operators.
 */
import type { FastifyInstance } from "fastify";
import { broadcasterOf, requireBroadcasterAuth } from "../auth.js";
import { getBroadcastState, reportStatus, VALID_STATUSES } from "../broadcast-state.js";
import type { BroadcastStatus } from "../broadcast-state.js";
import { matches, streamMeta } from "../state.js";
import { clubDate, matchTitle } from "../matches.js";

export default async function broadcastRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/broadcast — Public (no auth), the installation's status derived from every match
  app.get("/api/broadcast", async (_request, reply) => {
    return reply.send(getBroadcastState(streamMeta.values()));
  });

  // PATCH /api/broadcast — A paired camera (or the API key) reports on its own match.
  // Older apps think of this as the installation's status; see reportStatus.
  // { matchId } names the match in the schedule (ABL-048); without it, an
  // announcement like "P12 vs AIK" is matched to one of today's matches.
  app.patch<{ Body: { status: string; message?: string; matchId?: string } }>("/api/broadcast", async (request, reply) => {
    if (!(await requireBroadcasterAuth(request, reply))) return;

    const { status, message } = request.body || {};

    if (!status || !VALID_STATUSES.includes(status as BroadcastStatus)) {
      return reply.code(400).send({
        error: "invalid_status",
        message: `Status måste vara en av: ${VALID_STATUSES.join(", ")}`,
      });
    }

    let text = typeof message === "string" && message.trim() ? message : undefined;
    let matchId: string | undefined;
    if (status === "upcoming" || status === "ended") {
      // An announcement must never fail on the schedule: without it, it stays free text.
      try {
        const asked = request.body?.matchId;
        const match = typeof asked === "string" && asked ? await matches.summary(asked) : null;
        if (match) {
          matchId = match.id;
          text ??= matchTitle(match.ownTeam.name, match.opponent.name);
        } else if (text && status === "upcoming") {
          matchId = (await matches.findAnnounced(text, clubDate())) ?? undefined;
        }
      } catch (err) {
        request.log.warn(err, "Could not read the schedule for an announcement");
      }
    }

    reportStatus(await broadcasterOf(request), status as BroadcastStatus, text, matchId);
    return reply.send(getBroadcastState(streamMeta.values()));
  });
}
