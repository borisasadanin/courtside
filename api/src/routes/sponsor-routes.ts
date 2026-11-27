/**
 * Sponsors and their clips (#87, #121).
 *
 * Admin, behind the admin PIN. The sponsors (#129):
 *
 *   GET    /api/admin/sponsorship                    sponsors, packages, surfaces, clips, season start
 *   POST   /api/admin/sponsorship/sponsors           a new sponsor
 *   PUT    /api/admin/sponsorship/sponsors/order     the sponsors' order; their clips follow
 *   PATCH  /api/admin/sponsorship/sponsors/:id       name, link, package, teams, surfaces off, active
 *   DELETE /api/admin/sponsorship/sponsors/:id       remove it and its logo; refused while it has clips
 *   PUT    /api/admin/sponsorship/sponsors/:id/logo  a logo as a data URL (#128)
 *   DELETE /api/admin/sponsorship/sponsors/:id/logo
 *   PATCH  /api/admin/sponsorship/surfaces           switch surfaces on or off for the installation
 *   PATCH  /api/admin/sponsorship/season             where the season's report starts
 *
 * The clips, as in v0.8:
 *
 *   GET    /api/admin/sponsors              every clip, the break lengths, the upload limit
 *   POST   /api/admin/sponsors/uploads      a new clip and a presigned PUT link for its file (#89)
 *   POST   /api/admin/sponsors/:id/uploaded the upload is done: check it and queue it (#90)
 *   PATCH  /api/admin/sponsors/:id          rename, choose its slots, or move it to another sponsor
 *   DELETE /api/admin/sponsors/:id          remove it and its files (#93)
 *   PUT    /api/admin/sponsors/order        the play order (#94)
 *   PATCH  /api/admin/sponsors/breaks       the break lengths (#94)
 *
 * Viewers, behind the viewer PIN like every other piece of video (#96):
 *
 *   GET    /api/sponsors?match=|stream=|vod=  who is shown on each surface of one match (#130)
 *   GET    /api/sponsors/play?surface=…     the ready clips of one surface, in play order,
 *                                           and the team to name in the banner
 *   GET    /api/sponsors/:id/:file          a clip's playlist, segments and thumbnail
 *
 * Public, like the teams' logos: GET /api/sponsor-logos/:id?v=…
 *
 * The file itself never passes through the API: the proxy in front of it
 * refuses bodies over 64 MiB, so the browser uploads straight to storage.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isValidAdminToken, requireAdminAuth, requireViewerAuth } from "../auth.js";
import { matches, minio, sponsors, sponsorQueue, streamMeta } from "../state.js";
import { defaultHomeTeam } from "../club-config.js";
import { rewriteSegmentUris } from "../playlist-rewrite.js";
import { ownTeamOf, type SponsorContext } from "../own-team.js";
import { SURFACES, sponsorsFor, type SponsorPick } from "../sponsor-surfaces.js";
import {
  MAX_UPLOAD_BYTES,
  SPONSOR_SLOTS,
  SponsorError,
  UPLOAD_LINK_SECONDS,
  originalKey,
  sponsorManifestKey,
  sponsorPrefix,
  sponsorThumbKey,
  type Sponsor,
  type SponsorClip,
  type SponsorInput,
  type SponsorSettings,
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

/** The logo's address. The version makes browsers fetch a replaced logo at once. */
function logoUrl(x: Sponsor): string | undefined {
  return x.logoType ? `/api/sponsor-logos/${x.id}?v=${encodeURIComponent(x.updatedAt)}` : undefined;
}

/** A sponsor as the admin sees it: everything, its logo's address and how many clips it has. */
function presentSponsor(x: Sponsor, s: SponsorSettings) {
  const { logoType: _type, ...rest } = x;
  const url = logoUrl(x);
  return { ...rest, ...(url && { logoUrl: url }), clipCount: s.clips.filter((c) => c.sponsorId === x.id).length };
}

