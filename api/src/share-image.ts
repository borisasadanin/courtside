/**
 * Share image per match (ABL-050) — the picture a link preview in WhatsApp or
 * iMessage shows for <site>/match/<id>.
 *
 * Link previews are fetched without the viewer code, so the picture is drawn,
 * never taken: the two teams' logos (or their short names on their colours),
 * the result once the match has one, the date, the venue and the club's
 * name, in the club's colour, and the time for a match still to be played.
 * Nothing from a recording, so nothing behind the PIN shows here.
 *
 * The background, the badges and the text are painted here into raw pixels;
 * the text from the bundled font's outlines (assets/fonts, SIL Open Font
 * License), read with opentype.js. The ffmpeg the API already ships for clips
 * then only lays the logos on top and writes the PNG: the ffmpeg-static build
 * on the host has no drawtext filter (#195).
 *
 * With the sponsor surface "share-image" on, the main sponsor's logo sits in
 * the lower right corner (#153). Off, the picture is exactly as before.
 *
 * Rendered when first asked for and kept in memory. The version, a hash of
 * everything drawn, goes into the og:image URL, so a chat app fetches the
 * picture again when the result or a logo changes, the sponsor's included.
 *
 * A shared clip's preview (#161) is drawn here too: its thumbnail with the
 * sponsor of "shared-clip" in the corner, the same way and with the same
 * kind of version.
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
const LAYOUT_VERSION = 3;

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
  /** HH:MM, only for a match still to be played. */
  time?: string;
  venue?: string;
  own: ShareTeam;
  opponent: ShareTeam;
  /** Own team first. */
  result?: { home: number; away: number };
  /** The main sponsor's logo, in the lower right corner (#153). */
  sponsorLogo?: Logo;
}

const WEEKDAYS = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];

