/**
 * VOD routes: list, get, update, delete recorded matches.
 */
import type { FastifyInstance } from "fastify";
import { requireApiKey, requireViewerAuth, requireAdminAuth, requireBroadcasterAuth, isValidAdminToken } from "../auth.js";
import { config } from "../config.js";
import { minio } from "../state.js";
import { rewriteSegmentUris } from "../playlist-rewrite.js";
import { deleteMatch, logDeletion } from "../erasure.js";
import { matchCover } from "../match-images.js";
import type { MatchResult, VodEntry } from "../types.js";
import { say } from "../i18n.js";

/** How long after a match the camera may still report its result. After that, only the admin. */
export const CAMERA_RESULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A score is a whole number of points, 0–999, whatever the sport. */
function isScore(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999;
}

/** Whether the request carries the admin's own credentials (session or API key). */
function isAdminRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const token = headers["x-admin-token"];
  if (typeof token === "string" && isValidAdminToken(token)) return true;
  return !!config.API_KEY && headers["x-api-key"] === config.API_KEY;
}

export default async function vodRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/vod/:id/playlist.m3u8 — the stitched recording.
   *
   * Served here rather than straight from storage so the segment URIs can be
   * pointed at the media route. That indirection is what lets the bucket be
   * private: a recording is reachable only by someone the API has authorised.
   */
  app.get<{ Params: { id: string } }>(
    "/api/vod/:id/playlist.m3u8",
    async (request, reply) => {
      if (!requireViewerAuth(request, reply)) return;

      const { id } = request.params;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        return reply.code(400).send({ error: "invalid_id" });
      }

      const manifest = await minio.readFile(minio.vodPlaylistKey(id));
      if (!manifest) {
        return reply.code(404).send({ error: "Recording not found" });
      }

      const rewritten = rewriteSegmentUris(
        manifest,
        (filename) => `/api/media/${id}/${filename}`
      );

      return reply
        .type("application/vnd.apple.mpegurl")
        .header("Cache-Control", "no-cache")
        .send(rewritten);
    }
  );

  // GET /api/vod — List all VOD recordings
  app.get("/api/vod", async (request, reply) => {
    if (!requireViewerAuth(request, reply)) return;

    try {
      const [entries, clips] = await Promise.all([minio.readVodIndex(), minio.readClipsIndex()]);
      // Sort by date descending (newest first), only return completed recordings
      // Filter out entries shorter than 10s (likely no actual recording data)
      const sorted = entries
        .filter((e) => e.stoppedAt && (e.durationSeconds === undefined || e.durationSeconds >= 10))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return reply.send(sorted.map((e) => ({ ...e, cover: matchCover(e, clips) })));
    } catch (err) {
      request.log.error(err, "Failed to read VOD index");
      return reply.code(500).send({ error: "Failed to load recordings" });
    }
  });

  // GET /api/vod/:id — Get a specific VOD entry
  app.get<{ Params: { id: string } }>("/api/vod/:id", async (request, reply) => {
    if (!requireViewerAuth(request, reply)) return;

    const { id } = request.params;
    try {
      const [entries, clips] = await Promise.all([minio.readVodIndex(), minio.readClipsIndex()]);
      const entry = entries.find((e) => e.id === id);
      if (!entry) {
        return reply.code(404).send({ error: "Recording not found" });
      }
      return reply.send({ ...entry, cover: matchCover(entry, clips) });
    } catch (err) {
      request.log.error(err, "Failed to read VOD entry");
      return reply.code(500).send({ error: "Failed to load recording" });
    }
  });

  // PUT /api/vod/:id — Update VOD metadata (admin, requires API key)
  app.put<{ Params: { id: string }; Body: Partial<VodEntry> }>(
    "/api/vod/:id",
    async (request, reply) => {
      if (!requireApiKey(request, reply)) return;

      const { id } = request.params;
      const allowedFields = [
        "matchTitle", "location", "homeTeam", "awayTeam", "matchDate",
      ] as const;

      const update: Partial<VodEntry> = {};
      for (const field of allowedFields) {
        if (request.body[field] !== undefined) {
          (update as Record<string, unknown>)[field] = request.body[field];
        }
      }

      try {
        await minio.updateVodEntry(id, update);
        return reply.send({ ok: true });
      } catch (err) {
        request.log.error(err, "Failed to update VOD entry");
        return reply.code(500).send({ error: "Failed to update recording" });
      }
    }
  );

  // PUT /api/vod/:id/result — Set the final score { home, away }.
  // The camera reports it right after the match; the admin can set or correct it any time.
  app.put<{ Params: { id: string }; Body: { home?: unknown; away?: unknown } | undefined }>(
    "/api/vod/:id/result",
    async (request, reply) => {
      const asAdmin = isAdminRequest(request.headers);
      if (!asAdmin && !(await requireBroadcasterAuth(request, reply))) return;

      const { home, away } = request.body ?? {};
      if (!isScore(home) || !isScore(away)) {
        return reply.code(400).send({ error: "invalid_result", message: say(request, { sv: "Resultatet ska vara två heltal mellan 0 och 999", en: "The result must be two whole numbers between 0 and 999" }) });
      }

      const { id } = request.params;
      try {
        const entry = (await minio.readVodIndex()).find((v) => v.id === id);
        if (!entry) {
          return reply.code(404).send({ error: "not_found", message: say(request, { sv: "Inspelningen hittades inte", en: "Recording not found" }) });
        }
        // A camera reporting late must never overwrite what the admin corrected since.
        if (!asAdmin && entry.stoppedAt && Date.now() - new Date(entry.stoppedAt).getTime() > CAMERA_RESULT_WINDOW_MS) {
          return reply.code(403).send({ error: "result_locked", message: say(request, { sv: "Resultatet kan nu bara ändras av admin i Hantera", en: "The result can now only be changed by the admin in Manage" }) });
        }

        const result: MatchResult = { home, away, setBy: asAdmin ? "admin" : "camera", setAt: new Date().toISOString() };
        if (!(await minio.updateVodEntry(id, { result }))) {
          return reply.code(404).send({ error: "not_found", message: say(request, { sv: "Inspelningen hittades inte", en: "Recording not found" }) });
        }
        request.log.info(`Result for ${id}: ${home}–${away} (${result.setBy})`);
        return reply.send(result);
      } catch (err) {
        request.log.error(err, "Failed to save result");
        return reply.code(500).send({ error: "save_failed", message: say(request, { sv: "Kunde inte spara resultatet", en: "Could not save the result" }) });
      }
    }
  );

  // PUT /api/vod/:id/cover — Choose one of the match's highlights as its cover (admin).
  // { clipId: null } goes back to the automatic choice.
  app.put<{ Params: { id: string }; Body: { clipId?: unknown } | undefined }>(
    "/api/vod/:id/cover",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;

      const { id } = request.params;
      const clipId = request.body?.clipId;
      if (clipId !== null && typeof clipId !== "string") {
        return reply.code(400).send({ error: "invalid_clip", message: say(request, { sv: "Välj ett klipp", en: "Choose a clip" }) });
      }
      try {
        const [entries, clips] = await Promise.all([minio.readVodIndex(), minio.readClipsIndex()]);
        const entry = entries.find((e) => e.id === id);
        if (!entry) {
          return reply.code(404).send({ error: "not_found", message: say(request, { sv: "Inspelningen hittades inte", en: "Recording not found" }) });
        }
        // Only a highlight of this match, and one that has a picture.
        if (clipId !== null && !clips.some((c) => c.id === clipId && c.streamId === id && c.thumbnailUrl)) {
          return reply.code(400).send({ error: "invalid_clip", message: say(request, { sv: "Klippet har ingen bild från den här matchen", en: "The clip has no picture from this game" }) });
        }
        const coverClipId = clipId ?? undefined;
        await minio.updateVodEntry(id, { coverClipId });
        return reply.send({ cover: matchCover({ ...entry, coverClipId }, clips) ?? null });
      } catch (err) {
        request.log.error(err, "Failed to save cover");
        return reply.code(500).send({ error: "save_failed", message: say(request, { sv: "Kunde inte spara omslagsbilden", en: "Could not save the cover picture" }) });
      }
    }
  );

  // DELETE /api/vod/:id/result — Remove the score (admin).
  app.delete<{ Params: { id: string } }>("/api/vod/:id/result", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;

    try {
      if (!(await minio.updateVodEntry(request.params.id, { result: undefined }))) {
        return reply.code(404).send({ error: "not_found", message: say(request, { sv: "Inspelningen hittades inte", en: "Recording not found" }) });
      }
      return reply.code(204).send();
    } catch (err) {
      request.log.error(err, "Failed to remove result");
      return reply.code(500).send({ error: "save_failed", message: say(request, { sv: "Kunde inte ta bort resultatet", en: "Could not remove the result" }) });
    }
  });

  // DELETE /api/vod/:id — Delete a match, its files and its clips (admin).
  // ?onRequest=1 notes in the deletion log that someone asked for it.
  app.delete<{ Params: { id: string }; Querystring: { onRequest?: string } }>("/api/vod/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;

    const { id } = request.params;
    try {
      const title = (await minio.readVodIndex()).find((v) => v.id === id)?.matchTitle;
      const erased = await deleteMatch(minio, id);
      request.log.info(`Deleted VOD ${id}: ${erased.files} files, ${erased.clips.length} clips`);
      if (!erased.found) {
        return reply.code(404).send({ error: "Recording not found" });
      }
      await logDeletion(minio, {
        what: "match",
        id,
        match: title,
        onRequest: request.query.onRequest === "1",
        files: erased.files,
        clips: erased.clips.length,
      }).catch((err) => request.log.error(err, "Could not write the deletion log"));
      return reply.code(204).send();
    } catch (err) {
      request.log.error(err, "Failed to delete VOD entry");
      return reply.code(500).send({ error: "Failed to delete recording" });
    }
  });
}
