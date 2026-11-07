/**
 * Guest spaces in admin (#55): every match's guest space with its code, link
 * and clips, so the club can send the code to the opponent and delete clips.
 *
 * Admin sees only spaces that have clips: a space is created with its first
 * opponent clip, and one whose clips admin has deleted is left out of the list
 * until it is deleted after its 14 days (or gets new clips from a restarted
 * match).  It still opens by id, so the page admin is on does not vanish.
 *
 * The clips play through an admin-only media route of their own, so admin does
 * not depend on the guest's code-protected routes.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAdminAuth } from "../auth.js";
import { guestSpaces, minio } from "../state.js";
import { clubManifest } from "../club-config.js";
import { logDeletion } from "../erasure.js";
import { deleteAfter, guestMp4Key, guestThumbnailKey, type GuestClip, type GuestSpace } from "../guest-spaces.js";

const STOCKHOLM = "Europe/Stockholm";

/** The guest page, where the opponent types the code. The link never holds the code. */
function guestLink(request: FastifyRequest): string {
  if (clubManifest.siteUrl) return `${clubManifest.siteUrl}/gast`;
  const proto = (request.headers["x-forwarded-proto"] as string) || request.protocol;
  const host = (request.headers["x-forwarded-host"] as string) || request.headers.host;
  return `${proto}://${host}/gast`;
}

