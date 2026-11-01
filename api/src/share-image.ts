/**
 * Share image per match (ABL-050) — the picture a link preview in WhatsApp or
 * iMessage shows for <site>/match/<id>.
 *
 * Link previews are fetched without the viewer code, so the picture is drawn,
 * never taken: the two teams' logos (or their short names on their colours),
 * the result once the match has one, the date and the club's name, in the
 * club's colour. Nothing from a recording, so nothing behind the PIN shows
 * here. No time or venue either: the schedule itself is behind the PIN.
 *
 * Drawn with the ffmpeg the API already ships for clips, so there is no new
 * dependency: the background and the badges are painted here into raw pixels,
 * ffmpeg lays the logos on top and writes the text with the bundled font
 * (assets/fonts, SIL Open Font License).
 *
 * Rendered when first asked for and kept in memory. The version, a hash of
 * everything drawn, goes into the og:image URL, so a chat app fetches the
 * picture again when the result or a logo changes.
 */
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Match, MatchTeam } from "./matches.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
// ffmpeg-static exports the path to the ffmpeg binary
const ffmpegPath: string = require("ffmpeg-static");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Barlow Condensed Bold, as the website's headings. assets/ relative to src/ or dist/. */
export const SHARE_FONT_PATH = path.join(__dirname, "..", "assets", "fonts", "BarlowCondensed-Bold.ttf");

/** The size Open Graph and Twitter recommend for a large preview. */
export const SHARE_WIDTH = 1200;
export const SHARE_HEIGHT = 630;

/** Bump when the layout changes, so every chat app fetches the new picture. */
const LAYOUT_VERSION = 1;

/** How many matches' pictures are kept in memory. */
const MAX_CACHED = 50;

type Rgb = [number, number, number];
type Logo = { bytes: Buffer; type: string };

const BACKGROUND: Rgb = [11, 11, 12];
const WHITE: Rgb = [255, 255, 255];
const MUTED: Rgb = [163, 163, 163];
const INK: Rgb = [17, 17, 17];

// ============================
// What is drawn
// ============================

export interface ShareTeam {
  name: string;
  shortName: string;
  color: string;
  /** Absent: the short name on the team's colour instead. */
  logo?: Logo;
}

export interface ShareDrawing {
  club: string;
  accentColor: string;
  /** YYYY-MM-DD */
  date: string;
  own: ShareTeam;
  opponent: ShareTeam;
  /** Own team first. */
  result?: { home: number; away: number };
}

const WEEKDAYS = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

/** "lördag 1 november 2026" */
export function formatShareDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (isNaN(d.getTime())) return date;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "P12 72 – 65 Hornets", or "P12 – Hornets" before there is a result. */
export function shareTitle(match: Pick<Match, "ownTeam" | "opponent" | "result">): string {
  const { ownTeam, opponent, result } = match;
  return result
    ? `${ownTeam.name} ${result.home} – ${result.away} ${opponent.name}`
    : `${ownTeam.name} – ${opponent.name}`;
}

// ============================
// Colours
// ============================

function parseColor(hex: string, fallback: Rgb): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;
}

/** The accent, lightened until it reads as text on the dark background (WCAG AA). */
function readableOnBackground(color: Rgb): Rgb {
  let out = color;
  for (let t = 0.1; contrast(out, BACKGROUND) < 4.5 && t <= 1; t += 0.1) out = mix(color, WHITE, t);
  return out;
}

/** White on a team colour, unless the admin chose one too light for it. */
function inkOn(color: Rgb): Rgb {
  return contrast(WHITE, color) >= 3 ? WHITE : INK;
}

function ffmpegColor(rgb: Rgb): string {
  return "0x" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
}

// ============================
// Pixels
// ============================

/** RGBA pixels with a few antialiased shapes: enough for a background and round badges. */
class Canvas {
  readonly data: Buffer;

  constructor(readonly width: number, readonly height: number, fill: Rgb) {
    this.data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = fill[0];
      this.data[i + 1] = fill[1];
      this.data[i + 2] = fill[2];
      this.data[i + 3] = 255;
    }
  }

  private blend(x: number, y: number, c: Rgb, a: number): void {
    if (a <= 0) return;
    const i = (y * this.width + x) * 4;
    for (let k = 0; k < 3; k++) this.data[i + k] = Math.round(this.data[i + k] + (c[k] - this.data[i + k]) * Math.min(a, 1));
  }

  fillRect(x: number, y: number, w: number, h: number, c: Rgb): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) this.blend(xx, yy, c, 1);
    }
  }

  /** A filled circle, its edge antialiased over one pixel. */
  fillCircle(cx: number, cy: number, r: number, c: Rgb, alpha = 1): void {
    this.forEachNear(cx, cy, r + 1, (x, y, d) => this.blend(x, y, c, alpha * Math.max(0, Math.min(1, r + 0.5 - d))));
  }

  /** A soft light fading out from the centre: strongest there, gone at r. */
  glow(cx: number, cy: number, r: number, c: Rgb, strength: number): void {
    this.forEachNear(cx, cy, r, (x, y, d) => {
      if (d < r) this.blend(x, y, c, strength * (1 - d / r) ** 2);
    });
  }

  private forEachNear(cx: number, cy: number, r: number, fn: (x: number, y: number, d: number) => void): void {
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(this.height, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(this.width, Math.ceil(cx + r)); x++) {
        fn(x, y, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
      }
    }
  }
}

