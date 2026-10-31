/**
 * Restreamer admin routes: status, start, stop.
 *
 * A paired camera starts and stops the engine itself, so these take the same
 * permission as broadcasting: a device token or the API key.
 */
import type { FastifyInstance } from "fastify";
import { requireBroadcasterAuth } from "../auth.js";
import { restreamer, oscManager } from "../state.js";

export default async function restreamerRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/restreamer/status — Return cached state instantly (background polling keeps it fresh)
  app.get("/api/restreamer/status", async (request, reply) => {
    if (!(await requireBroadcasterAuth(request, reply))) return;
    const { state, info } = oscManager.getCachedState();
    return reply.send({ state, info, shutdownInSeconds: oscManager.getShutdownInSeconds() });
  });

  // POST /api/restreamer/start — Trigger Restreamer instance start (non-blocking, with crash recovery)
  app.post("/api/restreamer/start", async (request, reply) => {
    if (!(await requireBroadcasterAuth(request, reply))) return;
    const currentState = oscManager.getState();

    if (currentState === "running") {
      // Verify it's actually alive — if not, force-recreate in background
      const alive = await oscManager.quickHealthProbe();
      if (alive) {
        return reply.send({ state: "running", message: "Restreamer körs", info: oscManager.getInfo() });
      }
      // Broken instance — force-recreate in background
      request.log.info("Restreamer reports running but is unresponsive, force-recreating...");
      oscManager.forceRecreate().then((info) => {
        restreamer.rtmpHost = info.rtmpHost;
      }).catch((err) => {
        request.log.error(err, "Background Restreamer force-recreate failed");
      });
      return reply.send({ state: "starting", message: "Restreamer svarar inte, återskapar..." });
    }

    if (currentState === "stopping") {
      // Grace period active — cancel it and stay running
      oscManager.ensureRunning().then((info) => {
        restreamer.rtmpHost = info.rtmpHost;
      }).catch((err) => {
        request.log.error(err, "Background Restreamer start failed");
      });
      return reply.send({ state: "starting", message: "Avbryter nedstängning, startar om..." });
    }

    if (currentState !== "starting") {
      // Fire and forget — client polls /status to track progress
      oscManager.ensureRunning().then((info) => {
        restreamer.rtmpHost = info.rtmpHost;
      }).catch((err) => {
        request.log.error(err, "Background Restreamer start failed");
      });
    }
    return reply.send({ state: "starting", message: "Restreamer startar..." });
  });

  // DELETE /api/restreamer/stop — Stop the Restreamer instance, unless someone
  // is using it. Any paired camera may call this, so one camera pressing stop
  // must not cut off a match another is streaming, or one that is paused.
  app.delete("/api/restreamer/stop", async (request, reply) => {
    if (!(await requireBroadcasterAuth(request, reply))) return;

    const activeStreams = oscManager.getActiveStreamCount();
    const pausedStreams = oscManager.getPausedStreamCount();
    if (activeStreams > 0 || pausedStreams > 0) {
      return reply.code(409).send({
        error: "streams_active",
        message: streamsActiveMessage(activeStreams, pausedStreams),
        activeStreams,
        pausedStreams,
      });
    }

    try {
      await oscManager.forceStop();
      return reply.code(204).send();
    } catch (err) {
      request.log.error(err, "Failed to stop Restreamer");
      return reply.code(500).send({ error: "Failed to stop Restreamer" });
    }
  });
}

/** Why the engine stays on, in words for whoever pressed stop. */
function streamsActiveMessage(active: number, paused: number): string {
  const parts: string[] = [];
  if (active > 0) parts.push(active === 1 ? "en sändning pågår" : `${active} sändningar pågår`);
  if (paused > 0) parts.push(paused === 1 ? "en match är pausad" : `${paused} matcher är pausade`);
  return `Sändningsmotorn kan inte stängas av: ${parts.join(" och ")}. Avsluta sändningen först.`;
}