/** "lördag 1 november 2026" */
export function formatShareDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (isNaN(d.getTime())) return date;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The date, with the time for a match still to be played: "lördag 8 november 2026 kl. 14:00". */
export function shareWhen(match: Pick<Match, "date" | "time" | "status">): string {
  const date = formatShareDate(match.date);
  return match.status === "planned" && match.time ? `${date} kl. ${match.time}` : date;
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

  /** A filled rectangle with round corners of radius r, at whole pixels. */
  fillRoundRect(x: number, y: number, w: number, h: number, r: number, c: Rgb): void {
    this.fillRect(x + r, y, w - 2 * r, h, c);
    this.fillRect(x, y + r, r, h - 2 * r, c);
    this.fillRect(x + w - r, y + r, r, h - 2 * r, c);
    // Each corner: its centre, and the top left of the r × r square it fills.
    const corners = [
      [x + r, y + r, x, y],
      [x + w - r, y + r, x + w - r, y],
      [x + r, y + h - r, x, y + h - r],
      [x + w - r, y + h - r, x + w - r, y + h - r],
    ];
    for (const [cx, cy, qx, qy] of corners) {
      for (let py = Math.max(0, qy); py < Math.min(this.height, qy + r); py++) {
        for (let px = Math.max(0, qx); px < Math.min(this.width, qx + r); px++) {
          this.blend(px, py, c, Math.max(0, Math.min(1, r + 0.5 - Math.hypot(px + 0.5 - cx, py + 0.5 - cy))));
        }
      }
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

  /** Fill a shape given as closed polygons, by the non-zero rule, antialiased (see fillPolygons). */
  fillPolygons(polygons: number[][], c: Rgb): void {
    fillPolygons(polygons, this.width, this.height, (x, y, a) => this.blend(x, y, c, a));
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
// Text
// ============================

/** Sub-scanlines per pixel row. Across a row, coverage is exact. */
const SUBSAMPLES = 16;

/**
 * Fill polygons by the non-zero winding rule, with antialiasing: each pixel
 * row is sampled at SUBSAMPLES heights, and each sample adds the exact part
 * of every pixel its spans cover. `plot` gets each touched pixel's coverage.
 */
export function fillPolygons(
  polygons: number[][],
  width: number,
  height: number,
  plot: (x: number, y: number, coverage: number) => void,
): void {
  // Edges as x0, y0, x1, y1, direction; horizontal ones never cross a scanline.
  const edges: number[][] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const pts of polygons) {
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const j = (i + 2) % pts.length;
      const [x0, y0, x1, y1] = [pts[i], pts[i + 1], pts[j], pts[j + 1]];
      minX = Math.min(minX, x0); maxX = Math.max(maxX, x0);
      minY = Math.min(minY, y0); maxY = Math.max(maxY, y0);
      if (y0 !== y1) edges.push(y0 < y1 ? [x0, y0, x1, y1, 1] : [x1, y1, x0, y0, -1]);
    }
  }
  if (!edges.length) return;
  const left = Math.max(0, Math.floor(minX));
  const right = Math.min(width, Math.ceil(maxX) + 1);
  if (right <= left) return;
  const row = new Float32Array(right - left + 1);
  const crossings: number[][] = [];

  /** Add `weight` × the part of each pixel in [a, b). */
  const span = (a: number, b: number, weight: number) => {
    a = Math.max(a, left);
    b = Math.min(b, right);
    if (b <= a) return;
    const ia = Math.floor(a);
    const ib = Math.floor(b);
    if (ia === ib) {
      row[ia - left] += (b - a) * weight;
      return;
    }
    row[ia - left] += (ia + 1 - a) * weight;
    for (let x = ia + 1; x < ib; x++) row[x - left] += weight;
    if (ib < right) row[ib - left] += (b - ib) * weight;
  };

  for (let py = Math.max(0, Math.floor(minY)); py < Math.min(height, Math.ceil(maxY)); py++) {
    row.fill(0);
    const active = edges.filter((e) => e[1] < py + 1 && e[3] > py);
    for (let s = 0; s < SUBSAMPLES; s++) {
      const y = py + (s + 0.5) / SUBSAMPLES;
      crossings.length = 0;
      for (const [x0, y0, x1, y1, dir] of active) {
        if (y >= y0 && y < y1) crossings.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), dir]);
      }
      crossings.sort((a, b) => a[0] - b[0]);
      let winding = 0;
      for (let k = 0; k < crossings.length; k++) {
        const before = winding;
        winding += crossings[k][1];
        if (before === 0 && winding !== 0) {
          // Inside from here to where the winding is zero again.
          let m = k + 1;
          for (; m < crossings.length; m++) {
            winding += crossings[m][1];
            if (winding === 0) break;
          }
          span(crossings[k][0], m < crossings.length ? crossings[m][0] : right, 1 / SUBSAMPLES);
          k = m;
        }
      }
    }
    for (let x = left; x < right; x++) {
      const a = row[x - left];
      if (a > 0) plot(x, py, Math.min(1, a));
    }
  }
}

/** A glyph outline as polygons: curves cut into short straight pieces. */
function outlinePolygons(commands: { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[]): number[][] {
  const polygons: number[][] = [];
  let pts: number[] = [];
  let [cx, cy] = [0, 0];
  const close = () => {
    if (pts.length >= 6) polygons.push(pts);
    pts = [];
  };
  /** Pieces for a curve: about one per two pixels of its control polygon, at least 2. */
  const pieces = (...xy: number[]) => {
    let len = 0;
    for (let i = 2; i < xy.length; i += 2) len += Math.hypot(xy[i] - xy[i - 2], xy[i + 1] - xy[i - 1]);
    return Math.max(2, Math.min(64, Math.ceil(len / 2)));
  };
  for (const c of commands) {
    if (c.type === "M") {
      close();
      [cx, cy] = [c.x!, c.y!];
      pts.push(cx, cy);
    } else if (c.type === "L") {
      [cx, cy] = [c.x!, c.y!];
      pts.push(cx, cy);
    } else if (c.type === "Q") {
      const n = pieces(cx, cy, c.x1!, c.y1!, c.x!, c.y!);
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        pts.push(u * u * cx + 2 * u * t * c.x1! + t * t * c.x!, u * u * cy + 2 * u * t * c.y1! + t * t * c.y!);
      }
      [cx, cy] = [c.x!, c.y!];
    } else if (c.type === "C") {
      const n = pieces(cx, cy, c.x1!, c.y1!, c.x2!, c.y2!, c.x!, c.y!);
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        pts.push(
          u * u * u * cx + 3 * u * u * t * c.x1! + 3 * u * t * t * c.x2! + t * t * t * c.x!,
          u * u * u * cy + 3 * u * u * t * c.y1! + 3 * u * t * t * c.y2! + t * t * t * c.y!,
        );
      }
      [cx, cy] = [c.x!, c.y!];
    } else if (c.type === "Z") {
      close();
    }
  }
  close();
  return polygons;
}