/** "7 november 2026". A bare date is that day; a timestamp is read in Swedish time. */
export function swedishDate(value: string | Date): string {
  const date =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T12:00:00Z`)
      : new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("sv-SE", { day: "numeric", month: "long", year: "numeric", timeZone: STOCKHOLM });
}

export interface InvitationFields {
  homeTeam: string;
  awayTeam: string;
  matchDate: string;
  link: string;
  code: string;
  deleteAfter: string | Date;
  product: { name: string; url: string };
}

/**
 * The invitation admin pastes into an email or text message to the opponent.
 * Reword it here; it is the only copy.
 */
export function guestInvitation(f: InvitationFields): string {
  return (
    `Hej! Här är era highlights från ${f.homeTeam} – ${f.awayTeam}, ${swedishDate(f.matchDate)}. ` +
    `Gå till ${f.link} och skriv in koden ${f.code}. ` +
    `Klippen raderas för alltid den ${swedishDate(f.deleteAfter)}, så ladda ner det ni vill spara. ` +
    `Klippen är inspelade med ${f.product.name}, som er klubb också kan använda: ${f.product.url}`
  );
}

/** The match's result: the recording's own, if it has one (it may have been corrected), else the space's copy. */
async function resultsByStream(): Promise<Map<string, { home: number; away: number }>> {
  const vods = await minio.readVodIndex().catch(() => []);
  const results = new Map<string, { home: number; away: number }>();
  for (const v of vods) if (v.result) results.set(v.id, { home: v.result.home, away: v.result.away });
  return results;
}

function resultOf(space: GuestSpace, results: Map<string, { home: number; away: number }>) {
  // The newest stream of a restarted match has the final score.
  for (const id of [...space.streamIds].reverse()) {
    const r = results.get(id);
    if (r) return r;
  }
  return space.result ?? null;
}

function mediaPath(spaceId: string, clipId: string, ext: "mp4" | "jpg"): string {
  return `/api/admin/guest-spaces/${encodeURIComponent(spaceId)}/clips/${encodeURIComponent(clipId)}/media/${clipId}.${ext}`;
}

function summary(space: GuestSpace, link: string, results: Map<string, { home: number; away: number }>) {
  const until = deleteAfter(space).toISOString();
  return {
    id: space.id,
    matchId: space.matchId ?? null,
    streamIds: space.streamIds,
    homeTeam: space.homeTeam,
    awayTeam: space.awayTeam,
    venue: space.venue ?? null,
    matchDate: space.matchDate,
    result: resultOf(space, results),
    code: space.code,
    link,
    clipCount: space.clips.length,
    createdAt: space.createdAt,
    deleteAfter: until,
    invitation: guestInvitation({
      homeTeam: space.homeTeam,
      awayTeam: space.awayTeam,
      matchDate: space.matchDate,
      link,
      code: space.code,
      deleteAfter: until,
      product: clubManifest.product,
    }),
  };
}

function adminClip(spaceId: string, clip: GuestClip) {
  return {
    id: clip.id,
    label: clip.label ?? null,
    durationSeconds: clip.durationSeconds,
    createdAt: clip.createdAt,
    mp4Url: mediaPath(spaceId, clip.id, "mp4"),
    thumbnailUrl: clip.thumbnailUrl ? mediaPath(spaceId, clip.id, "jpg") : null,
  };
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export default async function guestAdminRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/guest-spaces — every space with clips, newest match first
  app.get("/api/admin/guest-spaces", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    const [spaces, results] = await Promise.all([guestSpaces.list(), resultsByStream()]);
    const link = guestLink(request);
    return spaces
      .filter((s) => s.clips.length > 0)
      .sort((a, b) => (b.matchDate || b.createdAt).localeCompare(a.matchDate || a.createdAt) || b.createdAt.localeCompare(a.createdAt))
      .map((s) => summary(s, link, results));
  });

  // GET /api/admin/guest-spaces/:id — one space with its clips, oldest clip first (match order)
  app.get<{ Params: { id: string } }>("/api/admin/guest-spaces/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    const space = await guestSpaces.get(request.params.id);
    if (!space) return reply.code(404).send({ error: "guest_space_not_found", message: "Gästytan finns inte" });
    const results = await resultsByStream();
    const clips = [...space.clips].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { ...summary(space, guestLink(request), results), clips: clips.map((c) => adminClip(space.id, c)) };
  });

  // GET /api/admin/guest-spaces/:id/clips/:clipId/media/:file — a guest clip's MP4 or thumbnail, for admin.
  // A redirect to the file; with ?link=1 the signed address as JSON instead, so the
  // page can hand it to <video>/<img>, which cannot send the admin header.
  app.get<{ Params: { id: string; clipId: string; file: string }; Querystring: { link?: string } }>(
    "/api/admin/guest-spaces/:id/clips/:clipId/media/:file",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      const { id, clipId, file } = request.params;
      if (!SAFE_ID.test(id) || !SAFE_ID.test(clipId)) return reply.code(400).send({ error: "invalid_key" });
      const space = await guestSpaces.get(id);
      if (!space?.clips.some((c) => c.id === clipId)) return reply.code(404).send({ error: "clip_not_found" });
      const key =
        file === `${clipId}.mp4` ? guestMp4Key(id, clipId) : file === `${clipId}.jpg` ? guestThumbnailKey(id, clipId) : null;
      if (!key) return reply.code(403).send({ error: "not_part_of_clip" });
      const url = await minio.presignGet(key, 3600);
      if (request.query.link === "1") return { url };
      return reply.redirect(url, 302);
    },
  );

  /**
   * Remove one clip (clipId) or all of them, and note it in the deletion log:
   * one clip under its own id, all of them as one entry under the space's id
   * with the number of clips.
   */
  async function remove(
    request: FastifyRequest<{ Params: { id: string }; Querystring: { onRequest?: string } }>,
    clipId?: string,
  ) {
    const erased = await guestSpaces.removeClips(request.params.id, clipId ? [clipId] : undefined);
    if (!erased) return undefined;
    if (erased.removed.length > 0) {
      await logDeletion(minio, {
        what: "guest-clip",
        id: clipId ?? erased.space.id,
        match: `${erased.space.homeTeam} – ${erased.space.awayTeam}`,
        onRequest: request.query.onRequest === "1",
        files: erased.files,
        ...(clipId ? {} : { clips: erased.removed.length }),
      }).catch((err) => request.log.error(err, "Could not write the deletion log"));
    }
    request.log.info(`Guest space ${erased.space.id}: deleted ${erased.removed.length} clips, ${erased.files} files`);
    return erased;
  }

  // DELETE /api/admin/guest-spaces/:id/clips/:clipId — one clip. ?onRequest=1 as for the club's clips.
  app.delete<{ Params: { id: string; clipId: string }; Querystring: { onRequest?: string } }>(
    "/api/admin/guest-spaces/:id/clips/:clipId",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      const { clipId } = request.params;
      const space = await guestSpaces.get(request.params.id);
      if (!space) return reply.code(404).send({ error: "guest_space_not_found", message: "Gästytan finns inte" });
      if (!space.clips.some((c) => c.id === clipId)) {
        return reply.code(404).send({ error: "clip_not_found", message: "Klippet hittades inte" });
      }
      try {
        await remove(request, clipId);
        return reply.code(204).send();
      } catch (err) {
        request.log.error(err, "Failed to delete guest clip");
        return reply.code(500).send({ error: "delete_failed", message: "Kunde inte ta bort klippet" });
      }
    },
  );

  // DELETE /api/admin/guest-spaces/:id/clips — every clip of the space (the page asks first)
  app.delete<{ Params: { id: string }; Querystring: { onRequest?: string } }>(
    "/api/admin/guest-spaces/:id/clips",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      try {
        const erased = await remove(request);
        if (!erased) return reply.code(404).send({ error: "guest_space_not_found", message: "Gästytan finns inte" });
        return reply.send({ removed: erased.removed.length, files: erased.files });
      } catch (err) {
        request.log.error(err, "Failed to delete guest clips");
        return reply.code(500).send({ error: "delete_failed", message: "Kunde inte ta bort klippen" });
      }
    },
  );

  // POST /api/admin/guest-spaces/:id/code — a new random code; the old one stops working at once
  app.post<{ Params: { id: string } }>("/api/admin/guest-spaces/:id/code", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    const space = await guestSpaces.newCode(request.params.id);
    if (!space) return reply.code(404).send({ error: "guest_space_not_found", message: "Gästytan finns inte" });
    request.log.info(`Guest space ${space.id}: new code`);
    return { code: space.code };
  });
}
