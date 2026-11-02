// === Streams module ===
// Stream list fetching, rendering, polling, auto-open logic.

import { CONFIG } from "./config.js";
import { state, dom } from "./state.js";
import { escapeHtml } from "./utils.js";
import { authHeaders, showPinScreen } from "./auth.js";
import { openPlayer, pauseLabel } from "./player.js";
import { showImage } from "./images.js";
import { club } from "./club.js";
import { loadMatches, findMatch, upcomingMatches, describeMatch, downloadIcs } from "./matches.js";
import { loadTeams } from "./teams.js";
import { matchTeams, matchHead, matchName, spokenTeams, upcomingHead, teamFilter, focusedTeamFilter, focusTeamFilter, TEAM_FILTER_EVENT } from "./match-card.js";

// ============================
// Fetch & render
// ============================

async function fetchStreams() {
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/streams`, {
      headers: authHeaders(),
    });
    if (res.status === 401) {
      // Token expired or invalid -- show PIN screen
      state.viewerToken = null;
      localStorage.removeItem("viewerToken");
      showPinScreen();
      return null;
    }
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchBroadcastState() {
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/broadcast`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const BROADCAST_MESSAGES = {
  // Only when the list could not be read: the status is derived from every match
  live: {
    title: "En match sänds just nu",
    sub: "Den dyker upp här strax.",
  },
  idle: {
    title: "Ingen sänder just nu",
    sub: "Matchen dyker upp här av sig själv när en kamera börjar sända. Du behöver inte ladda om sidan.",
  },
  upcoming: {
    title: "En basketmatch startar snart!",
    sub: "Sändningen börjar inom kort",
  },
  paused: {
    title: "Matchen är pausad",
    sub: "Sändningen fortsätter snart",
  },
  ended: {
    title: "Tack för att du tittade!",
    sub: "Matchen är slut",
  },
};

function updateEmptyState(broadcastState) {
  const status = broadcastState?.status || "idle";
  const msgs = BROADCAST_MESSAGES[status] || BROADCAST_MESSAGES.idle;
  const showBg = status !== "idle";

  dom.emptyTitle.textContent = msgs.title;

  // Show match info as subtitle if available (e.g., "Hammarby vs AIK"), or
  // when, where and who from the schedule if the camera named its match.
  const announced = broadcastState?.upcoming ?? [];
  const match = announced.length === 1 ? findMatch(announced[0].matchId) : null;
  if (status === "upcoming" && match) {
    dom.emptySub.textContent = describeMatch(match, { withOwnTeam: true });
  } else if (broadcastState?.message && status === "upcoming") {
    dom.emptySub.textContent = broadcastState.message;
  } else {
    dom.emptySub.textContent = msgs.sub;
  }

  renderSchedule(status, announced);

  // Toggle background image for non-idle states
  dom.emptyBg.classList.toggle("active", showBg);

  // Toggle state-specific class on empty-state container
  dom.emptyState.className = "empty-state" + (status !== "idle" ? ` ${status}` : "");
}

// ============================
// Schedule under the empty state (ABL-048)
// ============================

/** What the schedule block shows now, so a poll that changes nothing leaves it (and focus) alone. */
let scheduleShown = "";
/** The arguments it was last drawn with, to draw it again when the team filter changes. */
let scheduleArgs = ["idle", [], []];

document.addEventListener(TEAM_FILTER_EVENT, () => renderSchedule(...scheduleArgs));

/**
 * "Nästa match" as a match card, and a few after it, each with "Lägg till i
 * kalendern". A match a camera has announced, or is sending, already has its
 * card above, so it is left out here. With several of the club's teams in the
 * list, the team filter goes on top (ABL-049).
 */
function renderSchedule(status, announced, liveIds = []) {
  const el = dom.emptySchedule;
  if (!el) return;
  scheduleArgs = [status, announced, liveIds];
  const skip = new Set([...announced.map((u) => u.matchId), ...liveIds].filter(Boolean));
  const filter = teamFilter(
    upcomingMatches().filter((m) => !skip.has(m.id)),
    (m) => m.ownTeam,
    () => {
      scheduleShown = "";
      renderSchedule(...scheduleArgs);
    },
  );
  const list = filter.shown;
  const headline = status === "idle" ? list[0] : null;
  const later = (headline ? list.slice(1) : list).slice(0, headline ? 3 : 4);

  const shown = JSON.stringify([status, filter.keys, filter.chosen, headline, later, liveIds]);
  if (shown === scheduleShown) return;
  scheduleShown = shown;
  const focusedFilter = focusedTeamFilter();

  el.replaceChildren();
  el.classList.toggle("hidden", list.length === 0);
  if (filter.row) el.append(filter.row);
  if (headline) {
    const next = document.createElement("div");
    next.className = "empty-schedule-title";
    next.textContent = "Nästa match";
    el.append(next, upcomingCard(headline));
  }
  if (later.length > 0) {
    const title = document.createElement("div");
    title.className = "empty-schedule-title";
    title.textContent = headline ? "Sedan" : "Kommande matcher";
    const items = document.createElement("ul");
    items.className = "empty-schedule-list";
    for (const match of later) {
      const li = document.createElement("li");
      li.append(upcomingCard(match));
      items.append(li);
    }
    el.append(title, items);
  }
  focusTeamFilter(el, focusedFilter);
}

/**
 * The schedule sits in the empty state while nothing is sent, and under the
 * live cards while something is. Moved rather than drawn twice, so it keeps
 * its state and focus.
 */
function placeSchedule(underLive) {
  const el = dom.emptySchedule;
  if (!el || el.classList.contains("under-live") === underLive) return;
  el.classList.toggle("under-live", underLive);
  if (underLive) dom.streamGrid.after(el);
  else dom.emptyState.querySelector(".empty-content").append(el);
  scheduleShown = "";
}

/** A match still to be played: its card and "Lägg till i kalendern". */
function upcomingCard(match) {
  const card = document.createElement("div");
  card.className = "match-card";
  card.dataset.matchId = match.id;
  card.append(upcomingHead(match), calendarButton(match));
  return card;
}

function calendarButton(match) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "calendar-btn";
  btn.textContent = "Lägg till i kalendern";
  btn.setAttribute("aria-label", `Lägg till ${match.ownTeam.name} mot ${match.opponent.name} i kalendern`);
  btn.addEventListener("click", () => downloadIcs(match, { clubName: club.name }));
  return btn;
}

