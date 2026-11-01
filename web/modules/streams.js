// === Streams module ===
// Stream list fetching, rendering, polling, auto-open logic.

import { CONFIG } from "./config.js";
import { state, dom } from "./state.js";
import { escapeHtml } from "./utils.js";
import { authHeaders, showPinScreen } from "./auth.js";
import { openPlayer, pauseLabel } from "./player.js";
import { showImage } from "./images.js";
import { club } from "./club.js";
import { loadMatches, findMatch, upcomingMatches, describeMatch, severalOwnTeams, downloadIcs } from "./matches.js";

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

/**
 * "Nästa match: lör 8 nov 14:00 mot Hornets, Sporthallen" and a few after it,
 * each with "Lägg till i kalendern". A match a camera has announced already
 * shows above as starting soon, so it is left out here.
 */
function renderSchedule(status, announced) {
  const el = dom.emptySchedule;
  if (!el) return;
  const skip = new Set(announced.map((u) => u.matchId).filter(Boolean));
  const list = upcomingMatches().filter((m) => !skip.has(m.id));
  const withOwnTeam = severalOwnTeams(list);
  const headline = status === "idle" ? list[0] : null;
  const later = (headline ? list.slice(1) : list).slice(0, headline ? 3 : 4);

  const shown = JSON.stringify([status, withOwnTeam, headline, later]);
  if (shown === scheduleShown) return;
  scheduleShown = shown;

  el.replaceChildren();
  el.classList.toggle("hidden", list.length === 0);
  if (headline) {
    const next = document.createElement("div");
    next.className = "empty-next";
    next.textContent = `Nästa match: ${describeMatch(headline, { withOwnTeam })}`;
    el.append(next, calendarButton(headline));
  }
  if (later.length > 0) {
    const title = document.createElement("div");
    title.className = "empty-schedule-title";
    title.textContent = headline ? "Sedan" : "Kommande matcher";
    const items = document.createElement("ul");
    items.className = "empty-schedule-list";
    for (const match of later) {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = describeMatch(match, { withOwnTeam });
      li.append(text, calendarButton(match));
      items.append(li);
    }
    el.append(title, items);
  }
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
function upcomingCards(broadcastState) {
  return (broadcastState?.upcoming ?? [])
    .map((u) => `
    <div class="stream-card upcoming">
      <span class="stream-card-poster">
        <span class="stream-card-top">
          <span class="stream-card-badge upcoming">SNART</span>
        </span>
      </span>
      <span class="stream-card-body">
        <span class="stream-card-name">${escapeHtml(u.message || "Nästa match")}</span>
      </span>
    </div>`)
    .join("");
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
    updateEmptyState(broadcastState);
    return;
  }

  dom.emptyState.classList.add("hidden");
  dom.streamGrid.classList.remove("hidden");

  const badgeMap = {
    live: { cls: "live", text: "S\u00c4NDER LIVE" },
    waiting: { cls: "waiting", text: "STARTAR..." },
    stopped: { cls: "stopped", text: "AVBRUTEN" },
    paused: { cls: "paused", text: "PAUSAD" },
  };

  dom.streamGrid.innerHTML = streams
    .map((s) => {
      const badge = s.status === "paused" && s.pauseType
        ? { cls: "paused", text: pauseLabel(s.pauseType) }
        : badgeMap[s.status] || badgeMap.waiting;
      const isStopped = s.status === "stopped";
      const isPaused = s.status === "paused";
      return `
    <button class="stream-card ${isStopped ? "stopped" : ""}${isPaused ? " paused" : ""}" data-hls="${escapeHtml(s.hlsUrl)}" data-dvr="${s.dvrUrl ? escapeHtml(s.dvrUrl) : ""}" data-name="${escapeHtml(s.name)}" data-id="${escapeHtml(s.id)}" ${isStopped ? "disabled" : ""}>
      <span class="stream-card-poster">
        ${s.posterUrl ? `<img class="stream-card-image" alt="" data-poster="${escapeHtml(s.posterUrl)}">` : ""}
        <span class="stream-card-top">
          <span class="stream-card-badge ${badge.cls}">${escapeHtml(badge.text)}</span>
          ${s.viewers > 0 ? `<span class="stream-card-viewers">${escapeHtml(String(s.viewers))} tittare</span>` : ""}
        </span>
        ${isStopped ? "" : `<span class="stream-card-play" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg></span>`}
      </span>
      <span class="stream-card-body">
        <span class="stream-card-name">${escapeHtml(s.name)}</span>
        ${isStopped ? "" : `<span class="stream-card-cta">Titta${s.status === "live" ? " live" : ""}</span>`}
      </span>
    </button>`;
    })
    .join("") + upcomingCards(broadcastState);

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
  // The schedule is fetched at most once a minute (matches.js).
  const [streams, broadcastState] = await Promise.all([
    fetchStreams(),
    fetchBroadcastState(),
    loadMatches(),
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
