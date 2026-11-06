// === Viewer and admin codes, from the admin view ===
//
// The admin sees the viewer code, to pass it on, and can set new codes. A code
// cannot be read back once forgotten, only replaced: the admin code by whoever
// knows the current one, the viewer code by any admin. Every session is signed
// with the codes, so after a change the server hands this browser fresh ones
// and everyone else enters the new code.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { deactivateAdmin } from "./admin.js";
import { t } from "./i18n.js";

function headers() {
  return { "X-Admin-Token": state.adminToken, "Content-Type": "application/json" };
}

export async function renderPins() {
  const el = document.getElementById("adminPins");
  if (!el) return;

  let info;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/admin/pins`, { headers: headers() });
    if (res.status === 401) return deactivateAdmin();
    info = await res.json();
  } catch {
    el.innerHTML = `<p class="teardown-text">${t("pins.loadError")}</p>`;
    return;
  }

  const current = info.viewerPin
    ? t("pins.currentViewerPin", { pin: escapeHtml(info.viewerPin) })
    : t("pins.noViewerPin");
  if (!info.changeable) {
    el.innerHTML = `<p class="teardown-text">${current} ${escapeHtml(info.reason || "")}</p>`;
    return;
  }

  el.innerHTML = `
    <p class="teardown-text">${current} ${t("pins.intro")}</p>
    <label class="branding-field">${t("pins.newViewerPin")}
      <input type="tel" id="pinsViewer" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off">
    </label>
    <div class="branding-save-row">
      <button class="admin-pair-btn" id="pinsViewerSave">${t("pins.changeViewerPin")}</button>
      ${info.viewerPin ? `<button class="branding-link" id="pinsViewerRemove" type="button">${t("pins.removeViewerPin")}</button>` : ""}
      <span class="branding-status" id="pinsViewerStatus" role="status"></span>
    </div>
    <label class="branding-field pins-admin">${t("pins.currentAdminPin")}
      <input type="password" id="pinsAdminCurrent" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="current-password">
    </label>
    <label class="branding-field">${t("pins.newAdminPin")}
      <input type="tel" id="pinsAdmin" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off">
    </label>
    <div class="branding-save-row">
      <button class="admin-pair-btn" id="pinsAdminSave">${t("pins.changeAdminPin")}</button>
      <span class="branding-status" id="pinsAdminStatus" role="status"></span>
    </div>`;

  document.getElementById("pinsViewerSave").addEventListener("click", () => {
    const viewerPin = document.getElementById("pinsViewer").value.trim();
    if (!viewerPin) return say("pinsViewerStatus", t("pins.viewerPinMissing"), true);
    save({ viewerPin }, "pinsViewerStatus", t("pins.viewerPinChanged"));
  });
  document.getElementById("pinsViewerRemove")?.addEventListener("click", () => {
    if (!window.confirm(t("pins.confirmRemove"))) return;
    save({ viewerPin: "", openAccess: true }, "pinsViewerStatus", t("pins.viewerPinRemoved"));
  });
  document.getElementById("pinsAdminSave").addEventListener("click", () => {
    const currentAdminPin = document.getElementById("pinsAdminCurrent").value.trim();
    const adminPin = document.getElementById("pinsAdmin").value.trim();
    if (!currentAdminPin || !adminPin) return say("pinsAdminStatus", t("pins.adminPinsMissing"), true);
    save({ currentAdminPin, adminPin }, "pinsAdminStatus", t("pins.adminPinChanged"));
  });
}

function say(id, text, error = false) {
  const status = document.getElementById(id);
  status.textContent = text;
  status.classList.toggle("error", error);
}

async function save(body, statusId, done) {
  say(statusId, t("common.saving"));
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/admin/pins`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (res.status === 401) return deactivateAdmin();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return say(statusId, data.error || t("common.httpError", { status: res.status }), true);

    // The old sessions died with the old codes; keep this browser signed in.
    state.viewerToken = data.token;
    state.adminToken = data.adminToken;
    localStorage.setItem("viewerToken", data.token);
    localStorage.setItem("adminToken", data.adminToken);
    await renderPins();
    say(statusId, done);
  } catch {
    say(statusId, t("pins.serverError"), true);
  }
}