/**
 * The header dot and LIVE label, from every match at once (ABL-051): live while
 * any match is live or paused, so one match ending never turns another off.
 */
function updateHeaderStatus(streams, broadcastState) {
  const status = broadcastState?.status;
  const hasLive = streams.length > 0
    ? streams.some((s) => s.status === "live" || s.status === "paused")
    : status === "live" || status === "paused";
  const upcoming = status === "upcoming" || (broadcastState?.upcoming?.length ?? 0) > 0;
  dom.statusDot.className = `status-dot ${hasLive ? "live" : upcoming ? "upcoming" : "offline"}`;
  // Drives the LIVE label in the header and the dot on the Live tab
  document.body.classList.toggle("is-live", hasLive);
}

/** A card per match announced from a camera but not started yet. */
function announcedCard(u) {
  const match = findMatch(u.matchId);
  const pill = { cls: "upcoming", text: "SNART", spoken: "startar snart" };
  const card = document.createElement("div");
  card.className = "stream-card upcoming";
  if (match) {
    card.dataset.matchId = match.id;
    const body = document.createElement("span");
    body.className = "stream-card-body";
    body.append(upcomingHead(match, { pill }));
    card.append(body);
    return card;
  }
  // Announced from an older app, by name only
  card.innerHTML = `
      <span class="stream-card-poster">
        <span class="stream-card-top">
          <span class="stream-card-badge upcoming">SNART</span>
        </span>
      </span>
      <span class="stream-card-body">
        <span class="stream-card-name">${escapeHtml(u.message || "Nästa match")}</span>
      </span>`;
  return card;
}

/** What a stream's status line starts with, and how a screen reader says it. */
const STREAM_STATUS = {
  live: { cls: "live", text: "LIVE", spoken: "live" },
  waiting: { cls: "waiting", text: "STARTAR", spoken: "startar" },
  stopped: { cls: "stopped", text: "AVBRUTEN", spoken: "avbruten" },
  paused: { cls: "paused", text: "PAUS", spoken: "paus" },
};

/**
 * A live card: the live picture, then the match as on every other card,
 * "LIVE  Period 2 · 14 tittare" (ABL-049). A stream with no teams known (one
 * started before the names were kept) is shown by its name, as before.
 * With several cameras on one match, each card also names its camera.
 */
