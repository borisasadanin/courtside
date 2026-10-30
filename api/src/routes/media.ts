/**
 * Media access — the only way to reach recorded video.
 *
 * The storage bucket is private.  Every segment, MP4 and thumbnail is fetched
 * through one of these routes, which check who is asking and then redirect to a
 * short-lived presigned URL.  The bytes still travel straight from storage to
 * the viewer, so the backend never carries video traffic; it only decides.
 *
 * Two kinds of access, deliberately different:
 *
 *   /api/media/*            — match footage. Requires viewer auth (the PIN), the
 *                             same gate as the rest of the site.
 *
 *   /api/clips/:id/media/*  — a shared highlight. No PIN, because the point of a
 *                             clip link is that it can be sent to a grandparent.
 *                             The clip id is the capability, and access is
 *                             limited to the files that clip's own manifest
 *                             references — knowing one clip never opens the
 *                             rest of the match.  The exception is the clip's
 *                             MP4, which is a download: that is for viewers on
 *                             the site, behind the PIN.  A shared clip plays
 *                             from its segments and shows its thumbnail.
 */
import type { FastifyInstance } from "fastify";
import { requireViewerAuth } from "../auth.js";
import { minio } from "../state.js";

/** Reject keys that try to escape their prefix or reach outside the bucket. */
export function isSafeKey(key: string): boolean {
  if (!key || key.length > 512) return false;
  if (key.startsWith("/") || key.includes("..")) return false;
  if (key.includes("//") || key.includes("\\")) return false;
  // Only the characters our own keys actually use.
  return /^[A-Za-z0-9._\-/]+$/.test(key);
}

/**
 * What /api/media/* will sign: video, audio and images.  The bucket also holds
 * the installation's own state (indexes, the camera registry, the PINs chosen
 * at setup), and a viewer PIN must never be a way to read any of it.
 */
export function isMediaKey(key: string): boolean {
  return /\.(ts|m4s|mp4|aac|jpe?g|png|vtt)$/i.test(key);
}

/** Segment URIs referenced by an HLS manifest, as storage keys. */
export function keysReferencedBy(manifest: string, prefix: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of manifest.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Manifests may hold bare filenames or absolute URLs from older versions.
    const name = line.split("?")[0].split("/").pop();
    if (name) keys.add(`${prefix}${name}`);
  }
  return keys;
}

export default async function mediaRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/media/* — match footage, behind the viewer PIN
  app.get<{ Params: { "*": string } }>("/api/media/*", async (request, reply) => {
    if (!requireViewerAuth(request, reply)) return;

    const key = request.params["*"];
    if (!isSafeKey(key) || !isMediaKey(key)) {
      return reply.code(400).send({ error: "invalid_key" });
    }

    const url = await minio.presignGet(key);
    return reply.redirect(url, 302);
  });

  // GET /api/clips/:id/media/:file — one shared clip's own files, no PIN
  app.get<{ Params: { id: string; file: string } }>(
    "/api/clips/:id/media/:file",
    async (request, reply) => {
      const { id, file } = request.params;
      if (!isSafeKey(id) || !isSafeKey(file) || file.includes("/")) {
        return reply.code(400).send({ error: "invalid_key" });
      }

      const clips = await minio.readClipsIndex();
      const clip = clips.find((c) => c.id === id);
      if (!clip) {
        return reply.code(404).send({ error: "clip_not_found" });
      }

      // Downloading a clip is for viewers on the site, not for anyone with the link.
      if (file === `${clip.id}.mp4` && !requireViewerAuth(request, reply)) return;

      // A clip hands out its own MP4 and thumbnail, plus exactly the segments
      // its manifest lists — nothing else. Knowing one clip link never opens
      // the rest of the match.
      const key = await resolveClipFile(clip.streamId, clip.id, file);
      if (!key) {
        return reply.code(403).send({ error: "not_part_of_clip" });
      }

      const url = await minio.presignGet(key);
      return reply.redirect(url, 302);
    },
  );

  /** Map a filename to a storage key, or null when the clip does not own it. */
  async function resolveClipFile(
    streamId: string,
    clipId: string,
    file: string
  ): Promise<string | null> {
    if (file === `${clipId}.mp4`) return minio.clipMp4Key(streamId, clipId);
    if (file === `${clipId}.jpg`) return minio.clipThumbnailKey(streamId, clipId);

    const manifest = await minio.readFile(minio.clipManifestKey(streamId, clipId));
    if (!manifest) return null;

    const allowed = keysReferencedBy(manifest, `${streamId}/`);
    const key = `${streamId}/${file}`;
    return allowed.has(key) ? key : null;
  }
}
