// === Remove the whole platform, from the admin view ===
//
// Deletes every recording, setting and code, every OSC instance this
// installation runs on, the site itself and its access to the OSC account.
// The admin types the club's short name to confirm. When it is done the site
// no longer exists, so the result is shown in place of the page.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { t } from "./i18n.js";

function headers() {
  return { "X-Admin-Token": state.adminToken, "Content-Type": "application/json" };
}

export async function renderTeardown() {
  const el = document.getElementById("adminTeardown");
  if (!el) return;
  el.innerHTML = `<p class="teardown-text">${t("teardown.checking")}</p>`;

  let info;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/admin/platform`, { headers: headers() });
    info = await res.json();
  } catch {
    info = { removable: false, reason: t("teardown.serverError") };
  }
  if (!info.removable) {
    el.innerHTML = `<p class="teardown-text">${escapeHtml(info.reason || t("teardown.notRemovable"))}</p>`;
    return;
  }

  el.innerHTML = `
    <p class="teardown-text">${t("teardown.intro", {
      restreamer: escapeHtml(info.restreamer),
      storage: escapeHtml(info.storage),
      store: escapeHtml(info.store),
      app: escapeHtml(info.app),
    })}</p>
    <label class="branding-field">${t("teardown.confirmLabel", { club: escapeHtml(info.club) })}
      <input type="text" id="teardownConfirm" autocomplete="off" autocapitalize="off" spellcheck="false">
    </label>
    <div class="branding-save-row">
      <button class="teardown-btn" id="teardownBtn" disabled>${t("teardown.removeButton")}</button>
      <span class="branding-status" id="teardownStatus" role="status"></span>
    </div>`;

  const input = document.getElementById("teardownConfirm");
  const btn = document.getElementById("teardownBtn");
  input.addEventListener("input", () => { btn.disabled = input.value.trim() !== info.club; });
  btn.addEventListener("click", () => remove(info.club, input.value.trim()));
}

async function remove(club, confirm) {
  if (!window.confirm(t("teardown.lastChance", { club }))) return;
  const btn = document.getElementById("teardownBtn");
  const status = document.getElementById("teardownStatus");
  btn.disabled = true;
  status.classList.remove("error");
  status.textContent = t("teardown.removing");
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/admin/platform/delete`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ confirm }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showDone(data);
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("error");
    btn.disabled = false;
  }
}

function showDone({ club, removed }) {
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* nothing stored */ }
  const failed = removed.filter((r) => !r.ok);
  const rows = removed.map((r) =>
    `<li class="${r.ok ? "ok" : "bad"}">${r.ok ? "✓" : "✗"} ${escapeHtml(r.what)}${r.detail ? ` <small>(${escapeHtml(r.detail)})</small>` : ""}</li>`
  ).join("");
  document.body.innerHTML = `
    <main class="teardown-done">
      <h1>${failed.length ? t("teardown.doneTitlePartial") : t("teardown.doneTitle")}</h1>
      <p>${t("teardown.doneText", { club: escapeHtml(club) })}</p>
      <ul>${rows}</ul>
      <p id="teardownSite" role="status">${t("teardown.waitingForSite")}</p>
      ${failed.length ? `<p>${t("teardown.removeRestYourself")}</p>` : ""}
      <p>${t("teardown.startOver")}</p>
    </main>`;
  watchSiteGo(removed);
}

/** The site removes itself after answering; tell the admin once it has. */
function watchSiteGo(removed) {
  // The server names the website row "Webbplatsen och servern (…)"; in English
  // it starts with "Website" or "The website".
  const app = removed.find((r) => /^(Webbplatsen|(The )?website)\b/i.test(r.what))?.what.match(/\((.+)\)/)?.[1] || t("teardown.appFallback");
  const el = document.getElementById("teardownSite");
  const deadline = Date.now() + 3 * 60_000;
  const check = async () => {
    const up = await fetch(`${CONFIG.API_URL}/health`, { cache: "no-store" }).then((r) => r.ok).catch(() => false);
    if (!up) { el.textContent = t("teardown.siteGone"); return; }
    if (Date.now() > deadline) {
      el.textContent = t("teardown.siteStillUp", { app });
      el.classList.add("bad");
      return;
    }
    setTimeout(check, 5000);
  };
  setTimeout(check, 5000);
}
