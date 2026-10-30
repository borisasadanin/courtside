// === Admin module ===
// Admin panel: storage display, VOD management, delete with two-click confirm.

import { CONFIG } from "./config.js";
import { state, dom } from "./state.js";
import { escapeHtml, formatDuration, formatDate, formatBytes } from "./utils.js";
import { logoutViewer } from "./auth.js";
import { loadDevices, startPairing } from "./devices.js";
import { renderBranding, renderPrivacyAdmin } from "./branding.js";
import { renderTeardown } from "./teardown.js";
import { renderPins } from "./pins.js";
import { renderUpdate } from "./update.js";

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
// Pages: overview and one page per section
// ============================

/** Show the overview or one section of Hantera ("branding", "pins", …). */
export function showAdminPage(name) {
  dom.adminView.querySelectorAll("[data-admin-page]").forEach((page) => {
    page.classList.toggle("hidden", page.dataset.adminPage !== name);
  });
  // The title and logout belong to the overview; sections have their own back button.
  dom.adminView.querySelector(".admin-header").classList.toggle("hidden", name !== "overview");
  window.scrollTo(0, 0);
}

// ============================
// Storage & VOD list
// ============================

/** The address viewers use: this site, without any path or code. */
function renderShare() {
  const a = document.getElementById("adminShareUrl");
  if (!a) return;
  a.href = location.origin;
  a.textContent = location.host;
  const copy = document.getElementById("adminShareCopy");
  copy.onclick = () => navigator.clipboard.writeText(location.origin).then(() => { copy.textContent = "Adressen är kopierad"; });
}

export async function loadAdminStorage() {
  dom.adminStorageSummary.innerHTML = '<div class="spinner"></div>';
  dom.adminVodList.innerHTML = "";

  // Cameras load alongside storage — both belong to the admin view.
  loadDevices();
  renderBranding();
  renderPrivacyAdmin();
  renderTeardown();
  renderShare();
  renderPins();
  renderUpdate();
  renderDeletions();

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

    const vodSub = document.getElementById("adminRowVodSub");
    if (vodSub) vodSub.textContent = `${data.vodCount} st · ${totalFormatted}`;

    // Render VOD list
    const orphans = data.orphanClips || [];
    if (data.vods.length === 0 && orphans.length === 0) {
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
          ${renderClipList(v.clips || [], `${(v.clips || []).length} klipp`)}
        </div>
        <div class="admin-vod-size">${escapeHtml(size)}</div>
        <button class="admin-vod-delete" data-id="${escapeHtml(v.id)}" data-title="${escapeHtml(v.matchTitle || "")}">Ta bort</button>
      </div>`;
      })
      .join("") +
      (orphans.length
        ? `
      <div class="admin-vod-item">
        <div class="admin-vod-info">
          <div class="admin-vod-title">Klipp fr\u00e5n borttagna matcher</div>
          <div class="admin-vod-meta"><span>Matchen \u00e4r borttagen men klippen g\u00e5r fortfarande att se via delade l\u00e4nkar.</span></div>
          ${renderClipList(orphans, `${orphans.length} klipp`, true)}
        </div>
      </div>`
        : "");

    // Bind delete buttons
    dom.adminVodList.querySelectorAll(".admin-vod-delete[data-id]").forEach((btn) => {
      btn.addEventListener("click", () =>
        handleDelete(btn, `/api/vod/${encodeURIComponent(btn.dataset.id)}`, btn.closest(".admin-vod-item")));
    });
    dom.adminVodList.querySelectorAll(".admin-clip-delete").forEach((btn) => {
      btn.addEventListener("click", () =>
        handleDelete(btn, `/api/clips/${encodeURIComponent(btn.dataset.clip)}`, btn.closest(".admin-clip-item")));
    });
  } catch {
    dom.adminStorageSummary.innerHTML =
      '<p style="color: var(--red);">Kunde inte ladda lagringsinformation</p>';
  }
}

/** A match's clips, each removable on its own: removing one ends its shared link. */
function renderClipList(clips, summary, open = false) {
  if (clips.length === 0) return "";
  const items = clips
    .map((c) => {
      const d = new Date(c.createdAt);
      const time = isNaN(d) ? "" : d.toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      return `
        <li class="admin-clip-item">
          <span class="admin-clip-label">${escapeHtml(c.label || "H\u00f6jdpunkt")}</span>
          ${time ? `<span class="admin-clip-time">${escapeHtml(time)}</span>` : ""}
          <button class="admin-vod-delete admin-clip-delete" data-clip="${escapeHtml(c.id)}">Ta bort</button>
        </li>`;
    })
    .join("");
  return `
    <details class="admin-vod-clips"${open ? " open" : ""}>
      <summary>${escapeHtml(summary)}</summary>
      <ul>${items}</ul>
    </details>`;
}

/**
 * What has been deleted, so the club can show that a request was carried out.
 * The log holds the match and the date, never who asked.
 */
async function renderDeletions() {
  const el = document.getElementById("adminDeletions");
  if (!el) return;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/admin/deletions`, { headers: adminHeaders() });
    if (!res.ok) throw new Error(res.status);
    const entries = await res.json();
    if (entries.length === 0) {
      el.innerHTML = '<p class="admin-deletions-empty">Inget har tagits bort \u00e4n.</p>';
      return;
    }
    const rows = entries
      .map((e) => {
        const at = new Date(e.at).toLocaleString("sv-SE", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        const what = e.what === "match"
          ? `Match${e.clips ? ` och ${e.clips} klipp` : ""}`
          : "Klipp";
        return `
        <li>
          <span class="admin-deletion-at">${escapeHtml(at)}</span>
          <span>${escapeHtml(what)}${e.match ? ` \u00b7 ${escapeHtml(e.match)}` : ""}</span>
          ${e.onRequest ? '<span class="admin-deletion-request">p\u00e5 beg\u00e4ran</span>' : ""}
        </li>`;
      })
      .join("");
    el.innerHTML = `
      <details class="admin-deletions">
        <summary>${entries.length} borttagningar</summary>
        <ul>${rows}</ul>
      </details>`;
  } catch {
    el.innerHTML = '<p class="admin-deletions-empty">Kunde inte l\u00e4sa raderingsloggen.</p>';
  }
}

/** Two-click delete of whatever `path` names, then fade out `item`. */
async function handleDelete(btn, path, item) {

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
    const onRequest = document.getElementById("adminOnRequest")?.checked;
    const res = await fetch(`${CONFIG.API_URL}${path}${onRequest ? "?onRequest=1" : ""}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });

    if (res.status === 401) {
      deactivateAdmin();
      return;
    }

    if (res.ok || res.status === 204) {
      // Remove item from DOM with animation
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

  dom.adminView.querySelectorAll("[data-admin-open]").forEach((btn) => {
    btn.addEventListener("click", () => showAdminPage(btn.dataset.adminOpen));
  });
  dom.adminView.querySelectorAll("[data-admin-back]").forEach((btn) => {
    btn.addEventListener("click", () => showAdminPage("overview"));
  });
}

/**
 * Initialise the admin module.
 * @param {Object} callbacks
 * @param {Function} callbacks.onSwitchTab - called to switch to a tab (e.g. "admin" or "live")
 */
export function initAdmin(callbacks) {
  onSwitchTab = callbacks.onSwitchTab;
  bindAdminEvents();

  const pairBtn = document.getElementById("adminPairBtn");
  if (pairBtn) pairBtn.addEventListener("click", () => startPairing());
}
