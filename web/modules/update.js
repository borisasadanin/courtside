// === Courtside version and updates, from the admin view ===
//
// Shows the release this platform runs and, when a newer one is out, offers
// to update to it. The server is rebuilt from the new release, so the site is
// gone for a few minutes; the page waits for it and reloads once it is back
// on the new version.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { deactivateAdmin } from "./admin.js";
import { t } from "./i18n.js";

function headers() {
  return { "X-Admin-Token": state.adminToken };
}

/** The version the running server reports, without the leading v. */
async function runningVersion() {
  const health = await fetch(`${CONFIG.API_URL}/health`, { cache: "no-store" }).then((r) => r.json());
  return health.version && health.version !== "unknown" ? health.version : undefined;
}

export async function renderUpdate() {
  const el = document.getElementById("adminUpdate");
  if (!el) return;
  el.innerHTML = `<p class="teardown-text">${t("update.checking")}</p>`;

  let info = {};
  let running;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/admin/update`, { headers: headers() });
    if (res.status === 401) return deactivateAdmin();
    [info, running] = await Promise.all([res.json(), runningVersion().catch(() => undefined)]);
  } catch {
    info = { reason: t("update.serverError") };
  }

  const version = running ? `v${running}` : info.current;
  const now = version ? t("update.running", { version: escapeHtml(version) }) : "";
  const changelog = info.changelogUrl
    ? ` <a class="update-link" href="${escapeHtml(info.changelogUrl)}" target="_blank" rel="noopener">${t("update.whatsNew")}</a>`
    : "";

  if (!info.available) {
    const why = info.reason ? ` ${escapeHtml(info.reason)}` : version ? ` ${t("update.latest")}` : "";
    el.innerHTML = `<p class="teardown-text">${now}${why}</p>`;
    return;
  }

  el.innerHTML = `
    <p class="teardown-text">${now} ${t("update.available", { version: escapeHtml(info.available) })}${changelog}</p>
    <p class="teardown-text">${t("update.downtime")}</p>
    <div class="branding-save-row">
      <button class="admin-pair-btn" id="updateBtn">${t("update.updateTo", { version: escapeHtml(info.available) })}</button>
      <span class="branding-status" id="updateStatus" role="status"></span>
    </div>`;
  document.getElementById("updateBtn").addEventListener("click", () => start(info.available));
}

async function start(target) {
  const btn = document.getElementById("updateBtn");
  const status = document.getElementById("updateStatus");
  btn.disabled = true;
  status.classList.remove("error");
  status.textContent = t("update.starting");
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/admin/update`, { method: "POST", headers: headers() });
    if (res.status === 401) return deactivateAdmin();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    status.textContent = t("update.updating", { version: data.version });
    waitFor(data.version || target, status);
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("error");
    btn.disabled = false;
  }
}

/** Reloads once the server answers on the new version. */
function waitFor(target, status) {
  const want = target.replace(/^v/, "");
  const deadline = Date.now() + 20 * 60_000;
  const check = async () => {
    const v = await runningVersion().catch(() => undefined);
    if (v === want) return location.reload();
    if (Date.now() > deadline) {
      status.textContent = t("update.slow");
      status.classList.add("error");
      return;
    }
    setTimeout(check, 10_000);
  };
  setTimeout(check, 10_000);
}
