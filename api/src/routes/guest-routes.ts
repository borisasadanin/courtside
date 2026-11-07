/**
 * Guest routes (#51, #54): the opponent's coach and their clips.
 *
 * A guest logs in with the guest space's code and gets a guest token, which
 * opens /api/guest/* for that one space and nothing else on the platform (see
 * requireGuestAuth in auth.ts).  Viewer and admin tokens open nothing here;
 * admin manages guest spaces through its own routes.
 *
 * Shared guest clips work like the club's own shared clips: the clip id is the
 * capability.  Its MP4 and thumbnail are served to anyone with the id, so a
 * shared link plays without the code, until the space is deleted.  The shared
 * page and its link preview are neutral: no club logo, colour or name.
 *
 * Guest clips live in their own index (guest-spaces.json).  The club's clip
 * routes (/api/clips/*, /c/:id) read only the club's index, so a guest clip id
 * never resolves there, and these routes never read the club's index.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createGuestToken, requireGuestAuth } from "../auth.js";
import { guestSpaces, minio } from "../state.js";
import { clubManifest } from "../club-config.js";
import {
  deleteAfter,
  guestMp4Key,
  guestThumbnailKey,
  type GuestClip,
  type GuestSpace,
} from "../guest-spaces.js";
import { zipStream, type ZipEntry } from "../zip.js";

/** Same answer for a wrong code and for the code of a deleted space. */
const BAD_CODE = "Koden fungerar inte, eller så har klippen tagits bort.";

const CLIP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Dates and times in names are the club's local time. */
const TIME_ZONE = "Europe/Stockholm";

