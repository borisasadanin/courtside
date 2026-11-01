/**
 * Broadcast state routes: public status for website viewers,
 * manual control for iOS app operators.
 */
import type { FastifyInstance } from "fastify";
import { broadcasterOf, requireBroadcasterAuth } from "../auth.js";
import { getBroadcastState, reportStatus, VALID_STATUSES } from "../broadcast-state.js";
import type { BroadcastStatus } from "../broadcast-state.js";
import { streamMeta } from "../state.js";

export default async function broadcastRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/broadcast — Public (no auth), the installation's status derived from every match
  app.get("/api/broadcast", async (_request, reply) => {
    return reply.send(getBroadcastState(streamMeta.values()));
  });

  // PATCH /api/broadcast — A paired camera (or the API key) reports on its own match.
  // Older apps think of this as the installation's status; see reportStatus.
  app.patch<{ Body: { status: string; message?: string } }>("/api/broadcast", async (request, reply) => {
    if (!(await requireBroadcasterAuth(request, reply))) return;

    const { status, message } = request.body || {};

    if (!status || !VALID_STATUSES.includes(status as BroadcastStatus)) {
      return reply.code(400).send({
        error: "invalid_status",
        message: `Status måste vara en av: ${VALID_STATUSES.join(", ")}`,
      });
    }

    reportStatus(await broadcasterOf(request), status as BroadcastStatus, typeof message === "string" ? message : undefined);
    return reply.send(getBroadcastState(streamMeta.values()));
  });
}