/**
 * Write a line of text into the pixels: glyph by glyph along the advances
 * textWidth() measures, so centring and fitting agree with what is drawn.
 */
function drawText(canvas: Canvas, t: TextItem): void {
  const f = shareFont();
  const width = textWidth(t.text, t.size);
  let x = t.align === "center" ? Math.round(t.x) - width / 2 : t.align === "right" ? Math.round(t.x) - width : Math.round(t.x);
  const polygons: number[][] = [];
  for (const ch of t.text) {
    const glyph = f.charToGlyph(ch);
    polygons.push(...outlinePolygons(glyph.getPath(x, t.baseline, t.size).commands as never));
    x += ((glyph.advanceWidth ?? 0) * t.size) / f.unitsPerEm;
  }
  canvas.fillPolygons(polygons, t.color);
}

// ============================
// Font
// ============================

type OpenType = typeof import("opentype.js");
type Font = ReturnType<OpenType["parse"]>;

let font: Font | null = null;
/** The bundled font, read with opentype.js: pure JavaScript, so ffmpeg needs no freetype. */
function shareFont(): Font {
  if (!font) {
    const opentype: OpenType = require("opentype.js");
    const bytes = readFileSync(SHARE_FONT_PATH);
    font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  return font;
}

/** Width of a line of text in pixels at a font size: the glyphs' advances, no kerning or ligatures. */
function textWidth(text: string, size: number): number {
  const f = shareFont();
  let units = 0;
  for (const ch of text) units += f.charToGlyph(ch).advanceWidth ?? 0;
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
  const f = shareFont();
  const cap: number = f.tables.os2?.sCapHeight || f.unitsPerEm * 0.7;
  return (cap * size) / f.unitsPerEm;
}

// ============================
// Drawing
// ============================

const LOGO_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

interface TextItem {
  text: string;
  size: number;
  color: Rgb;
  /** Horizontal anchor: the centre, or the right edge with align "right", or the left edge. */
  x: number;
  align: "left" | "center" | "right";
  baseline: number;
}

/**
 * Paint everything but the logos into raw pixels: the background, the
 * badges and all the text. The logos, and where they go, are left for ffmpeg.
 */
export function paintShareImage(d: ShareDrawing): { pixels: { width: number; height: number; data: Buffer }; logos: PlacedLogo[] } {
  const W = SHARE_WIDTH;
  const H = SHARE_HEIGHT;
  const accent = parseColor(d.accentColor, [200, 164, 63]);
  const canvas = new Canvas(W, H, BACKGROUND);
  const texts: TextItem[] = [];
  const logos: PlacedLogo[] = [];

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
  const when = d.time ? `${formatShareDate(d.date)} · ${d.time}` : formatShareDate(d.date);
  texts.push({ ...fitText(when.toUpperCase(), 520, 36, 26), color: MUTED, x: W - 72, align: "right", baseline: header });

  // Badges: the logo on a white plate, or the short name on the team's colour.
  for (const { team, cx } of sides) {
    canvas.fillCircle(cx, badgeY, R + 6, WHITE, 0.14);
    if (team.logo) {
      canvas.fillCircle(cx, badgeY, R, WHITE);
      const size = Math.round(R * 2 * 0.7);
      logos.push({ logo: team.logo, cx, cy: badgeY, w: size, h: size });
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

  // The main sponsor in the lower right corner (#153), on a white plate:
  // most logos are drawn for white. The venue keeps clear of it.
  const plate = { w: 168, h: 76, x: W - 48 - 168, y: H - 14 - 18 - 76 };
  if (d.sponsorLogo) {
    canvas.fillRoundRect(plate.x, plate.y, plate.w, plate.h, 12, WHITE);
    logos.push({ logo: d.sponsorLogo, cx: plate.x + plate.w / 2, cy: plate.y + plate.h / 2, w: plate.w - 28, h: plate.h - 20 });
  }

  // Under the names: where it is played, centred and clear of the sponsor.
  const venueWidth = d.sponsorLogo ? 2 * (plate.x - 24 - W / 2) : 900;
  if (d.venue) texts.push({ ...fitText(d.venue.toUpperCase(), venueWidth, 32, 24), color: MUTED, x: W / 2, align: "center", baseline: 574 });

  for (const t of texts) drawText(canvas, t);
  return { pixels: canvas, logos };
}

/**
 * Render the picture as a PNG, 1200 × 630. ffmpeg only lays the logos on the
 * painted pixels and writes the PNG: rawvideo, scale, overlay and format,
 * which every build has. `ffmpeg` is for tests.
 */
export async function renderShareImage(d: ShareDrawing, options: { ffmpeg?: string } = {}): Promise<Buffer> {
  void checkShareFilters();
  const { pixels, logos } = paintShareImage(d);
  return ffmpegCompose(pixels, logos, options.ffmpeg ?? ffmpegPath);
}

/** A logo where it goes: centred on (cx, cy), scaled to fit w × h. */
export interface PlacedLogo {
  logo: Logo;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

async function ffmpegCompose(
  pixels: { width: number; height: number; data: Buffer },
  logos: PlacedLogo[],
  ffmpeg: string,
): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "courtside-share-"));
  try {
    await writeFile(path.join(dir, "base.rgba"), pixels.data);
    const inputs = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${pixels.width}x${pixels.height}`, "-i", "base.rgba"];
    const graph: string[] = [];
    let current = "0:v";
    for (const [i, { logo, cx, cy, w, h }] of logos.entries()) {
      const file = `logo${i}.${LOGO_EXTENSIONS[logo.type] ?? "png"}`;
      await writeFile(path.join(dir, file), logo.bytes);
      inputs.push("-i", file);
      const n = i + 1;
      graph.push(
        `[${n}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba[l${n}]`,
        `[${current}][l${n}]overlay=x=${cx}-overlay_w/2:y=${cy}-overlay_h/2[b${n}]`,
      );
      current = `b${n}`;
    }
    graph.push(`[${current}]format=rgb24[out]`);

    const { stdout } = await execFileAsync(
      ffmpeg,
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

/** The filters the picture needs from ffmpeg. */
export const SHARE_FILTERS = ["scale", "format", "overlay"];

let filterCheck: Promise<string[]> | null = null;

/**
 * The filters in SHARE_FILTERS this ffmpeg lacks, asked once with
 * `ffmpeg -filters` and remembered. A missing one is logged as a warning,
 * since every share picture would then fail. Never throws.
 */
export function checkShareFilters(ffmpeg = ffmpegPath, log: (msg: string) => void = console.warn): Promise<string[]> {
  if (ffmpeg !== ffmpegPath) return listMissingFilters(ffmpeg, log);
  filterCheck ??= listMissingFilters(ffmpeg, log);
  return filterCheck;
}

async function listMissingFilters(ffmpeg: string, log: (msg: string) => void): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(ffmpeg, ["-hide_banner", "-filters"], { maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
    // " TSC overlay  VV->V  Overlay a video ..."
    const have = new Set(stdout.split("\n").map((line) => line.trim().split(/\s+/)[1]).filter(Boolean));
    const missing = SHARE_FILTERS.filter((f) => !have.has(f));
    if (missing.length) log(`[share-image] ffmpeg (${ffmpeg}) lacks the filter(s) ${missing.join(", ")}: match share pictures will fail`);
    return missing;
  } catch (err) {
    log(`[share-image] Could not list ffmpeg's filters (${ffmpeg}): ${err instanceof Error ? err.message : err}`);
    return [];
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
  /**
   * The main sponsor's logo for the match (#153): who has the surface
   * "share-image" for its own team, or the club's. Synchronous, from the
   * sponsors' snapshot, since version() cannot wait. `version` changes when
   * the logo does. Null, or left out, when the surface is off or there is
   * no one with a logo: the picture is then the same as without sponsors.
   */
  sponsorLogo?(match: Match): { version: string; load(): Promise<Logo | null> } | null;
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
    const sponsor = this.sponsorOf(match);
    const drawn: unknown[] = [
      LAYOUT_VERSION,
      club.name,
      club.accentColor,
      clubLogo,
      match.date,
      plannedTime(match) ?? "",
      match.venue ?? "",
      team(match.ownTeam),
      team(match.opponent),
      match.result ? [match.result.home, match.result.away] : null,
    ];
    // Added only when there is one, so without it the version is as before.
    if (sponsor) drawn.push(["sponsor", sponsor.version]);
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
    const sponsor = this.sponsorOf(match);
    const [ownLogo, opponentLogo, sponsorLogo] = await Promise.all([
      this.logoOf(match.ownTeam).then((logo) => logo ?? this.sources.clubLogo().catch(() => null)),
      this.logoOf(match.opponent),
      sponsor ? sponsor.load().catch(() => null) : null,
    ]);
    const drawing: ShareDrawing = {
      club: club.name,
      accentColor: club.accentColor,
      date: match.date,
      ...(plannedTime(match) && { time: plannedTime(match) }),
      ...(match.venue && { venue: match.venue }),
      own: teamDrawing(match.ownTeam, ownLogo),
      opponent: teamDrawing(match.opponent, opponentLogo),
      ...(match.result && { result: match.result }),
      ...(sponsorLogo && { sponsorLogo }),
    };
    try {
      return await this.render(drawing);
    } catch (err) {
      if (!drawing.own.logo && !drawing.opponent.logo && !drawing.sponsorLogo) throw err;
      // A logo ffmpeg cannot read must not cost the match its picture.
      const { sponsorLogo: _gone, ...plain } = drawing;
      return this.render({ ...plain, own: { ...drawing.own, logo: undefined }, opponent: { ...drawing.opponent, logo: undefined } });
    }
  }

  /** The sponsor on the picture, or null. A sponsor lookup that fails is no sponsor. */
  private sponsorOf(match: Match): { version: string; load(): Promise<Logo | null> } | null {
    try {
      return this.sources.sponsorLogo?.(match) ?? null;
    } catch {
      return null;
    }
  }

  private async logoOf(team: MatchTeam): Promise<Logo | null> {
    if (!team.id || !team.logoUrl) return null;
    return this.sources.teamLogo(team.id).catch(() => null);
  }
}

/** The time is drawn only before the match is played. */
function plannedTime(match: Match): string | undefined {
  return match.status === "planned" ? match.time : undefined;
}

function teamDrawing(team: MatchTeam, logo: Logo | null): ShareTeam {
  return { name: team.name, shortName: team.shortName, color: team.color, ...(logo && { logo }) };
}

// ============================
// A shared clip's preview (#161)
// ============================
//
// The clip's own thumbnail with the sponsor of "shared-clip" in the top right
// corner, on a white plate as on the match's picture. Nothing else is drawn:
// the plate is painted here into raw pixels, and ffmpeg only scales the
// thumbnail and lays the plate and the logo on it. No drawtext (#195).

/** The clip preview's width; the height follows the thumbnail. */
export const CLIP_SHARE_WIDTH = 1200;

/** Bump when the clip preview's layout changes, so every chat app fetches the new picture. */
const CLIP_LAYOUT_VERSION = 1;

/** The plate the sponsor's logo sits on, and its distance from the corner. */
const CLIP_PLATE = { w: 200, h: 90, margin: 32, radius: 14 };

/** A white plate with round corners as RGBA, see-through outside the corners. */
export function clipSponsorPlate(): { width: number; height: number; data: Buffer } {
  const { w, h, radius: r } = CLIP_PLATE;
  const data = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Distance into the nearest corner's circle; 1 everywhere off the corners.
      const cx = x < r ? r : x >= w - r ? w - r : null;
      const cy = y < r ? r : y >= h - r ? h - r : null;
      const a = cx === null || cy === null ? 1 : Math.max(0, Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy)));
      data[(y * w + x) * 4 + 3] = Math.round(a * 255);
    }
  }
  return { width: w, height: h, data };
}

