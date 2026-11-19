/**
 * Sponsor clips (#87).
 *
 * Admin, behind the admin PIN:
 *
 *   GET    /api/admin/sponsors              every clip, the break lengths, the upload limit
 *   POST   /api/admin/sponsors/uploads      a new clip and a presigned PUT link for its file (#89)
 *   POST   /api/admin/sponsors/:id/uploaded the upload is done: check it and queue it (#90)
 *   PATCH  /api/admin/sponsors/:id          rename, or choose its slots (#93, #94)
 *   DELETE /api/admin/sponsors/:id          remove it and its files (#93)
 *   PUT    /api/admin/sponsors/order        the play order (#94)
 *   PATCH  /api/admin/sponsors/breaks       the break lengths (#94)
 *
 * Viewers, behind the viewer PIN like every other piece of video (#96):
 *
 *   GET    /api/sponsors                    the ready clips of every slot, in play order
 *   GET    /api/sponsors/:id/:file          a clip's playlist, segments and thumbnail
 *
 * The file itself never passes through the API: the proxy in front of it
 * refuses bodies over 64 MiB, so the browser uploads straight to storage.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isValidAdminToken, requireAdminAuth, requireViewerAuth } from "../auth.js";
import { minio, sponsors, sponsorQueue } from "../state.js";
import { rewriteSegmentUris } from "../playlist-rewrite.js";
import {
  MAX_UPLOAD_BYTES,
  SponsorError,
  originalKey,
  sponsorManifestKey,
  sponsorPrefix,
  sponsorThumbKey,
  type SponsorClip,
} from "../sponsors.js";

const ID = /^[a-f0-9]{12}$/;

/** A clip as the API shows it, with the URLs the website needs. */
function present(clip: SponsorClip) {
  const ready = clip.status === "ready";
  return {
    ...clip,
    ...(ready && {
      hlsUrl: `/api/sponsors/${clip.id}/index.m3u8`,
      thumbnailUrl: `/api/sponsors/${clip.id}/thumb.jpg`,
    }),
  };
}

/** Send a SponsorError as the admin's message; anything else is a 500 for Fastify to log. */
function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof SponsorError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

/** The admin previews clips in the same player the viewers use, so either PIN opens the media. */
function viewerOrAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const token = request.headers["x-admin-token"];
  if (typeof token === "string" && isValidAdminToken(token)) return true;
  return requireViewerAuth(request, reply);
}

