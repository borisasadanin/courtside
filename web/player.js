// === Courtside — Entry Point ===
// Orchestrates all modules. No business logic lives here.

import { state, dom, initDom } from "./modules/state.js";
import { loadClub } from "./modules/club.js";
import { initAuth, checkAuthAndStart } from "./modules/auth.js";
import {
  initPlayer,
  closePlayer,
  startStreamPolling,
  stopStreamPolling,
  startViewerHeartbeat,
  stopViewerHeartbeat,
  pollCurrentStream,
} from "./modules/player.js";
import { initStreams, startListPolling, stopListPolling } from "./modules/streams.js";
import { initVod, startVodPolling, stopVodPolling } from "./modules/vod.js";
import { initHighlights, playClip } from "./modules/highlights.js";
import { checkDeepLink } from "./modules/deeplink.js";
import {
  initAdmin,
  activateAdmin,
  deactivateAdmin,
  loadAdminStorage,
  checkAdminSession,
  showAdminPage,
} from "./modules/admin.js";

// ============================
// Tab Navigation
// ============================

function switchTab(tab) {
  if (tab === state.activeTab) return;
  state.activeTab = tab;

  // Update tab buttons
  dom.tabNav.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  // Hide all views
  stopListPolling();
  stopVodPolling();
  dom.streamListView.classList.add("hidden");
  dom.vodListView.classList.add("hidden");
  dom.adminView.classList.add("hidden");

  if (tab === "live") {
    dom.streamListView.classList.remove("hidden");
    startListPolling();
  } else if (tab === "vod") {
    dom.vodListView.classList.remove("hidden");
    startVodPolling();
  } else if (tab === "admin") {
    dom.adminView.classList.remove("hidden");
    showAdminPage("overview");
    loadAdminStorage();
  }
}

// ============================
// Offline / Online / Visibility
// ============================

function bindGlobalEvents() {
  // Tab navigation
  dom.tabNav.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Offline/online indicator
  const offlineBanner = document.getElementById("offlineBanner");
  window.addEventListener("offline", () => {
    offlineBanner.classList.remove("hidden");
  });
  window.addEventListener("online", () => {
    offlineBanner.classList.add("hidden");
  });

  // Visibility change — pause/resume polling
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Stop all polling to save resources in background tabs
      stopListPolling();
      stopVodPolling();
      stopStreamPolling();
      stopViewerHeartbeat();
    } else {
      // Resume relevant polling when tab becomes visible
      if (!dom.playerView.classList.contains("hidden")) {
        // Player is open
        if (!state.isVodMode) {
          startStreamPolling();
          startViewerHeartbeat();
          // Also check stream status immediately
          if (state.currentStreamUrl && state.currentStatus !== "live") {
            pollCurrentStream();
          }
        }
      } else {
        // No player open — resume list polling for the active tab
        if (state.activeTab === "live") {
          startListPolling();
        } else if (state.activeTab === "vod") {
          startVodPolling();
        }
      }
    }
  });
}

// ============================
// Player close handler
// ============================

function handleClosePlayer(wasVod) {
  // Restore the correct tab view
  dom.tabNav.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === (wasVod ? "vod" : "live"));
  });
  dom.streamListView.classList.add("hidden");
  dom.vodListView.classList.add("hidden");
  dom.adminView.classList.add("hidden");

  if (wasVod) {
    state.activeTab = "vod";
    dom.vodListView.classList.remove("hidden");
    startVodPolling();
  } else {
    state.activeTab = "live";
    dom.streamListView.classList.remove("hidden");
    startListPolling();
  }
}

// ============================
// Init
// ============================

async function init() {
  // 1. Initialise DOM references
  initDom();

  // 1b. Load club identity and theme the page before anything is shown —
  //     the PIN screen is branded too, so this cannot wait until after auth.
  await loadClub();

  // 2. Initialise each module with cross-module callbacks
  initAuth({
    onAuthSuccess: () => {
      startListPolling();
      checkDeepLink({ switchTab, playClip }).catch((err) =>
        console.error("[player] checkDeepLink failed:", err)
      );
    },
    onActivateAdmin: () => activateAdmin(),
    onDeactivateAdmin: () => deactivateAdmin(),
  });

  initPlayer({
    onClosePlayer: handleClosePlayer,
  });

  initStreams();

  initVod();

  initHighlights();

  initAdmin({
    onSwitchTab: switchTab,
  });

  // 3. Bind global events (tabs, offline/online, visibility)
  bindGlobalEvents();

  // 4. Check auth & admin session, then start
  checkAuthAndStart();
  checkAdminSession();
}

init();