// ============================
// Font metrics
// ============================

/** What layout needs from the font: advance widths, to shrink a long name until it fits. */
interface FontMetrics {
  unitsPerEm: number;
  capHeight: number;
  advance(codePoint: number): number;
}

/** Read widths from a TrueType font: head, hhea, OS/2, hmtx and a format 4 cmap. */
function readFontMetrics(font: Buffer): FontMetrics {
  const tables = new Map<string, number>();
  for (let i = 0, n = font.readUInt16BE(4); i < n; i++) {
    const rec = 12 + i * 16;
    tables.set(font.toString("latin1", rec, rec + 4), font.readUInt32BE(rec + 8));
  }
  const table = (tag: string): number => {
    const at = tables.get(tag);
    if (at === undefined) throw new Error(`Font has no ${tag} table`);
    return at;
  };

  const unitsPerEm = font.readUInt16BE(table("head") + 18);
  const numHMetrics = font.readUInt16BE(table("hhea") + 34);
  const hmtx = table("hmtx");
  const os2 = tables.get("OS/2");
  const capHeight = os2 !== undefined && font.readUInt16BE(os2) >= 2 ? font.readInt16BE(os2 + 88) : unitsPerEm * 0.7;

  // The Unicode BMP subtable: Windows (3, 1), or Unicode (0, 3).
  const cmap = table("cmap");
  let sub = -1;
  for (let i = 0, n = font.readUInt16BE(cmap + 2); i < n; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = font.readUInt16BE(rec);
    const encoding = font.readUInt16BE(rec + 2);
    const at = cmap + font.readUInt32BE(rec + 4);
    if (((platform === 3 && encoding === 1) || (platform === 0 && encoding === 3)) && font.readUInt16BE(at) === 4) sub = at;
  }
  if (sub < 0) throw new Error("Font has no format 4 cmap");
  const segments = font.readUInt16BE(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;

  const glyph = (c: number): number => {
    for (let i = 0; i < segments; i++) {
      if (c > font.readUInt16BE(ends + i * 2)) continue;
      const start = font.readUInt16BE(starts + i * 2);
      if (c < start) return 0;
      const delta = font.readInt16BE(deltas + i * 2);
      const rangeOffset = font.readUInt16BE(rangeOffsets + i * 2);
      if (rangeOffset === 0) return (c + delta) & 0xffff;
      const g = font.readUInt16BE(rangeOffsets + i * 2 + rangeOffset + (c - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };

  return {
    unitsPerEm,
    capHeight,
    advance(c: number): number {
      const g = c > 0xffff ? 0 : glyph(c);
      return font.readUInt16BE(hmtx + Math.min(g, numHMetrics - 1) * 4);
    },
  };
}

let metrics: FontMetrics | null = null;
function fontMetrics(): FontMetrics {
  metrics ??= readFontMetrics(readFileSync(SHARE_FONT_PATH));
  return metrics;
}

/** Width of a line of text in pixels at a font size. No kerning, as ffmpeg draws it. */
function textWidth(text: string, size: number): number {
  const f = fontMetrics();
  let units = 0;
  for (const ch of text) units += f.advance(ch.codePointAt(0)!);
  return (units * size) / f.unitsPerEm;
}

/** The largest size from `size` down to `min` that fits; below that, cut with an ellipsis. */
export function fitText(text: string, maxWidth: number, size: number, min: number): { text: string; size: number } {
  let s = size;
  while (s > min && textWidth(text, s) > maxWidth) s -= 2;
  s = Math.max(s, min);
  if (textWidth(text, s) <= maxWidth) return { text, size: s };
  const chars = [...text];
  while (chars.length > 1 && textWidth(chars.join("").trimEnd() + "…", s) > maxWidth) chars.pop();
  return { text: chars.join("").trimEnd() + "…", size: s };
}

/** Pixels from the baseline to the top of a capital at a font size. */
function capHeight(size: number): number {
  const f = fontMetrics();
  return (f.capHeight * size) / f.unitsPerEm;
}

// ============================
// Drawing
// ============================

const LOGO_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** A value inside a filtergraph: escaped for the option parser, then for the graph. */
function filterValue(value: string): string {
  return value.replace(/[\\':]/g, "\\$&").replace(/[\\'[\],;]/g, "\\$&");
}

interface TextItem {
  text: string;
  size: number;
  color: Rgb;
  /** Horizontal anchor: the centre, or the right edge with align "right", or the left edge. */
  x: number;
  align: "left" | "center" | "right";
  baseline: number;
}

/** Render the picture as a PNG, 1200 × 630. */
export async function renderShareImage(d: ShareDrawing): Promise<Buffer> {
  const W = SHARE_WIDTH;
  const H = SHARE_HEIGHT;
  const accent = parseColor(d.accentColor, [200, 164, 63]);
  const canvas = new Canvas(W, H, BACKGROUND);
  const texts: TextItem[] = [];
  const logos: { logo: Logo; cx: number; cy: number; size: number }[] = [];

  // The club's colour from the top, each team's behind its badge.
  const R = 120;
  const sides = [
    { team: d.own, cx: 240 },
    { team: d.opponent, cx: 960 },
  ];
  const badgeY = 300;
  canvas.glow(W / 2, -120, 760, accent, 0.3);
  for (const { team, cx } of sides) canvas.glow(cx, badgeY, 300, parseColor(team.color, MUTED), 0.35);
  canvas.fillRect(0, H - 14, W, 14, accent);

  // Header: the club on the left, the date on the right.
  const header = 92;
  texts.push({ ...fitText(d.club.toUpperCase(), 560, 36, 26), color: readableOnBackground(accent), x: 72, align: "left", baseline: header });
  texts.push({ ...fitText(formatShareDate(d.date).toUpperCase(), 440, 36, 26), color: MUTED, x: W - 72, align: "right", baseline: header });

  // Badges: the logo on a white plate, or the short name on the team's colour.
  for (const { team, cx } of sides) {
    canvas.fillCircle(cx, badgeY, R + 6, WHITE, 0.14);
    if (team.logo) {
      canvas.fillCircle(cx, badgeY, R, WHITE);
      logos.push({ logo: team.logo, cx, cy: badgeY, size: Math.round(R * 2 * 0.7) });
    } else {
      const color = parseColor(team.color, MUTED);
      canvas.fillCircle(cx, badgeY, R, color);
      const fit = fitText(team.shortName, R * 2 * 0.78, 104, 48);
      texts.push({ ...fit, color: inkOn(color), x: cx, align: "center", baseline: Math.round(badgeY + capHeight(fit.size) / 2) });
    }
    const name = fitText(team.name, 360, 54, 34);
    texts.push({ ...name, color: WHITE, x: cx, align: "center", baseline: 496 });
  }

  // Between the badges: the result, or a dash before there is one.
  const between = 960 - R - (240 + R) - 80;
  if (d.result) {
    const fit = fitText(`${d.result.home} – ${d.result.away}`, between, 150, 60);
    texts.push({ ...fit, color: WHITE, x: W / 2, align: "center", baseline: Math.round(badgeY + capHeight(fit.size) / 2) });
  } else {
    texts.push({ text: "–", size: 150, color: MUTED, x: W / 2, align: "center", baseline: Math.round(badgeY + capHeight(150) / 2) });
  }

  return ffmpegCompose(canvas, logos, texts);
}

async function ffmpegCompose(
  canvas: Canvas,
  logos: { logo: Logo; cx: number; cy: number; size: number }[],
  texts: TextItem[],
): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "courtside-share-"));
  try {
    await writeFile(path.join(dir, "base.rgba"), canvas.data);
    const inputs = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${canvas.width}x${canvas.height}`, "-i", "base.rgba"];
    const graph: string[] = [];
    let current = "0:v";
    for (const [i, { logo, cx, cy, size }] of logos.entries()) {
      const file = `logo${i}.${LOGO_EXTENSIONS[logo.type] ?? "png"}`;
      await writeFile(path.join(dir, file), logo.bytes);
      inputs.push("-i", file);
      const n = i + 1;
      graph.push(
        `[${n}:v]scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba[l${n}]`,
        `[${current}][l${n}]overlay=x=${cx}-overlay_w/2:y=${cy}-overlay_h/2[b${n}]`,
      );
      current = `b${n}`;
    }

    // Text goes through files, so a team name needs no escaping.
    const font = filterValue(SHARE_FONT_PATH);
    const draws: string[] = [];
    for (const [i, t] of texts.entries()) {
      await writeFile(path.join(dir, `text${i}.txt`), t.text);
      const x = t.align === "center" ? `${Math.round(t.x)}-text_w/2` : t.align === "right" ? `${Math.round(t.x)}-text_w` : `${Math.round(t.x)}`;
      // y is the top of the tallest glyph; ascent is its height above the baseline.
      draws.push(
        `drawtext=fontfile=${font}:textfile=text${i}.txt:expansion=none:fontsize=${t.size}` +
          `:fontcolor=${ffmpegColor(t.color)}:x=${x}:y=${t.baseline}-ascent`,
      );
    }
    graph.push(`[${current}]${[...draws, "format=rgb24"].join(",")}[out]`);

    const { stdout } = await execFileAsync(
      ffmpegPath,
      [
        "-hide_banner", "-loglevel", "error",
        ...inputs,
        "-filter_complex", graph.join(";"),
        "-map", "[out]", "-frames:v", "1",
        "-c:v", "png", "-compression_level", "9", "-f", "image2pipe", "-",
      ],
      { cwd: dir, encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 30000 },
    );
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================
// Versions and cache
// ============================

interface ShareSources {
  teamLogo(id: string): Promise<Logo | null>;
  /** The club logo uploaded in Hantera, or null. */
  clubLogo(): Promise<Logo | null>;
  /** Changes whenever the uploaded club logo does; null when there is none. */
  clubLogoVersion(): string | null;
  club(): { name: string; accentColor: string };
}

/**
 * Each match's picture, rendered when first asked for and kept while what it
 * shows stays the same.
 *
 * An own team without a logo of its own shows the club's: P12 is the club's
 * team, and the club logo says so better than "P12" on a colour.
 */
export class ShareImages {
  private readonly cache = new Map<string, { version: string; png: Buffer }>();
  private readonly pending = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly sources: ShareSources,
    private readonly render: (d: ShareDrawing) => Promise<Buffer> = renderShareImage,
  ) {}

  /** A hash of everything the picture shows: it changes when the picture does. */
  version(match: Match): string {
    const club = this.sources.club();
    const team = (t: MatchTeam) => [t.name, t.shortName, t.color, t.logoUrl ?? ""];
    const clubLogo = match.ownTeam.logoUrl ? "" : this.sources.clubLogoVersion() ?? "";
    const drawn = [
      LAYOUT_VERSION,
      club.name,
      club.accentColor,
      clubLogo,
      match.date,
      team(match.ownTeam),
      team(match.opponent),
      match.result ? [match.result.home, match.result.away] : null,
    ];
    return crypto.createHash("sha256").update(JSON.stringify(drawn)).digest("hex").slice(0, 12);
  }

  /** The match's picture as it is now, with its version. */
  async image(match: Match): Promise<{ version: string; png: Buffer }> {
    const version = this.version(match);
    const cached = this.cache.get(match.id);
    if (cached?.version === version) return cached;

    const key = `${match.id}:${version}`;
    let rendering = this.pending.get(key);
    if (!rendering) {
      rendering = this.draw(match).finally(() => this.pending.delete(key));
      this.pending.set(key, rendering);
    }
    const png = await rendering;
    this.cache.delete(match.id);
    this.cache.set(match.id, { version, png });
    // Oldest first in a Map: drop from the front.
    while (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
    return { version, png };
  }

  private async draw(match: Match): Promise<Buffer> {
    const club = this.sources.club();
    const [ownLogo, opponentLogo] = await Promise.all([
      this.logoOf(match.ownTeam).then((logo) => logo ?? this.sources.clubLogo().catch(() => null)),
      this.logoOf(match.opponent),
    ]);
    const drawing: ShareDrawing = {
      club: club.name,
      accentColor: club.accentColor,
      date: match.date,
      own: teamDrawing(match.ownTeam, ownLogo),
      opponent: teamDrawing(match.opponent, opponentLogo),
      ...(match.result && { result: match.result }),
    };
    try {
      return await this.render(drawing);
    } catch (err) {
      if (!drawing.own.logo && !drawing.opponent.logo) throw err;
      // A logo ffmpeg cannot read must not cost the match its picture.
      return this.render({ ...drawing, own: { ...drawing.own, logo: undefined }, opponent: { ...drawing.opponent, logo: undefined } });
    }
  }

  private async logoOf(team: MatchTeam): Promise<Logo | null> {
    if (!team.id || !team.logoUrl) return null;
    return this.sources.teamLogo(team.id).catch(() => null);
  }
}

function teamDrawing(team: MatchTeam, logo: Logo | null): ShareTeam {
  return { name: team.name, shortName: team.shortName, color: team.color, ...(logo && { logo }) };
}
