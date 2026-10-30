/**
 * Highlight clip routes: create and list clips from live streams.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAdminAuth, requireApiKey, requireBroadcasterAuth, requireViewerAuth } from "../auth.js";
import { streamMeta, collectors, clipsByStream, minio } from "../state.js";
import { createClip } from "../clip-service.js";
import { convertSegmentsToMp4, extractThumbnail } from "../mp4-converter.js";
import { clubManifest, absoluteLogoUrl } from "../club-config.js";
import { rewriteSegmentUris } from "../playlist-rewrite.js";
import { keysReferencedBy } from "./media.js";
import { deleteClip, logDeletion } from "../erasure.js";

/** Track last clip time per stream to prevent spam */
const lastClipTime = new Map<string, number>();
const MIN_CLIP_INTERVAL_MS = 5_000; // 5 seconds between clips per stream

export default async function clipRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/streams/:id/clip — Create a highlight clip (admin only)
  app.post<{ Params: { id: string }; Body: { timestamp?: string; label?: string } }>(
    "/api/streams/:id/clip",
    async (request, reply) => {
      if (!(await requireBroadcasterAuth(request, reply))) return;

      const { id } = request.params;

      // Rate limit: max 1 clip per 5 seconds per stream
      const lastTime = lastClipTime.get(id) || 0;
      if (Date.now() - lastTime < MIN_CLIP_INTERVAL_MS) {
        return reply.code(429).send({ error: "too_fast", message: "Vänta några sekunder mellan klipp" });
      }

      const meta = streamMeta.get(id);
      if (!meta) {
        return reply.code(404).send({ error: "stream_not_found", message: "Strömmen hittades inte" });
      }
      if (meta.stoppedAt) {
        return reply.code(400).send({ error: "stream_stopped", message: "Strömmen är redan stoppad" });
      }

      const collector = collectors.get(id);
      if (!collector) {
        return reply
          .code(400)
          .send({ error: "no_collector", message: "Ingen segmentinsamling aktiv för denna ström" });
      }

      // Use provided timestamp or fall back to now
      const body = request.body || {};
      const buttonPressTimestamp = body.timestamp ? new Date(body.timestamp).getTime() : Date.now();

      if (isNaN(buttonPressTimestamp)) {
        return reply.code(400).send({ error: "invalid_timestamp", message: "Ogiltig tidsstämpel" });
      }

      try {
        lastClipTime.set(id, Date.now());

        const clip = await createClip(
          collector,
          buttonPressTimestamp,
          minio,
          request.log,
          body.label,
        );

        // Store in-memory + persist to MinIO
        if (!clipsByStream.has(id)) {
          clipsByStream.set(id, []);
        }
        clipsByStream.get(id)!.push(clip);
        await minio.addClipEntry(clip);

        return reply.code(201).send(clip);
      } catch (err) {
        request.log.error(err, "Failed to create clip");
        return reply.code(500).send({
          error: "clip_failed",
          message: err instanceof Error ? err.message : "Kunde inte skapa klipp",
        });
      }
    },
  );

  // GET /api/streams/:id/clips — List highlight clips for a stream (live in-memory)
  app.get<{ Params: { id: string } }>(
    "/api/streams/:id/clips",
    async (request, reply) => {
      if (!requireViewerAuth(request, reply)) return;

      const { id } = request.params;
      const clips = clipsByStream.get(id) || [];

      // Return newest first
      return reply.send([...clips].reverse());
    },
  );

  /**
   * GET /api/clips/:id/playlist.m3u8 — a shared clip's manifest.
   *
   * No PIN: a clip link is meant to be sendable. The segment URIs point at the
   * clip's own media route, which only serves files this clip references.
   */
  app.get<{ Params: { id: string } }>(
    "/api/clips/:id/playlist.m3u8",
    async (request, reply) => {
      const { id } = request.params;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        return reply.code(400).send({ error: "invalid_id" });
      }

      const clips = await minio.readClipsIndex();
      const clip = clips.find((c) => c.id === id);
      if (!clip) {
        return reply.code(404).send({ error: "clip_not_found" });
      }

      const manifest = await minio.readFile(minio.clipManifestKey(clip.streamId, clip.id));
      if (!manifest) {
        return reply.code(404).send({ error: "clip_manifest_missing" });
      }

      const rewritten = rewriteSegmentUris(
        manifest,
        (filename) => `/api/clips/${clip.id}/media/${filename}`
      );

      return reply
        .type("application/vnd.apple.mpegurl")
        .header("Cache-Control", "no-cache")
        .send(rewritten);
    },
  );

  // GET /api/clips/:id/public — Get a specific clip without auth (for clip.html sharing)
  app.get<{ Params: { id: string } }>(
    "/api/clips/:id/public",
    async (request, reply) => {
      const { id } = request.params;
      try {
        const clips = await minio.readClipsIndex();
        const clip = clips.find((c) => c.id === id);
        if (!clip) {
          return reply.code(404).send({ error: "clip_not_found", message: "Klippet hittades inte" });
        }
        // No MP4: the shared page plays the clip, it does not hand out a download.
        const { mp4Url: _download, ...shared } = clip;
        return reply.send(shared);
      } catch (err) {
        request.log.error(err, "Failed to read clip");
        return reply.code(500).send({ error: "read_failed", message: "Kunde inte läsa klipp" });
      }
    },
  );

  // GET /api/clips/:id/og — Open Graph HTML for WhatsApp/social media link previews.
  // Also at /c/:id, the link the share buttons hand out: the website is served
  // from this origin, so there is no Cloudflare Worker in front to map it.
  const ogPage = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const { id } = request.params;
    try {
      const clips = await minio.readClipsIndex();
      const clip = clips.find((c) => c.id === id);
      if (!clip) {
        return reply.code(404).type("text/html").send("<h1>Klippet hittades inte</h1>");
      }

      // Social crawlers need absolute URLs. Media paths are relative to this
      // API, and the crawler reached us on this host, so build from the
      // request rather than from configuration that might not be set.
      const proto = (request.headers["x-forwarded-proto"] as string) || request.protocol;
      const host = (request.headers["x-forwarded-host"] as string) || request.headers.host;
      const absolute = (path?: string): string =>
        !path ? "" : /^https?:\/\//.test(path) ? path : `${proto}://${host}${path}`;

      const label = clip.label || "Höjdpunkt";
      const siteUrl = clubManifest.siteUrl || `${proto}://${host}`;
      const clipPageUrl = `${siteUrl}/clip.html#${encodeURIComponent(clip.id)}`;

      // Look up match info from VOD index
      let matchTitle = "";
      try {
        const vods = await minio.readVodIndex();
        const vod = vods.find((v) => v.id === clip.streamId);
        if (vod) matchTitle = vod.matchTitle || "";
      } catch { /* ignore — description will just be generic */ }

      const clubName = clubManifest.name;
      const title = matchTitle
        ? `${label} — ${matchTitle}`
        : `${label} — ${clubName}`;
      const description = matchTitle
        ? `Höjdpunkt från ${matchTitle} — ${clubName}`
        : `Höjdpunkt från matchen — ${clubName}`;

      // Detect bot crawlers (WhatsApp, Facebook, Telegram, etc.)
      const ua = (request.headers["user-agent"] || "").toLowerCase();
      const isBot = /whatsapp|facebookexternalhit|telegrambot|twitterbot|linkedinbot|slackbot|discordbot|bot|crawler|spider/i.test(ua);

      // For bots: serve OG tags only (no redirect, so crawler reads meta)
      // For humans: redirect to clip page via JS (after a brief moment)
      const redirectTag = isBot
        ? ""
        : `<meta http-equiv="refresh" content="1;url=${clipPageUrl}">
<script>setTimeout(function(){window.location.href="${clipPageUrl}"},800)</script>`;

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${absolute(clip.thumbnailUrl) || absoluteLogoUrl() || ""}">
${redirectTag}
<title>${title}</title>
</head>
<body><p>Omdirigerar...</p></body>
</html>`;

      return reply.type("text/html").send(html);
    } catch (err) {
      request.log.error(err, "Failed to serve OG page for clip");
      return reply.code(500).type("text/html").send("<h1>Serverfel</h1>");
    }
  };
  app.get<{ Params: { id: string } }>("/api/clips/:id/og", ogPage);
  app.get<{ Params: { id: string } }>("/c/:id", ogPage);

  // GET /api/clips/:id — Get a specific highlight clip by ID
  app.get<{ Params: { id: string } }>(
    "/api/clips/:id",
    async (request, reply) => {
      if (!requireViewerAuth(request, reply)) return;

      const { id } = request.params;
      try {
        const clips = await minio.readClipsIndex();
        const clip = clips.find((c) => c.id === id);
        if (!clip) {
          return reply.code(404).send({ error: "clip_not_found", message: "Klippet hittades inte" });
        }
        return reply.send(clip);
      } catch (err) {
        request.log.error(err, "Failed to read clip");
        return reply.code(500).send({ error: "read_failed", message: "Kunde inte läsa klipp" });
      }
    },
  );

  // DELETE /api/clips/:id — Delete one clip (admin). Its shared link stops working at once.
  // ?onRequest=1 notes in the deletion log that someone asked for it.
  app.delete<{ Params: { id: string }; Querystring: { onRequest?: string } }>(
    "/api/clips/:id",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;

      const { id } = request.params;
      if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      try {
        const erased = await deleteClip(minio, id);
        if (!erased.found) {
          return reply.code(404).send({ error: "clip_not_found", message: "Klippet hittades inte" });
        }
        request.log.info(`Deleted clip ${id}: ${erased.files} files`);
        const streamId = erased.clips[0].streamId;
        const title = (await minio.readVodIndex().catch(() => [])).find((v) => v.id === streamId)?.matchTitle;
        await logDeletion(minio, {
          what: "clip",
          id,
          match: title,
          onRequest: request.query.onRequest === "1",
          files: erased.files,
        }).catch((err) => request.log.error(err, "Could not write the deletion log"));
        return reply.code(204).send();
      } catch (err) {
        request.log.error(err, "Failed to delete clip");
        return reply.code(500).send({ error: "delete_failed", message: "Kunde inte ta bort klippet" });
      }
    },
  );

  // GET /api/clips — List ALL highlight clips (persistent, from MinIO index)
  app.get(
    "/api/clips",
    async (request, reply) => {
      if (!requireViewerAuth(request, reply)) return;

      const clips = await minio.readClipsIndex();

      // Return newest first
      return reply.send([...clips].reverse());
    },
  );

  // POST /api/clips/backfill-mp4 — Generate MP4 for existing clips that lack it (admin only)
  app.post(
    "/api/clips/backfill-mp4",
    async (request, reply) => {
      if (!requireApiKey(request, reply)) return;

      const clips = await minio.readClipsIndex();
      const missing = clips.filter((c) => !c.mp4Url);

      if (missing.length === 0) {
        return reply.send({ message: "All clips already have MP4", converted: 0 });
      }

      let converted = 0;
      const errors: string[] = [];

      for (const clip of missing) {
        try {
          // Read the HLS manifest to find segment URLs
          const manifestKey = `clips/${clip.streamId}/${clip.id}.m3u8`;
          const manifest = await minio.readFile(manifestKey);
          if (!manifest) {
            errors.push(`${clip.id}: manifest not found`);
            continue;
          }

          // Manifests hold bare filenames; older ones held absolute URLs.
          // keysReferencedBy handles both.
          const segmentKeys = [...keysReferencedBy(manifest, `${clip.streamId}/`)];

          if (segmentKeys.length === 0) {
            errors.push(`${clip.id}: no segments in manifest`);
            continue;
          }

          const segmentBuffers = await Promise.all(
            segmentKeys.map(async (key) => ({
              key,
              data: await minio.downloadBuffer(key),
            })),
          );

          // Convert to MP4
          const mp4Buffer = await convertSegmentsToMp4(segmentBuffers);
          const mp4Key = minio.clipMp4Key(clip.streamId, clip.id);
          await minio.uploadBuffer(mp4Key, mp4Buffer, "video/mp4");

          clip.mp4Url = `/api/clips/${clip.id}/media/${clip.id}.mp4`;
          converted++;
          request.log.info(`Backfilled MP4 for clip ${clip.id} (${mp4Buffer.length} bytes)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${clip.id}: ${msg}`);
          request.log.warn(err, `Failed to backfill MP4 for clip ${clip.id}`);
        }
      }

      // Save updated index with mp4Urls
      if (converted > 0) {
        await minio.writeClipsIndex(clips);
      }

      return reply.send({ converted, errors: errors.length > 0 ? errors : undefined });
    },
  );

  // POST /api/clips/backfill-thumbnails — Generate thumbnails for clips that have MP4 but no thumbnail
  // Add ?force=true to regenerate all thumbnails (e.g. after logo change)
  app.post<{ Querystring: { force?: string } }>(
    "/api/clips/backfill-thumbnails",
    async (request, reply) => {
      if (!requireApiKey(request, reply)) return;

      const force = request.query.force === "true";
      const clips = await minio.readClipsIndex();
      const missing = force
        ? clips.filter((c) => c.mp4Url)
        : clips.filter((c) => c.mp4Url && !c.thumbnailUrl);

      if (missing.length === 0) {
        return reply.send({ message: "All clips already have thumbnails", generated: 0 });
      }

      let generated = 0;
      const errors: string[] = [];

      for (const clip of missing) {
        try {
          // Download the MP4 from MinIO
          const mp4Key = minio.clipMp4Key(clip.streamId, clip.id);
          const mp4Buffer = await minio.downloadBuffer(mp4Key);

          // Extract thumbnail (2s before end)
          const thumbBuffer = await extractThumbnail(mp4Buffer, 2);
          const thumbKey = `clips/${clip.streamId}/${clip.id}.jpg`;
          await minio.uploadBuffer(thumbKey, thumbBuffer, "image/jpeg");

          clip.thumbnailUrl = `/api/clips/${clip.id}/media/${clip.id}.jpg`;
          generated++;
          request.log.info(`Backfilled thumbnail for clip ${clip.id} (${thumbBuffer.length} bytes)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${clip.id}: ${msg}`);
          request.log.warn(err, `Failed to backfill thumbnail for clip ${clip.id}`);
        }
      }

      if (generated > 0) {
        await minio.writeClipsIndex(clips);
      }

      return reply.send({ generated, errors: errors.length > 0 ? errors : undefined });
    },
  );
}
