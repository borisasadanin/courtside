// === Team registry ===
//
// The club's own teams and their opponents, with short name, colour and logo
// (ABL-047). Recordings carry team names as plain text; findTeam() matches a
// name to the registry the same way the backend does, ignoring case and extra
// spaces, and also by a team's earlier names.
//
// teamBadge() is what the pages show for a team: its logo, or its short name
// in a round badge in the team colour when it has none.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { parseHex, contrastRatio } from "./club.js";
import { mediaUrl } from "./utils.js";

/** Filled in by loadTeams(). */
let teams = [];
let byKey = new Map();
let loading = null;

/** What two names must share to be the same team. Same as teamKey in api/src/teams.ts. */
export function teamKey(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Every team, own teams first. Loaded once and kept; pass { force: true } after
 * a change. Never rejects: without the registry, badges fall back to names.
 */
export function loadTeams({ force = false } = {}) {
  if (loading && !force) return loading;
  const headers = {};
  if (state.viewerToken) headers["Authorization"] = `Bearer ${state.viewerToken}`;
  if (state.adminToken) headers["X-Admin-Token"] = state.adminToken;
  loading = fetch(`${CONFIG.API_URL}/api/teams`, { headers })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((list) => setTeams(list))
    .catch((err) => {
      console.warn("[teams] Could not load teams:", err.message);
      loading = null;
      return teams;
    });
  return loading;
}

/** Replace the cached list, e.g. with one the admin view just fetched. */
export function setTeams(list) {
  teams = Array.isArray(list) ? list : [];
  byKey = new Map();
  for (const t of teams) {
    for (const name of [...(t.aliases || []), t.name]) byKey.set(teamKey(name), t);
  }
  loading = Promise.resolve(teams);
  return teams;
}

/** The cached list, empty until loadTeams() has finished. */
export function getTeams() {
  return teams;
}

/** The registry's team for a name, or null. Call loadTeams() first. */
export function findTeam(name) {
  return byKey.get(teamKey(name)) || null;
}

/**
 * The team for a name: the registry's, or a stand-in with the short name and
 * colour the backend would give it, for names not (yet) in the registry.
 */
export function teamFor(name) {
  return findTeam(name) || {
    id: null,
    name: String(name || "").trim(),
    shortName: deriveShortName(name),
    color: deriveColor(name),
    own: false,
    aliases: [],
  };
}

/**
 * A team's badge: the logo, or the short name on the team colour.
 * Takes a team or a name. size is "sm" (24px), "md" (40px, default) or "lg" (64px).
 */
export function teamBadge(teamOrName, { size = "md" } = {}) {
  const team = typeof teamOrName === "string" ? teamFor(teamOrName) : teamOrName;
  const el = document.createElement("span");
  el.className = `team-badge team-badge-${size}`;
  el.title = team.name;

  if (team.logoUrl) {
    el.classList.add("has-logo");
    const img = document.createElement("img");
    img.src = mediaUrl(team.logoUrl);
    img.alt = team.name;
    img.loading = "lazy";
    el.append(img);
    return el;
  }

  el.textContent = team.shortName;
  el.setAttribute("aria-label", team.name);
  el.style.background = team.color;
  el.style.color = textOn(team.color);
  if (team.shortName.length > 3) el.classList.add("is-long");
  return el;
}

/** White or near-black, whichever reads better on the colour. */
export function textOn(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return "#ffffff";
  return contrastRatio(rgb, [255, 255, 255]) >= contrastRatio(rgb, [17, 19, 23]) ? "#ffffff" : "#111317";
}

// --- Derived short name and colour ---
//
// The same functions as in api/src/teams.ts, so a name looks the same before
// and after it is in the registry. Change both together.

const GENERIC_WORDS = new Set([
  "if", "ik", "bk", "bbk", "bc", "bf", "fc", "sk", "ss",
  "basket", "basketball", "basketboll", "basketklubb", "basketbollklubb", "idrottsförening", "idrottsklubb",
]);

export function deriveShortName(name, own = false) {
  const words = String(name || "").trim().replace(/\s+/g, " ")
    .split(/[\s\-–/.,&]+/)
    .map((w) => w.replace(/[^0-9A-Za-zÀ-ÖØ-öø-ÿ]/g, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  const ageGroup = words.length > 1 ? words.find((w) => /\d/.test(w) && w.length <= 4) : undefined;
  if (own && ageGroup) return ageGroup.toUpperCase();
  const core = words.filter((w) => !GENERIC_WORDS.has(w.toLowerCase()) && !/\d/.test(w));
  const use = core.length > 0 ? core : words;
  const short = use.length >= 3
    ? use.slice(0, 4).map((w) => w[0]).join("")
    : use[0].length <= 4 ? use[0] : use[0].slice(0, 3);
  return short.toUpperCase();
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

export function deriveColor(name) {
  const key = teamKey(name);
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // FNV's low bits barely mix, and the hue comes from them: stir once more.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  let rgb = hslToRgb((hash >>> 0) % 360, 0.55, 0.42);
  while (1.05 / (luminance(rgb) + 0.05) < 4.5) rgb = rgb.map((v) => v * 0.9);
  return "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}