function isExpired(space: GuestSpace, now = Date.now()): boolean {
  return now > deleteAfter(space).getTime();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The origin the request came in on: chat apps need absolute URLs. */
function originOf(request: FastifyRequest): string {
  const proto = (request.headers["x-forwarded-proto"] as string) || request.protocol;
  const host = (request.headers["x-forwarded-host"] as string) || request.headers.host;
  return `${proto}://${host}`;
}

/** "2026-11-07" and "18-42-05" in the club's time zone. */
function localParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: "", time: "" };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: TIME_ZONE,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}-${parts.minute}-${parts.second}`,
  };
}

/** A file name part: no separators, controls or characters Windows refuses. */
function safeName(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "lag";
}

function matchName(space: GuestSpace): string {
  return `${safeName(space.homeTeam)} - ${safeName(space.awayTeam)}`;
}

/** Newest first, as on the club's own highlights. */
function newestFirst(clips: GuestClip[]): GuestClip[] {
  return [...clips].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** The result as it is now: the recording's, which admin may correct, else the space's copy. */
async function currentResult(space: GuestSpace): Promise<{ home: number; away: number } | null> {
  try {
    const vods = await minio.readVodIndex();
    for (const streamId of [...space.streamIds].reverse()) {
      const result = vods.find((v) => v.id === streamId)?.result;
      if (result) return { home: result.home, away: result.away };
    }
  } catch {
    // Fall back to the copy kept in the space.
  }
  return space.result ? { home: space.result.home, away: space.result.away } : null;
}

/** What the guest page shows. Never the code, never anything of the club's but its name and privacy contact. */
async function spaceView(space: GuestSpace) {
  return {
    homeTeam: space.homeTeam,
    awayTeam: space.awayTeam,
    result: await currentResult(space),
    venue: space.venue || null,
    matchDate: space.matchDate,
    deleteAfter: deleteAfter(space).toISOString(),
    clips: newestFirst(space.clips).map((c) => ({
      id: c.id,
      mp4Url: c.mp4Url,
      thumbnailUrl: c.thumbnailUrl ?? null,
      durationSeconds: c.durationSeconds,
      createdAt: c.createdAt,
      label: c.label ?? null,
    })),
    club: { name: clubManifest.name },
    privacy: {
      controller: clubManifest.privacy.controller || clubManifest.name,
      contact: clubManifest.privacy.contact,
      policyUrl: clubManifest.privacy.policyUrl,
    },
    product: clubManifest.product,
  };
}

/** A guest clip that may still be served, with its space. */
async function liveClip(id: string): Promise<{ space: GuestSpace; clip: GuestClip } | undefined> {
  if (!CLIP_ID.test(id)) return undefined;
  const found = await guestSpaces.findClip(id);
  return found && !isExpired(found.space) ? found : undefined;
}

export default async function guestRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/guest/login — the space's code for a guest token.
  // Rate limited per address like the viewer code. The limiter keeps its
  // counts in memory only, and nothing here logs the address.
  app.post<{ Body: { code?: unknown } }>("/api/guest/login", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const code = typeof request.body?.code === "string" ? request.body.code : "";
    const space = code ? await guestSpaces.byCode(code) : undefined;
    if (!space || isExpired(space)) {
      return reply.code(401).send({ error: "bad_code", message: BAD_CODE });
    }
    const { token, expiresAt } = createGuestToken(space);
    return reply.send({ token, expiresAt: new Date(expiresAt).toISOString(), space: await spaceView(space) });
  });

  // GET /api/guest/space — the guest's own space: match, clips, when they go.
  app.get("/api/guest/space", async (request, reply) => {
    const space = await requireGuestAuth(request, reply);
    if (!space) return;
    return reply.header("Cache-Control", "no-store").send(await spaceView(space));
  });

  // GET /api/guest/clips.zip — every clip of the space in one download, built
  // on request and never stored. The token may come as ?token=: this is a
  // plain link the browser downloads itself (so iPhone saves it to Files),
  // and such a link cannot carry an Authorization header.
  app.get<{ Querystring: { token?: string } }>("/api/guest/clips.zip", async (request, reply) => {
    const space = await requireGuestAuth(request, reply, { allowQuery: true });
    if (!space) return;
    if (space.clips.length === 0) {
      return reply.code(404).send({ error: "no_clips", message: "Det finns inga klipp att ladda ner." });
    }

    const base = matchName(space);
    const used = new Set<string>();
    const entries: ZipEntry[] = [...space.clips]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((clip) => {
        const { date, time } = localParts(clip.createdAt);
        let name = `${base} ${date} ${time}.mp4`;
        for (let n = 2; used.has(name); n++) name = `${base} ${date} ${time} (${n}).mp4`;
        used.add(name);
        return {
          name,
          date: new Date(clip.createdAt),
          load: () => minio.downloadBuffer(guestMp4Key(space.id, clip.id)),
        };
      });

    const fileName = `${base} ${localParts(space.matchDate).date}.zip`.trim();
    const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    reply
      .type("application/zip")
      .header("Cache-Control", "no-store")
      .header(
        "Content-Disposition",
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
    return reply.send(
      zipStream(entries, (entry, err) => request.log.warn(err, `Guest zip: left out ${entry.name}`)),
    );
  });

  // GET /api/guest/clips/:id/media/:file — a guest clip's MP4 or thumbnail.
  // Public by clip id, like a shared clip of the club's own: the shared page
  // plays it without the code. Only that clip's two files.
  app.get<{ Params: { id: string; file: string } }>(
    "/api/guest/clips/:id/media/:file",
    async (request, reply) => {
      const { id, file } = request.params;
      const found = await liveClip(id);
      if (!found) return reply.code(404).send({ error: "clip_not_found" });

      const key =
        file === `${id}.mp4` ? guestMp4Key(found.space.id, id)
        : file === `${id}.jpg` && found.clip.thumbnailUrl ? guestThumbnailKey(found.space.id, id)
        : null;
      if (!key) return reply.code(403).send({ error: "not_part_of_clip" });

      return reply.redirect(await minio.presignGet(key), 302);
    },
  );

  // GET /api/guest/clips/:id/public — a shared guest clip, no code. The match
  // and the product, nothing of the club's.
  app.get<{ Params: { id: string } }>("/api/guest/clips/:id/public", async (request, reply) => {
    const found = await liveClip(request.params.id);
    if (!found) {
      return reply.code(404).send({ error: "clip_not_found", message: "Klippet hittades inte" });
    }
    const { space, clip } = found;
    return reply.send({
      id: clip.id,
      mp4Url: clip.mp4Url,
      thumbnailUrl: clip.thumbnailUrl ?? null,
      durationSeconds: clip.durationSeconds,
      createdAt: clip.createdAt,
      label: clip.label ?? null,
      homeTeam: space.homeTeam,
      awayTeam: space.awayTeam,
      matchDate: space.matchDate,
      product: clubManifest.product,
    });
  });

  // GET /g/:id — the link a guest's share button hands out. Link preview for
  // chat apps, then on to the neutral clip page. No club logo or name.
  app.get<{ Params: { id: string } }>("/g/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const found = await liveClip(request.params.id);
    if (!found) {
      return reply.code(404).type("text/html; charset=utf-8").send("<h1>Klippet hittades inte</h1>");
    }
    const { space, clip } = found;
    const origin = originOf(request);
    const match = `${space.homeTeam} – ${space.awayTeam}`;
    const { date } = localParts(space.matchDate);
    const title = `${clip.label || "Höjdpunkt"} — ${match}`;
    const description = `Höjdpunkt från ${match}${date ? `, ${date}` : ""}.`;
    const image = clip.thumbnailUrl ? `${origin}${clip.thumbnailUrl}` : "";
    const pageUrl = `${origin}/guest-clip.html#${encodeURIComponent(clip.id)}`;

    const ua = (request.headers["user-agent"] || "").toLowerCase();
    const isBot = /whatsapp|facebookexternalhit|telegrambot|twitterbot|linkedinbot|slackbot|discordbot|bot|crawler|spider/i.test(ua);
    const redirect = isBot
      ? ""
      : `<meta http-equiv="refresh" content="1;url=${escapeHtml(pageUrl)}">
<script>setTimeout(function(){window.location.href=${JSON.stringify(pageUrl).replace(/</g, "\\u003c")}},800)</script>`;

    const html = `<!DOCTYPE html>
<html lang="sv">
<head>
<meta charset="UTF-8">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
${image ? `<meta property="og:image" content="${escapeHtml(image)}">\n` : ""}${redirect}
<title>${escapeHtml(title)}</title>
</head>
<body><p>Omdirigerar...</p></body>
</html>`;
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