/** Everything the Sponsring tab needs, in one answer. */
function overview(s: SponsorSettings) {
  return {
    sponsors: s.sponsors.map((x) => presentSponsor(x, s)),
    packages: s.packages,
    surfaces: SURFACES.map((d) => ({ ...d, on: s.surfaces[d.id] })),
    clips: s.clips.map(present),
    breakSeconds: s.breakSeconds,
    seasonStart: s.seasonStart ?? null,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
}

/**
 * A sponsor as a viewer sees it on one surface: name, logo, link and, on a
 * clip surface, its clips there. Never its package, its teams or what is off.
 */
function publicSponsor(pick: SponsorPick, kind: "clip" | "logo") {
  const { sponsor, clips } = pick;
  const url = logoUrl(sponsor);
  return {
    id: sponsor.id,
    name: sponsor.name,
    ...(url && { logoUrl: url }),
    ...(sponsor.url && { url: sponsor.url }),
    ...(kind === "clip" && {
      clips: clips.map((c) => ({ id: c.id, durationSec: c.durationSeconds, hlsUrl: `/api/sponsors/${c.id}/index.m3u8` })),
    }),
  };
}

/** The viewer's match, stream or replay from the query. */
function contextOf(q: { match?: string; stream?: string; vod?: string }): SponsorContext {
  return {
    ...(typeof q.match === "string" && q.match && { matchId: q.match }),
    ...(typeof q.stream === "string" && q.stream && { streamId: q.stream }),
    ...(typeof q.vod === "string" && q.vod && { vodId: q.vod }),
  };
}

/**
 * The team the banner names: the home team of the stream that is
 * broadcasting, the replay's, the match's own, and otherwise the club's own
 * short name.
 */
async function teamNameOf(ctx: SponsorContext): Promise<string> {
  if (ctx.streamId) {
    const name = streamMeta.get(ctx.streamId)?.homeTeam;
    if (name) return name;
  }
  if (ctx.vodId) {
    const vod = (await minio.readVodIndex().catch(() => [])).find((v) => v.id === ctx.vodId);
    if (vod?.homeTeam) return vod.homeTeam;
  }
  if (ctx.matchId) {
    const name = (await matches.summary(ctx.matchId).catch(() => null))?.ownTeam.name;
    if (name) return name;
  }
  return defaultHomeTeam;
}

/** Send a SponsorError as the admin's message; anything else is a 500 for Fastify to log. */
function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof SponsorError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

/**
 * The admin previews clips too, so either PIN opens the media. The admin's
 * token comes as "Authorization: Bearer", not X-Admin-Token: the files are a
 * redirect to storage, a browser carries a custom header along on that
 * redirect, and storage's CORS allows only Content-Type, Authorization and
 * x-jwt. Authorization is dropped on a cross-origin redirect.
 */
function viewerOrAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ") && isValidAdminToken(auth.slice(7))) return true;
  const token = request.headers["x-admin-token"];
  if (typeof token === "string" && isValidAdminToken(token)) return true;
  return requireViewerAuth(request, reply);
}

