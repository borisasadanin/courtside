// === Sponsors' logos outside the player (#121, phase 1) ===
//
//   - the waiting screen before an announced match: "Sändningen stöds av" (#149)
//
// Every surface is off until the club switches it on. Off, or with no one to
// show, nothing is added to the page at all: it looks as it did before.
// A logo with a link opens the sponsor's site in a new tab.

import { mediaUrl } from "./utils.js";
import { dom } from "./state.js";
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
