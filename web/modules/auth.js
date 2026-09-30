// === PIN / Auth module ===

import { CONFIG } from "./config.js";
import { state, dom } from "./state.js";
import { stopListPolling } from "./streams.js";
import { stopVodPolling } from "./vod.js";

// Callbacks injected by the orchestrator via initAuth()
let onAuthSuccess = null; // called after successful PIN or when no PIN required
let onActivateAdmin = null; // called when admin PIN entered
let onDeactivateAdmin = null; // called on logout

/** Build Authorization header using viewer token */
export function authHeaders() {
  const h = {};
  if (state.viewerToken) h["Authorization"] = `Bearer ${state.viewerToken}`;
  return h;
}

/** Show the PIN overlay and hide everything else */
export function showPinScreen() {
  stopListPolling();
  stopVodPolling();
  dom.streamListView.classList.add("hidden");
  dom.vodListView.classList.add("hidden");
  dom.adminView.classList.add("hidden");
  dom.playerView.classList.add("hidden");
  dom.tabNav.classList.add("hidden");
  dom.pinView.classList.remove("hidden");
  dom.pinInput.value = "";
  dom.pinError.classList.add("hidden");
  dom.pinInput.focus();
}

/** Hide PIN overlay and show the appropriate tab view */
function hidePinScreen() {
  dom.pinView.classList.add("hidden");
  dom.tabNav.classList.remove("hidden");
  dom.headerLogout.classList.remove("hidden");
  if (state.activeTab === "live") {
    dom.streamListView.classList.remove("hidden");
  } else if (state.activeTab === "admin") {
    dom.adminView.classList.remove("hidden");
  } else {
    dom.vodListView.classList.remove("hidden");
  }
}

/** Submit PIN to the backend and handle result */
async function submitPin() {
  const pin = dom.pinInput.value.trim();
  if (!pin) return;

  dom.pinSubmit.disabled = true;
  dom.pinError.classList.add("hidden");

  try {
    const res = await fetch(`${CONFIG.API_URL}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });

    if (!res.ok) {
      dom.pinError.classList.remove("hidden");
      dom.pinError.classList.remove("shake");
      // Trigger reflow for animation restart
      void dom.pinError.offsetWidth;
      dom.pinError.classList.add("shake");
      dom.pinInput.select();
      dom.pinSubmit.disabled = false;
      return;
    }

    const data = await res.json();
    state.viewerToken = data.token;
    localStorage.setItem("viewerToken", state.viewerToken);

    // If admin PIN was entered, activate admin mode
    if (data.role === "admin" && data.adminToken) {
      state.adminToken = data.adminToken;
      localStorage.setItem("adminToken", state.adminToken);
      if (onActivateAdmin) onActivateAdmin();
    } else {
      hidePinScreen();
      if (onAuthSuccess) onAuthSuccess();
    }
  } catch {
    dom.pinError.textContent = "Kunde inte ansluta \u2014 f\u00f6rs\u00f6k igen";
    dom.pinError.classList.remove("hidden");
  }
  dom.pinSubmit.disabled = false;
}

/** Log out the viewer (and admin if applicable) */
export function logoutViewer() {
  state.viewerToken = null;
  localStorage.removeItem("viewerToken");
  state.adminToken = null;
  localStorage.removeItem("adminToken");
  if (onDeactivateAdmin) onDeactivateAdmin();
  dom.headerLogout.classList.add("hidden");
  showPinScreen();
}

/** Check auth status on startup and either show PIN or proceed */
export async function checkAuthAndStart() {
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/auth/status`);
    const data = await res.json();

    if (!data.pinRequired) {
      // No PIN needed -- go straight to streams
      hidePinScreen();
      if (onAuthSuccess) onAuthSuccess();
      return;
    }

    // PIN required -- check if we have a valid token
    if (state.viewerToken) {
      const testRes = await fetch(`${CONFIG.API_URL}/api/streams`, {
        headers: authHeaders(),
      });
      if (testRes.ok) {
        // Token still valid
        hidePinScreen();
        if (onAuthSuccess) onAuthSuccess();
        return;
      }
      // Token expired
      state.viewerToken = null;
      localStorage.removeItem("viewerToken");
    }

    // Show PIN screen
    showPinScreen();
  } catch {
    // Backend unreachable -- show streams anyway (will show empty/error)
    hidePinScreen();
    if (onAuthSuccess) onAuthSuccess();
  }
}

/** Bind PIN-related event listeners */
function bindPinEvents() {
  dom.pinSubmit.addEventListener("click", submitPin);
  dom.pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPin();
  });
  dom.headerLogout.addEventListener("click", logoutViewer);
}

/**
 * Initialise the auth module.
 * @param {Object} callbacks
 * @param {Function} callbacks.onAuthSuccess  - called after successful auth (start list polling)
 * @param {Function} callbacks.onActivateAdmin - called when admin PIN entered
 * @param {Function} callbacks.onDeactivateAdmin - called on admin logout
 */
export function initAuth(callbacks) {
  onAuthSuccess = callbacks.onAuthSuccess;
  onActivateAdmin = callbacks.onActivateAdmin;
  onDeactivateAdmin = callbacks.onDeactivateAdmin;
  bindPinEvents();
}