/**
 * The thumbnail, 1200 wide, with the sponsor's logo in the top right corner,
 * as a JPEG. ffmpeg uses rawvideo, scale, format and overlay only, as for the
 * match's picture. `ffmpeg` is for tests.
 */
export async function renderClipShareImage(thumbnail: Buffer, logo: Logo, options: { ffmpeg?: string } = {}): Promise<Buffer> {
  void checkShareFilters();
  const ffmpeg = options.ffmpeg ?? ffmpegPath;
  const plate = clipSponsorPlate();
  const { w, h, margin } = CLIP_PLATE;
  const dir = await mkdtemp(path.join(tmpdir(), "courtside-clipshare-"));
  try {
    const logoFile = `logo.${LOGO_EXTENSIONS[logo.type] ?? "png"}`;
    await Promise.all([
      writeFile(path.join(dir, "thumb.jpg"), thumbnail),
      writeFile(path.join(dir, "plate.rgba"), plate.data),
      writeFile(path.join(dir, logoFile), logo.bytes),
    ]);
    const graph = [
      `[0:v]scale=${CLIP_SHARE_WIDTH}:-2:flags=lanczos,format=rgba[t]`,
      `[t][1:v]overlay=x=main_w-overlay_w-${margin}:y=${margin}:format=rgb[p]`,
      `[2:v]scale=${w - 32}:${h - 24}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba[l]`,
      `[p][l]overlay=x=main_w-${margin + w / 2}-overlay_w/2:y=${margin + h / 2}-overlay_h/2:format=rgb[b]`,
      `[b]format=yuvj420p[out]`,
    ];
    const { stdout } = await execFileAsync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error",
        "-i", "thumb.jpg",
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${plate.width}x${plate.height}`, "-i", "plate.rgba",
        "-i", logoFile,
        "-filter_complex", graph.join(";"),
        "-map", "[out]", "-frames:v", "1",
        "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "-",
      ],
      { cwd: dir, encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 30000 },
    );
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What a clip's preview shows: its thumbnail and, when there is one, the sponsor. */
export interface ClipShareSubject {
  clipId: string;
  /** Changes when the thumbnail does. */
  thumbnailUrl: string;
  /** The sponsor of "shared-clip" with a logo, or null: the preview is then the thumbnail as it is. */
  sponsor: { version: string; load(): Promise<Logo | null> } | null;
}

/**
 * Each shared clip's preview, rendered when first asked for and kept in
 * memory while what it shows stays the same. The version goes into the
 * og:image URL, so a new logo is a new URL.
 */
export class ClipShareImages {
  private readonly cache = new Map<string, { version: string; jpg: Buffer }>();
  private readonly pending = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly thumbnail: (clipId: string) => Promise<Buffer>,
    private readonly render: (thumbnail: Buffer, logo: Logo) => Promise<Buffer> = renderClipShareImage,
  ) {}

  /** A hash of everything the preview shows; null without a sponsor, when the thumbnail is used as it is. */
  version(subject: ClipShareSubject): string | null {
    if (!subject.sponsor) return null;
    const drawn = [CLIP_LAYOUT_VERSION, subject.clipId, subject.thumbnailUrl, ["sponsor", subject.sponsor.version]];
    return crypto.createHash("sha256").update(JSON.stringify(drawn)).digest("hex").slice(0, 12);
  }

  /**
   * The preview as it is now. Without a sponsor, or when its logo cannot be
   * read or drawn, the plain thumbnail: the clip never loses its preview.
   */
  async image(subject: ClipShareSubject): Promise<{ version: string | null; jpg: Buffer }> {
    const version = this.version(subject);
    if (!version || !subject.sponsor) return { version: null, jpg: await this.thumbnail(subject.clipId) };
    const cached = this.cache.get(subject.clipId);
    if (cached?.version === version) return cached;

    const key = `${subject.clipId}:${version}`;
    let rendering = this.pending.get(key);
    if (!rendering) {
      const sponsor = subject.sponsor;
      rendering = (async () => {
        const thumb = await this.thumbnail(subject.clipId);
        const logo = await sponsor.load().catch(() => null);
        if (!logo) return thumb;
        return this.render(thumb, logo).catch(() => thumb);
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, rendering);
    }
    const jpg = await rendering;
    this.cache.delete(subject.clipId);
    this.cache.set(subject.clipId, { version, jpg });
    while (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
    return { version, jpg };
  }
}
