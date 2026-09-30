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

/**
 * Apply the manifest to the document: accent colour, logos, names, metadata.
 * Called once at boot, before the PIN screen is shown — the PIN screen is
 * branded too.
 */
function applyTheme() {
  if (club.accentColor) {
    document.documentElement.style.setProperty("--accent", club.accentColor);
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