export default async function sponsorRoutes(app: FastifyInstance): Promise<void> {
  // --- Admin: sponsors (#129) ---

  app.get("/api/admin/sponsorship", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    await sponsors.expireAbandonedUploads();
    return reply.header("Cache-Control", "no-cache").send(overview(await sponsors.readAll()));
  });

  app.post<{ Body: SponsorInput | undefined }>("/api/admin/sponsorship/sponsors", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      const created = await sponsors.createSponsor(request.body ?? {});
      return reply.code(201).send({ sponsor: presentSponsor(created, await sponsors.readAll()) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Registered before /:id so "order" is not taken for a sponsor id.
  app.put<{ Body: { ids?: unknown } | undefined }>("/api/admin/sponsorship/sponsors/order", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      await sponsors.reorderSponsors(request.body?.ids);
      return overview(await sponsors.readAll());
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: SponsorInput | undefined }>(
    "/api/admin/sponsorship/sponsors/:id",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      try {
        const changed = await sponsors.patchSponsor(request.params.id, request.body ?? {});
        return { sponsor: presentSponsor(changed, await sponsors.readAll()) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/admin/sponsorship/sponsors/:id", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      await sponsors.removeSponsor(request.params.id);
      return reply.code(204).send();
    } catch (err) {
      return fail(reply, err);
    }
  });

  // #128: a data URL, already shrunk by the admin view; scaled again here whatever came.
  app.put<{ Params: { id: string }; Body: { dataUrl?: unknown } | undefined }>(
    "/api/admin/sponsorship/sponsors/:id/logo",
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      try {
        const dataUrl = typeof request.body?.dataUrl === "string" ? request.body.dataUrl : "";
        const changed = await sponsors.setLogo(request.params.id, dataUrl);
        return { sponsor: presentSponsor(changed, await sponsors.readAll()) };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/admin/sponsorship/sponsors/:id/logo", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      const changed = await sponsors.removeLogo(request.params.id);
      return { sponsor: presentSponsor(changed, await sponsors.readAll()) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Body: unknown }>("/api/admin/sponsorship/surfaces", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      await sponsors.setSurfaces(request.body);
      return { surfaces: overview(await sponsors.readAll()).surfaces };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Body: { seasonStart?: unknown } | undefined }>("/api/admin/sponsorship/season", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return { seasonStart: await sponsors.setSeasonStart(request.body?.seasonStart ?? null) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Admin: clips ---

  app.get("/api/admin/sponsors", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    await sponsors.expireAbandonedUploads();
    const { clips, breakSeconds } = await sponsors.read();
    return { clips: clips.map(present), breakSeconds, maxUploadBytes: MAX_UPLOAD_BYTES };
  });

  // #89: the clip is created first, so a failed upload leaves a row the admin can see and delete.
  // Without sponsorId, as v0.8's page sends it, the clip gets a sponsor of its own (#129).
  app.post<{ Body: { name?: unknown; sizeBytes?: unknown; contentType?: unknown; sponsorId?: unknown } | undefined }>(
    "/api/admin/sponsors/uploads",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      const { name, sizeBytes, contentType, sponsorId } = request.body ?? {};
      try {
        const clip = await sponsors.create(name, sizeBytes, contentType, sponsorId);
        const type = clip.contentType ?? "application/octet-stream";
        const uploadUrl = await minio.presignPut(originalKey(clip.id), type, UPLOAD_LINK_SECONDS);
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

  app.patch<{ Params: { id: string }; Body: { name?: unknown; slots?: unknown; sponsorId?: unknown } | undefined }>(
    "/api/admin/sponsors/:id",
    async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      const { id } = request.params;
      const body = request.body ?? {};
      if (body.name === undefined && body.slots === undefined && body.sponsorId === undefined) {
        return reply.code(400).send({ error: "Inget att ändra." });
      }
      try {
        let clip: SponsorClip | null = null;
        if (body.name !== undefined) clip = await sponsors.rename(id, body.name);
        if (body.slots !== undefined) clip = await sponsors.setSlots(id, body.slots);
        if (body.sponsorId !== undefined) clip = await sponsors.setClipSponsor(id, body.sponsorId);
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

  // #130: who is shown on each surface of one match, stream or replay. Only
  // surfaces that are on and have someone to show; only the sponsors of that
  // match's team and the club's. Never the registry itself.
  app.get<{ Querystring: { match?: string; stream?: string; vod?: string } }>("/api/sponsors", async (request, reply) => {
    if (!requireViewerAuth(request, reply)) return;
    const ctx = contextOf(request.query);
    const [teamId, settings, teamName] = await Promise.all([ownTeamOf(ctx), sponsors.readAll(), teamNameOf(ctx)]);
    const surfaces: Record<string, ReturnType<typeof publicSponsor>[]> = {};
    for (const def of SURFACES) {
      const picks = sponsorsFor(settings, teamId, def.id);
      if (picks.length > 0) surfaces[def.id] = picks.map((p) => publicSponsor(p, def.kind));
    }
    return reply.header("Cache-Control", "no-cache").send({ teamName, surfaces });
  });

  // `surface` is start, p1, p2, p3, ot or end. `stream`, `match` or `vod`
  // says which match: its team's sponsors come first, other teams' are left
  // out, and the banner names its team. Each clip carries its sponsor's name.
  app.get<{ Querystring: { surface?: string; stream?: string; match?: string; vod?: string } }>("/api/sponsors/play", async (request, reply) => {
    if (!requireViewerAuth(request, reply)) return;
    const { surface } = request.query;
    if (!SPONSOR_SLOTS.includes(surface as (typeof SPONSOR_SLOTS)[number])) {
      return reply.code(400).send({ error: "invalid_surface" });
    }
    const ctx = contextOf(request.query);
    const [teamId, settings, teamName] = await Promise.all([ownTeamOf(ctx), sponsors.readAll(), teamNameOf(ctx)]);
    const clips = sponsorsFor(settings, teamId, surface!).flatMap(({ sponsor, clips: own }) => own.map((c) => ({
      id: c.id,
      name: sponsor.name,
      durationSec: c.durationSeconds,
      hlsUrl: `/api/sponsors/${c.id}/index.m3u8`,
    })));
    return reply.header("Cache-Control", "no-cache").send({ surface, teamName, clips });
  });

  // #128: public like the teams' logos, so a shared image can show it to anyone.
  // The URL carries a version, so it can be cached hard.
  app.get<{ Params: { id: string } }>("/api/sponsor-logos/:id", async (request, reply) => {
    if (!ID.test(request.params.id)) return reply.code(400).send({ error: "invalid_id" });
    const logo = await sponsors.logo(request.params.id).catch(() => null);
    if (!logo) return reply.code(404).send({ error: "no_logo" });
    return reply
      .header("Content-Type", logo.type)
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(logo.bytes);
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
