// === Streams module ===
// Stream list fetching, rendering, polling, auto-open logic.

import { CONFIG } from "./config.js";
import { state, dom } from "./state.js";
import { escapeHtml } from "./utils.js";
import { authHeaders, showPinScreen } from "./auth.js";
import { openPlayer, pauseLabel } from "./player.js";

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

  // Show match info as subtitle if available (e.g., "Hammarby vs AIK")
  if (broadcastState?.message && status === "upcoming") {
    dom.emptySub.textContent = broadcastState.message;
  } else {
    dom.emptySub.textContent = msgs.sub;
  }

  // Toggle background image for non-idle states
  dom.emptyBg.classList.toggle("active", showBg);

  // Toggle state-specific class on empty-state container
  dom.emptyState.className = "empty-state" + (status !== "idle" ? ` ${status}` : "");

  // Update status dot for upcoming
  if (status === "upcoming") {
    dom.statusDot.className = "status-dot upcoming";
  }
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

  if (showAsEmpty) {
    dom.streamGrid.innerHTML = "";
    dom.streamGrid.classList.add("hidden");
    dom.emptyState.classList.remove("hidden");
    updateEmptyState(broadcastState);
    document.body.classList.remove("is-live");
    if (!broadcastState || broadcastState.status === "idle") {
      dom.statusDot.className = "status-dot offline";
    }
    return;
  }

  dom.emptyState.classList.add("hidden");
  dom.streamGrid.classList.remove("hidden");

  const hasLive = streams.some((s) => s.status === "live" || s.status === "paused");
  dom.statusDot.className = hasLive ? "status-dot live" : "status-dot offline";
  // Drives the LIVE label in the header and the dot on the Live tab
  document.body.classList.toggle("is-live", hasLive);

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
    .join("");

  dom.streamGrid.querySelectorAll(".stream-card:not([disabled])").forEach((card) => {
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
  const [streams, broadcastState] = await Promise.all([
    fetchStreams(),
    fetchBroadcastState(),
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
