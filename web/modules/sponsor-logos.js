// === Sponsors' logos outside the player (#121, phase 1) ===
//
//   - the waiting screen before an announced match: "Sändningen stöds av" (#149)
//   - "Med stöd av" on the match cards, live, coming and played (#151)
//   - the club's sponsors in the footer, before and after the PIN (#152)
//
// Every surface is off until the club switches it on. Off, or with no one to
// show, nothing is added to the page at all: it looks as it did before.
// A logo with a link opens the sponsor's site in a new tab.

import { CONFIG } from "./config.js";
import { mediaUrl } from "./utils.js";
import { dom } from "./state.js";
import { authHeaders } from "./auth.js";
import { fetchSurfaces } from "./sponsors.js";

/** How long a fetched answer is used before it is asked for again. */
const FRESH_MS = 60_000;

/**
 * A sponsor's logo, linked to its site when it has one. `linked: false` for a
 * logo inside something already clickable (a button). Without a logo, the
 * name. A logo that will not load becomes the name too.
 */
export function sponsorMark(sponsor, { linked = true, className = "sponsor-mark" } = {}) {
  const el = document.createElement(linked && sponsor.url ? "a" : "span");
  el.className = className;
  if (el.tagName === "A") {
    el.href = sponsor.url;
    el.target = "_blank";
    el.rel = "noopener sponsored";
  }
  const asName = () => {
    el.replaceChildren(sponsor.name);
    el.classList.add("is-name");
  };
  if (sponsor.logoUrl) {
    const img = document.createElement("img");
    img.alt = sponsor.name;
    img.decoding = "async";
    img.loading = "lazy";
    img.addEventListener("error", asName, { once: true });
    img.src = mediaUrl(sponsor.logoUrl);
    el.append(img);
  } else {
    asName();
  }
  if (el.tagName === "A") el.setAttribute("aria-label", `${sponsor.name} (öppnas i ny flik)`);
  return el;
}

/** A sponsor list as it is drawn: changes only when what is shown does. */
function sponsorsKey(list) {
  return JSON.stringify((list ?? []).map((x) => [x.id, x.name, x.logoUrl ?? "", x.url ?? ""]));
}

// ============================
// The waiting screen (#149)
// ============================

/** match id (or "") → { at, surfaces: Promise }: one request a minute per announced match. */
const waitingCache = new Map();
let waitingShown = "";
/** Each call; an answer for an older one is not drawn. */
let waitingCall = 0;

function waitingSurfaces(matchId) {
  const key = matchId || "";
  const hit = waitingCache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.surfaces;
  const surfaces = fetchSurfaces(matchId ? { match: matchId } : {});
  waitingCache.set(key, { at: Date.now(), surfaces });
  return surfaces;
}

/**
 * The waiting screen's sponsors for the match a camera has announced, or
 * none: `matchId` null for "not waiting for a match" takes them away.
 * Without a match in the schedule (announced by name only), the club's own.
 */
export async function showWaitingSponsors(waiting, matchId) {
  const call = ++waitingCall;
  if (!waiting) return drawWaiting([]);
  const { surfaces } = await waitingSurfaces(matchId);
  if (call !== waitingCall) return;
  drawWaiting(Array.isArray(surfaces.waiting) ? surfaces.waiting : []);
}

function drawWaiting(list) {
  const key = sponsorsKey(list);
  if (key === waitingShown) return;
  waitingShown = key;
  dom.emptyState?.querySelector(".waiting-sponsors")?.remove();
  if (list.length === 0) return;

  const box = document.createElement("div");
  box.className = "waiting-sponsors";
  const title = document.createElement("p");
  title.className = "waiting-sponsors-title";
  title.textContent = "Sändningen stöds av";
  const items = document.createElement("ul");
  items.className = "waiting-sponsors-list";
  items.setAttribute("aria-label", "Sändningen stöds av");
  for (const sponsor of list) {
    const li = document.createElement("li");
    li.append(sponsorMark(sponsor));
    items.append(li);
  }
  box.append(title, items);
  // Under "Jag är redo", above the schedule.
  const schedule = dom.emptySchedule;
  if (schedule?.parentElement === dom.emptyState.querySelector(".empty-content")) schedule.before(box);
  else dom.emptyState.querySelector(".empty-content")?.append(box);
}

