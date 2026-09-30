// === Admin module ===
// Admin panel: storage display, VOD management, delete with two-click confirm.

import { CONFIG } from "./config.js";
import { state, dom } from "./state.js";
import { escapeHtml, formatDuration, formatDate, formatBytes } from "./utils.js";
import { logoutViewer } from "./auth.js";

// Callback injected by the orchestrator
let onSwitchTab = null;

// ============================
// Admin headers
// ============================

function adminHeaders() {
  return { "X-Admin-Token": state.adminToken };
}

// ============================
// Activate / deactivate
// ============================

export function activateAdmin() {
  dom.adminTab.classList.remove("hidden");
  dom.headerLogout.classList.remove("hidden");
  dom.pinView.classList.add("hidden");
  dom.tabNav.classList.remove("hidden");
  if (onSwitchTab) onSwitchTab("admin");
}

export function deactivateAdmin() {
  state.adminToken = null;
  localStorage.removeItem("adminToken");
  dom.adminTab.classList.add("hidden");
  dom.adminView.classList.add("hidden");
  if (state.activeTab === "admin") {
    if (onSwitchTab) onSwitchTab("live");
  }
}

// ============================
// Storage & VOD list
// ============================

export async function loadAdminStorage() {
  dom.adminStorageSummary.innerHTML = '<div class="spinner"></div>';
  dom.adminVodList.innerHTML = "";

  try {
    const res = await fetch(`${CONFIG.API_URL}/api/admin/storage`, {
      headers: adminHeaders(),
    });

    if (res.status === 401) {
      deactivateAdmin();
      return;
    }

    if (!res.ok) throw new Error(res.status);
    const data = await res.json();

    // Render storage summary with capacity bar
    const totalFormatted = formatBytes(data.totalBytes);
    const capacityFormatted = formatBytes(data.capacityBytes);
    const usedPercent = data.capacityBytes > 0
      ? Math.min(100, (data.totalBytes / data.capacityBytes) * 100)
      : 0;
    const barClass = usedPercent > 90 ? "danger" : usedPercent > 70 ? "warning" : "";
    dom.adminStorageSummary.innerHTML = `
      <div class="storage-total">${escapeHtml(totalFormatted)} av ${escapeHtml(capacityFormatted)}</div>
      <div class="storage-label">Lagringsutrymme anv\u00e4nt (${escapeHtml(String(data.vodCount))} repriser)</div>
      <div class="storage-bar-container">
        <div class="storage-bar">
          <div class="storage-bar-fill ${barClass}" style="width: ${usedPercent.toFixed(1)}%"></div>
        </div>
        <div class="storage-stats">
          <span>${usedPercent.toFixed(0)}% anv\u00e4nt</span>
          <span>${escapeHtml(formatBytes(data.capacityBytes - data.totalBytes))} ledigt</span>
        </div>
      </div>
    `;

    // Render VOD list
    if (data.vods.length === 0) {
      dom.adminVodList.innerHTML =
        '<p style="color: var(--text-muted); text-align: center; padding: 20px;">Inga repriser</p>';
      return;
    }

    dom.adminVodList.innerHTML = data.vods
      .map((v) => {
        const date = formatDate(v.matchDate);
        const duration = formatDuration(v.durationSeconds);
        const size = formatBytes(v.sizeBytes);
        const teams =
          v.homeTeam && v.awayTeam
            ? `${escapeHtml(v.homeTeam)} vs ${escapeHtml(v.awayTeam)}`
            : "";
        return `
      <div class="admin-vod-item" data-id="${escapeHtml(v.id)}">
        <div class="admin-vod-info">
          <div class="admin-vod-title">${escapeHtml(v.matchTitle || "Inspelning")}</div>
          <div class="admin-vod-meta">
            ${teams ? `<span>${teams}</span>` : ""}
            ${date ? `<span>${escapeHtml(date)}</span>` : ""}
            ${duration ? `<span>${escapeHtml(duration)}</span>` : ""}
          </div>
        </div>
        <div class="admin-vod-size">${escapeHtml(size)}</div>
        <button class="admin-vod-delete" data-id="${escapeHtml(v.id)}" data-title="${escapeHtml(v.matchTitle || "")}">Ta bort</button>
      </div>`;
      })
      .join("");

    // Bind delete buttons
    dom.adminVodList.querySelectorAll(".admin-vod-delete").forEach((btn) => {
      btn.addEventListener("click", () => handleDeleteVod(btn));
    });
  } catch {
    dom.adminStorageSummary.innerHTML =
      '<p style="color: var(--red);">Kunde inte ladda lagringsinformation</p>';
  }
}

async function handleDeleteVod(btn) {
  const vodId = btn.dataset.id;

  // Two-click confirm
  if (!btn.classList.contains("confirming")) {
    btn.classList.add("confirming");
    btn.textContent = "Bekr\u00e4fta?";
    setTimeout(() => {
      if (btn.classList.contains("confirming")) {
        btn.classList.remove("confirming");
        btn.textContent = "Ta bort";
      }
    }, 3000);
    return;
  }

  btn.disabled = true;
  btn.textContent = "Tar bort...";

  try {
    const res = await fetch(`${CONFIG.API_URL}/api/vod/${vodId}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });

    if (res.status === 401) {
      deactivateAdmin();
      return;
    }

    if (res.ok || res.status === 204) {
      // Remove item from DOM with animation
      const item = btn.closest(".admin-vod-item");
      item.style.opacity = "0";
      item.style.transform = "translateX(20px)";
      item.style.transition = "opacity 0.3s, transform 0.3s";
      setTimeout(() => {
        item.remove();
        // Reload to update totals
        loadAdminStorage();
      }, 300);
    } else {
      btn.textContent = "Misslyckades";
      btn.disabled = false;
      setTimeout(() => {
        btn.textContent = "Ta bort";
        btn.classList.remove("confirming");
      }, 2000);
    }
  } catch {
    btn.textContent = "Fel";
    btn.disabled = false;
    setTimeout(() => {
      btn.textContent = "Ta bort";
      btn.classList.remove("confirming");
    }, 2000);
  }
}

// ============================
// Verify admin session on startup
// ============================

export async function checkAdminSession() {
  if (!state.adminToken) return;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/admin/verify`, {
      headers: adminHeaders(),
    });
    if (res.ok) {
      dom.adminTab.classList.remove("hidden");
    } else {
      state.adminToken = null;
      localStorage.removeItem("adminToken");
    }
  } catch {
    // Silently fail -- admin will be hidden
  }
}

// ============================
// Event binding
// ============================

function bindAdminEvents() {
  dom.adminLogout.addEventListener("click", logoutViewer);
}

/**
 * Initialise the admin module.
 * @param {Object} callbacks
 * @param {Function} callbacks.onSwitchTab - called to switch to a tab (e.g. "admin" or "live")
 */
export function initAdmin(callbacks) {
  onSwitchTab = callbacks.onSwitchTab;
  bindAdminEvents();
}