function streamCard(s, { withCamera }) {
  const status = s.status === "paused" && s.pauseType
    ? { cls: "paused", text: pauseLabel(s.pauseType), spoken: pauseLabel(s.pauseType).toLowerCase() }
    : STREAM_STATUS[s.status] || STREAM_STATUS.waiting;
  const isStopped = s.status === "stopped";
  const isPaused = s.status === "paused";
  const teams = matchTeams(findMatch(s.matchId), s.homeTeam, s.awayTeam);
  const name = teams ? matchName(teams) + (withCamera ? ` \u00b7 ${s.name}` : "") : s.name;

  const card = document.createElement("button");
  card.className = `stream-card${isStopped ? " stopped" : ""}${isPaused ? " paused" : ""}`;
  card.dataset.hls = s.hlsUrl;
  card.dataset.dvr = s.dvrUrl || "";
  card.dataset.name = name;
  card.dataset.id = s.id;
  if (s.matchId) card.dataset.matchId = s.matchId;
  card.disabled = isStopped;
  card.innerHTML = `
      <span class="stream-card-poster">
        ${s.posterUrl ? `<img class="stream-card-image" alt="" data-poster="${escapeHtml(s.posterUrl)}">` : ""}
        ${teams ? "" : `<span class="stream-card-top">
          <span class="stream-card-badge ${status.cls}">${escapeHtml(status.text)}</span>
          ${s.viewers > 0 ? `<span class="stream-card-viewers">${escapeHtml(String(s.viewers))} tittare</span>` : ""}
        </span>`}
        ${isStopped ? "" : `<span class="stream-card-play" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg></span>`}
      </span>
      <span class="stream-card-body">
        ${teams ? "" : `<span class="stream-card-name">${escapeHtml(s.name)}</span>`}
        ${isStopped ? "" : `<span class="stream-card-cta">Titta${s.status === "live" ? " live" : ""}</span>`}
      </span>`;

  if (teams) {
    const period = (s.status === "live" || isPaused) && s.period ? `Period ${s.period}` : "";
    const viewers = s.viewers > 0 ? `${s.viewers} tittare` : "";
    const spoken = [spokenTeams(teams), status.spoken, period.toLowerCase(), viewers, withCamera && s.name]
      .filter(Boolean).join(", ");
    const head = matchHead(teams, { tag: "span", pill: status, parts: [period, viewers], spoken });
    if (withCamera) {
      const camera = document.createElement("span");
      camera.className = "mc-camera";
      camera.setAttribute("aria-hidden", "true");
      camera.textContent = s.name;
      head.append(camera);
    }
    card.querySelector(".stream-card-body").prepend(head);
  }
  return card;
}

function renderStreamList(streams, broadcastState) {
  // If broadcast is "upcoming", the operator's just-posted announcement
  // must win over lingering stopped cards (backend keeps stopped streams in
  // the list for STOPPED_TTL_MS). Treat an all-stopped list as empty so the
  // upcoming message is visible instead of being hidden behind AVBRUTEN cards.
  const hasNonStopped = streams && streams.some((s) => s.status !== "stopped");
  const showAsEmpty =
    !streams ||
    streams.length === 0 ||
    (broadcastState?.status === "upcoming" && !hasNonStopped);

  updateHeaderStatus(streams || [], broadcastState);

  if (showAsEmpty) {
    dom.streamGrid.innerHTML = "";
    dom.streamGrid.classList.add("hidden");
    dom.emptyState.classList.remove("hidden");
    placeSchedule(false);
    updateEmptyState(broadcastState);
    return;
  }

  dom.emptyState.classList.add("hidden");
  dom.streamGrid.classList.remove("hidden");

  // The coming matches stay in view under the live cards
  placeSchedule(true);
  const liveIds = streams.filter((s) => s.status !== "stopped").map((s) => s.matchId);
  renderSchedule("live", broadcastState?.upcoming ?? [], liveIds);

  // Matches with more than one camera on the list
  const perMatch = new Map();
  for (const s of streams) {
    if (s.matchId) perMatch.set(s.matchId, (perMatch.get(s.matchId) || 0) + 1);
  }

  dom.streamGrid.replaceChildren(
    ...streams.map((s) => streamCard(s, { withCamera: perMatch.get(s.matchId) > 1 })),
    ...(broadcastState?.upcoming ?? []).map(announcedCard),
  );

  // The live picture, renewed about once a minute (ABL-045)
  dom.streamGrid.querySelectorAll("img[data-poster]").forEach((img) => {
    showImage(img, img.dataset.poster, { slot: img.closest(".stream-card").dataset.id });
  });

  dom.streamGrid.querySelectorAll("button.stream-card:not([disabled])").forEach((card) => {
    card.addEventListener("click", () => {
      openPlayer(card.dataset.hls, card.dataset.name, card.dataset.id, card.dataset.dvr);
    });
  });

  // No auto-open — user always picks which stream to watch
}

// ============================
// Polling
// ============================

async function pollStreamList() {
  // The schedule is fetched at most once a minute (matches.js), the teams once.
  const [streams, broadcastState] = await Promise.all([
    fetchStreams(),
    fetchBroadcastState(),
    loadMatches(),
    loadTeams(),
  ]);
  if (streams !== null) {
    renderStreamList(streams, broadcastState);
  } else if (broadcastState) {
    // Even if stream fetch failed (e.g. no token yet), show broadcast state
    renderStreamList([], broadcastState);
  }
}

export function startListPolling() {
  clearInterval(state.listPollTimer);
  pollStreamList();
  state.listPollTimer = setInterval(pollStreamList, CONFIG.LIST_POLL_INTERVAL);
}

export function stopListPolling() {
  clearInterval(state.listPollTimer);
}

// ============================
// Init
// ============================

export function initStreams() {
  // No special init needed -- polling is started by the orchestrator
}