// ============================
// The match cards (#151)
// ============================

/** GET /api/sponsors/teams?surface=match-card: the club's sponsor and each own team's. */
let cardSponsors = { club: null, byTeam: {} };
let cardFetchedAt = 0;
let cardLoading = null;

/**
 * Fetch who is on the match cards, at most once a minute. Called with the
 * schedule before a list is drawn, so the cards have it the first time.
 * Never rejects: an error keeps what was there, or nothing.
 */
export function loadCardSponsors() {
  if (cardLoading) return cardLoading;
  if (Date.now() - cardFetchedAt < FRESH_MS) return Promise.resolve();
  cardLoading = (async () => {
    try {
      const res = await fetch(`${CONFIG.API_URL}/api/sponsors/teams?surface=match-card`, { headers: authHeaders() });
      if (!res.ok) return;
      const body = await res.json();
      cardSponsors = {
        club: body?.club ?? null,
        byTeam: body?.byTeam && typeof body.byTeam === "object" ? body.byTeam : {},
      };
    } catch {
      // Nothing to show this time; the cards look as before
    } finally {
      cardFetchedAt = Date.now();
      cardLoading = null;
    }
  })();
  return cardLoading;
}

/** What the cards show now, so a list that skips redrawing can tell when it changed. */
export function cardSponsorsKey() {
  return sponsorsKey([cardSponsors.club, ...Object.values(cardSponsors.byTeam)].filter(Boolean))
    + Object.keys(cardSponsors.byTeam).join();
}

/** The sponsor on a card of this own team: the team's, or else the club's. */
export function cardSponsorFor(team) {
  return (team?.id && cardSponsors.byTeam[team.id]) || cardSponsors.club || null;
}

/**
 * "Med stöd av [logo]" under a card's status line, or null when the surface
 * is off or no one has it. `inline` for a card that is itself a button: the
 * logo is then not a link of its own.
 */
export function cardSponsorLine(team, { inline = false } = {}) {
  const sponsor = cardSponsorFor(team);
  if (!sponsor) return null;
  const line = document.createElement(inline ? "span" : "p");
  line.className = "mc-sponsor";
  const lead = document.createElement("span");
  lead.className = "mc-sponsor-lead";
  lead.textContent = "Med stöd av";
  const mark = sponsorMark(sponsor, { linked: !inline, className: "sponsor-mark mc-sponsor-mark" });
  // Opening the sponsor is not opening the match.
  if (mark.tagName === "A") mark.addEventListener("click", (e) => e.stopPropagation());
  line.append(lead, mark);
  return line;
}

// ============================
// The footer (#152)
// ============================

let footerShown = "";
let footerFetchedAt = 0;

/**
 * The club's sponsors in the footer: only the whole club's, only with the
 * surface club-footer on. Public, so it shows on the PIN page too. Asked
 * when the page opens and again when it is looked at after a while.
 */
export function initClubFooter() {
  loadClubFooter();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - footerFetchedAt > 5 * FRESH_MS) loadClubFooter();
  });
}

async function loadClubFooter() {
  footerFetchedAt = Date.now();
  let list = [];
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/sponsors/club`);
    if (!res.ok) return;
    const body = await res.json();
    list = Array.isArray(body?.sponsors) ? body.sponsors : [];
  } catch {
    return; // Keep what is there
  }
  drawFooter(list);
}

function drawFooter(list) {
  const key = sponsorsKey(list);
  if (key === footerShown) return;
  footerShown = key;
  const footer = document.querySelector("body > footer");
  footer?.querySelector(".footer-sponsors")?.remove();
  if (!footer || list.length === 0) return;

  const box = document.createElement("section");
  box.className = "footer-sponsors";
  box.setAttribute("aria-label", "Klubbens sponsorer");
  const title = document.createElement("p");
  title.className = "footer-sponsors-title";
  title.textContent = "Klubbens sponsorer";
  const items = document.createElement("ul");
  items.className = "footer-sponsors-list";
  for (const sponsor of list) {
    const li = document.createElement("li");
    li.append(sponsorMark(sponsor, { className: "sponsor-mark footer-sponsor-mark" }));
    items.append(li);
  }
  box.append(title, items);
  footer.prepend(box);
}
