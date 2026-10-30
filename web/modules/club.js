// === Club identity ===
//
// Fetches the club manifest from the backend and themes the page from it, so
// one prebuilt bundle can serve any club.  Everything here degrades quietly:
// a club that cannot be reached still gets a usable, if unbranded, page.

import { CONFIG } from "./config.js";

/** Filled in by loadClub(). Safe defaults until then. */
export const club = {
  name: "Courtside",
  shortName: "Courtside",
  venue: "",
  accentColor: "",
  logoUrl: "",
  siteUrl: "",
  tagline: "",
  sport: null,
};

const FETCH_TIMEOUT_MS = 4000;

// --- Accent colour ---
//
// The club picks one colour. It fills surfaces (buttons, the header band,
// the active tab) as chosen, but text and icons in it are lightened until
// they read on the dark background, so no club colour can end up unreadable.

/** The lightest dark surface accent text sits on (--surface-hover). */
const DARKEST_TEXT_BACKGROUND = [30, 30, 30];

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
  return "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** WCAG relative luminance of an [r, g, b] colour. */
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The accent mixed toward white just enough to pass 4.5:1 as text. */
export function accentInk(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  for (let t = 0; t <= 1; t += 0.05) {
    const mixed = rgb.map((v) => v + (255 - v) * t);
    if (contrastRatio(mixed, DARKEST_TEXT_BACKGROUND) >= 4.5) return toHex(mixed);
  }
  return "#ffffff";
}

/** Set --accent and the colours derived from it. Ignores anything but #rrggbb. */
export function applyAccent(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return;
  const white = [255, 255, 255];
  const nearBlack = [17, 19, 23];
  const root = document.documentElement.style;
  root.setProperty("--accent", hex);
  root.setProperty("--accent-ink", accentInk(hex));
  root.setProperty(
    "--on-accent",
    contrastRatio(rgb, white) >= contrastRatio(rgb, nearBlack) ? "#ffffff" : "#111317"
  );
  root.setProperty("--accent-soft", `rgba(${rgb.join(", ")}, 0.18)`);
  root.setProperty("--accent-dim", toHex(rgb.map((v) => v * 0.8)));
}

/**
 * Apply the manifest to the document: accent colour, logos, names, metadata.
 * Called once at boot, before the PIN screen is shown — the PIN screen is
 * branded too.
 */
export function applyTheme() {
  if (club.accentColor) {
    applyAccent(club.accentColor);
  }

  // Only override the logo when the club configured one.  Otherwise the
  // placeholder shipped with the build stays — its path is rewritten by the
  // build step and differs between dev and production.
  if (club.logoUrl) {
    document.querySelectorAll("[data-club-logo]").forEach((el) => {
      el.setAttribute("src", club.logoUrl);
    });
    document.querySelectorAll("link[rel='icon'], link[rel='apple-touch-icon']").forEach((el) => {
      el.setAttribute("href", club.logoUrl);
    });
  }
  document.querySelectorAll("[data-club-logo]").forEach((el) => {
    el.setAttribute("alt", club.shortName || club.name);
  });

  document.querySelectorAll("[data-club-name]").forEach((el) => {
    el.textContent = club.name;
  });

  const titleSuffix = document.body?.dataset.titleSuffix || "";
  document.title = titleSuffix ? `${club.name} — ${titleSuffix}` : club.name;

  setMeta("description", club.tagline);
  setMetaProperty("og:title", document.title);
  setMetaProperty("og:description", club.tagline);
  if (club.siteUrl) setMetaProperty("og:url", club.siteUrl);
}

function setMeta(name, content) {
  if (!content) return;
  const el = document.querySelector(`meta[name="${name}"]`);
  if (el) el.setAttribute("content", content);
}

function setMetaProperty(property, content) {
  if (!content) return;
  const el = document.querySelector(`meta[property="${property}"]`);
  if (el) el.setAttribute("content", content);
}

/**
 * Load the club manifest and theme the page.  Never rejects — a failure here
 * must not stop the stream list from loading.
 */
export async function loadClub() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${CONFIG.API_URL}/api/club`, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      Object.assign(club, await res.json());
    } else {
      console.warn(`[club] Manifest unavailable (${res.status}) — using defaults`);
    }
  } catch (err) {
    console.warn("[club] Could not load manifest — using defaults:", err.message);
  }

  applyTheme();
  return club;
}
