/**
 * Match links and their share image (ABL-050) — see share-image.ts.
 *
 * Both are public: a chat app fetches the link preview without the viewer
 * code. /match/<id> is the website itself with the match's og: tags filled
 * in; the website then asks for the viewer code as always, and the match's
 * data and recordings stay behind it. The image is drawn and shows no people.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { matches, teams } from "../state.js";
import { clubManifest } from "../club-config.js";
import type { Branding } from "../club-branding.js";
import type { Match } from "../matches.js";
import { SHARE_HEIGHT, SHARE_WIDTH, ShareImages, formatShareDate, shareTitle } from "../share-image.js";

/** Match ids are eight hex characters; anything far from that is not looked up. */
const MATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What the preview says under the title, by the match's status. */
const INVITE: Record<Match["status"], string> = {
  planned: "Matchen sänds live.",
  live: "Följ matchen live.",
  ended: "Se reprisen.",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The origin the request came in on: chat apps need absolute URLs. */
function originOf(request: FastifyRequest): string {
  const proto = (request.headers["x-forwarded-proto"] as string) || request.protocol;
  const host = (request.headers["x-forwarded-host"] as string) || request.headers.host;
  return `${proto}://${host}`;
}

/**
 * The website's page with the match's preview tags in place of the club's.
 * The page sets its own title and tags again once it runs; crawlers do not
 * run it.
 */
export function withMatchMeta(html: string, match: Match, origin: string, version: string): string {
  const title = shareTitle(match);
  const date = formatShareDate(match.date);
  const description = `${date[0].toUpperCase()}${date.slice(1)} · ${clubManifest.name}. ${INVITE[match.status]}`;
  const image = `${origin}/api/matches/${encodeURIComponent(match.id)}/share.png?v=${version}`;
  const url = `${origin}/match/${encodeURIComponent(match.id)}`;

  const tags: [string, string, string][] = [
    ["name", "description", description],
    ["property", "og:type", "website"],
    ["property", "og:site_name", clubManifest.name],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["property", "og:url", url],
    ["property", "og:image", image],
    ["property", "og:image:type", "image/png"],
    ["property", "og:image:width", String(SHARE_WIDTH)],
    ["property", "og:image:height", String(SHARE_HEIGHT)],
    ["property", "og:image:alt", title],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
    ["name", "twitter:image", image],
  ];
  const head = [
    `<title>${escapeHtml(`${title} — ${clubManifest.name}`)}</title>`,
    ...tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`),
  ].join("\n  ");

  return html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+(?:name|property)="(?:description|og:[^"]*|twitter:[^"]*)"[^>]*>\s*/gi, "")
    .replace(/<\/head>/i, `  ${head}\n</head>`);
}

export default async function shareRoutes(
  app: FastifyInstance,
  opts: { branding: Pick<Branding, "logo" | "logoVersion">; webRoot?: string | null },
): Promise<void> {
  const images = new ShareImages({
    teamLogo: (id) => teams.logo(id),
    clubLogo: () => opts.branding.logo(),
    clubLogoVersion: () => opts.branding.logoVersion(),
    club: () => ({ name: clubManifest.name, accentColor: clubManifest.accentColor }),
  });

  // GET /api/matches/:id/share.png — the link preview's picture. Public: it shows no people.
  app.get<{ Params: { id: string }; Querystring: { v?: string } }>(
    "/api/matches/:id/share.png",
    async (request, reply) => {
      const { id } = request.params;
      const match = MATCH_ID.test(id) ? await matches.get(id) : null;
      if (!match) return reply.code(404).send({ error: "match_not_found", message: "Matchen finns inte." });
      const { version, png } = await images.image(match);
      // The URL in the page's tags carries the version, so it can be cached
      // for good. Asked for under another version, the picture is the one
      // that is current, and only briefly kept.
      return reply
        .type("image/png")
        .header("Cache-Control", request.query.v === version ? "public, max-age=31536000, immutable" : "public, max-age=300")
        .send(png);
    },
  );

  // GET /match/:id — the link a match's share button hands out. Without a
  // built website there is no page to serve.
  const webRoot = opts.webRoot;
  if (!webRoot) return;
  app.get<{ Params: { id: string } }>("/match/:id", async (request, reply) => {
    const html = await readFile(join(webRoot, "index.html"), "utf8");
    reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache");

    const { id } = request.params;
    const match = MATCH_ID.test(id)
      ? await matches.get(id).catch((err) => {
          request.log.error(err, "Could not read the match for its link preview");
          return null;
        })
      : null;
    // An unknown match gets the website as it is: nothing tells it apart
    // from any other page that has no preview of its own.
    if (!match) return reply.send(html);
    return reply.send(withMatchMeta(html, match, originOf(request), images.version(match)));
  });
}