export default async function sponsorRoutes(app: FastifyInstance): Promise<void> {
  // --- Admin ---

  app.get("/api/admin/sponsors", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    const { clips, breakSeconds } = await sponsors.read();
    return { clips: clips.map(present), breakSeconds, maxUploadBytes: MAX_UPLOAD_BYTES };
  });

  // #89: the clip is created first, so a failed upload leaves a row the admin can see and delete.
  app.post<{ Body: { name?: unknown; sizeBytes?: unknown; contentType?: unknown } | undefined }>(
    "/api/admin/sponsors/uploads",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      const { name, sizeBytes, contentType } = request.body ?? {};
      try {
        const clip = await sponsors.create(name, sizeBytes, contentType);
        const type = clip.contentType ?? "application/octet-stream";
        const uploadUrl = await minio.presignPut(originalKey(clip.id), type);
        return reply.code(201).send({
          clip: present(clip),
          upload: { method: "PUT", url: uploadUrl, headers: { "Content-Type": type } },
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // #90: the browser says the PUT finished. Storage is asked, not the browser.
  app.post<{ Params: { id: string } }>("/api/admin/sponsors/:id/uploaded", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    const { id } = request.params;
    if (!ID.test(id)) return reply.code(400).send({ error: "Ogiltigt klipp." });

    const clip = await sponsors.get(id);
    if (!clip) return reply.code(404).send({ error: "Klippet finns inte." });
    if (clip.status !== "uploading") return reply.code(409).send({ error: "Klippet är redan uppladdat." });

    const size = await minio.objectSize(originalKey(id));
    if (size === null) return reply.code(409).send({ error: "Filen har inte kommit fram. Ladda upp den igen." });
    if (size > MAX_UPLOAD_BYTES) {
      // The PUT link cannot cap the size, so a larger file is caught here.
      await minio.deleteObject(originalKey(id)).catch(() => {});
      const failed = await sponsors.patch(id, { status: "failed", error: "Filen får vara högst 200 MB." });
      return reply.code(413).send({ error: failed.error, clip: present(failed) });
    }

    const queued = await sponsors.patch(id, { status: "queued", sizeBytes: size });
    sponsorQueue.enqueue(id);
    return reply.code(202).send({ clip: present(queued) });
  });

  // Registered before /:id so "order" and "breaks" are not taken for clip ids.
  app.put<{ Body: { ids?: unknown } | undefined }>("/api/admin/sponsors/order", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      const { clips } = await sponsors.reorder(request.body?.ids);
      return { clips: clips.map(present) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Body: unknown }>("/api/admin/sponsors/breaks", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return { breakSeconds: await sponsors.setBreakSeconds(request.body) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown; slots?: unknown } | undefined }>(
    "/api/admin/sponsors/:id",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      const { id } = request.params;
      const body = request.body ?? {};
      if (body.name === undefined && body.slots === undefined) {
        return reply.code(400).send({ error: "Inget att ändra." });
      }
      try {
        let clip: SponsorClip | null = null;
        if (body.name !== undefined) clip = await sponsors.rename(id, body.name);
        if (body.slots !== undefined) clip = await sponsors.setSlots(id, body.slots);
        return { clip: present(clip!) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/admin/sponsors/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    const { id } = request.params;
    if (!ID.test(id)) return reply.code(400).send({ error: "Ogiltigt klipp." });
    if (!(await sponsors.remove(id))) return reply.code(404).send({ error: "Klippet finns inte." });
    return reply.code(204).send();
  });

  // --- Viewers (#96) ---

  app.get("/api/sponsors", async (request, reply) => {
    if (!requireViewerAuth(request, reply)) return;
    const playlist = await sponsors.playlist();
    const slots: Record<string, { id: string; name: string; durationSeconds?: number; hlsUrl: string }[]> = {};
    for (const [slot, clips] of Object.entries(playlist)) {
      slots[slot] = clips!.map((c) => ({
        id: c.id,
        name: c.name,
        durationSeconds: c.durationSeconds,
        hlsUrl: `/api/sponsors/${c.id}/index.m3u8`,
      }));
    }
    return reply.header("Cache-Control", "no-cache").send({ slots });
  });

  app.get<{ Params: { id: string; file: string } }>("/api/sponsors/:id/:file", async (request, reply) => {
    if (!viewerOrAdmin(request, reply)) return;
    const { id, file } = request.params;
    if (!ID.test(id)) return reply.code(400).send({ error: "invalid_id" });

    // Only a ready clip hands out files: not the original, not half a transcode.
    const clip = await sponsors.get(id);
    if (!clip || clip.status !== "ready") return reply.code(404).send({ error: "not_found" });

    if (file === "index.m3u8") {
      const manifest = await minio.readFile(sponsorManifestKey(id));
      if (!manifest) return reply.code(404).send({ error: "not_found" });
      return reply
        .type("application/vnd.apple.mpegurl")
        .header("Cache-Control", "no-cache")
        .send(rewriteSegmentUris(manifest, (name) => `/api/sponsors/${id}/${name}`));
    }

    let key: string;
    if (file === "thumb.jpg") key = sponsorThumbKey(id);
    else if (/^seg_\d{5}\.ts$/.test(file)) key = `${sponsorPrefix(id)}${file}`;
    else return reply.code(400).send({ error: "invalid_key" });

    return reply.redirect(await minio.presignGet(key), 302);
  });
}
