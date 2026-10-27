// === Remove the whole platform, from the admin view ===
//
// Deletes every recording, setting and code, every OSC instance this
// installation runs on, the site itself and its access to the OSC account.
// The admin types the club's short name to confirm. When it is done the site
// no longer exists, so the result is shown in place of the page.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";

function headers() {
  return { "X-Admin-Token": state.adminToken, "Content-Type": "application/json" };
}

export async function renderTeardown() {
  const el = document.getElementById("adminTeardown");
  if (!el) return;
  el.innerHTML = '<p class="teardown-text">Kontrollerar…</p>';

  let info;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/admin/platform`, { headers: headers() });
    info = await res.json();
  } catch {
    info = { removable: false, reason: "Kunde inte nå servern." };
  }
  if (!info.removable) {
    el.innerHTML = `<p class="teardown-text">${escapeHtml(info.reason || "Går inte att ta bort härifrån.")}</p>`;
    return;
  }

  el.innerHTML = `
    <p class="teardown-text">Tar bort hela er Courtside från Open Source Cloud: alla inspelningar och highlights,
      logotyp och inställningar, admin- och tittarkoder, kopplade kameror, sändningsmotorn
      (${escapeHtml(info.restreamer)}), lagringen (${escapeHtml(info.storage)}), inställningarna och lösenorden
      (${escapeHtml(info.store)}) och själva webbplatsen (${escapeHtml(info.app)}). Det går inte att ångra.</p>
    <label class="branding-field">Skriv <b>${escapeHtml(info.club)}</b> för att bekräfta
      <input type="text" id="teardownConfirm" autocomplete="off" autocapitalize="off" spellcheck="false">
    </label>
    <div class="branding-save-row">
      <button class="teardown-btn" id="teardownBtn" disabled>Ta bort allt permanent</button>
      <span class="branding-status" id="teardownStatus" role="status"></span>
    </div>`;

  const input = document.getElementById("teardownConfirm");
  const btn = document.getElementById("teardownBtn");
  input.addEventListener("input", () => { btn.disabled = input.value.trim() !== info.club; });
  btn.addEventListener("click", () => remove(info.club, input.value.trim()));
}

async function remove(club, confirm) {
  if (!window.confirm(`Sista chansen: allt i ${club} raderas permanent. Fortsätta?`)) return;
  const btn = document.getElementById("teardownBtn");
  const status = document.getElementById("teardownStatus");
  btn.disabled = true;
  status.classList.remove("error");
  status.textContent = "Tar bort… det kan ta en minut.";
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
      <h1>${failed.length ? "Nästan allt är borttaget" : "Er Courtside är borttagen"}</h1>
      <p>${escapeHtml(club)} är borttagen från ert Open Source Cloud-konto tillsammans med all data:
        alla inspelningar och highlights, logotypen, inställningarna, admin- och tittarkoderna,
        alla lösenord och nycklar och kopplingarna till kamerorna. Webbplatsen slutar svara inom någon minut.</p>
      <ul>${rows}</ul>
      <p id="teardownSite" role="status">Väntar på att webbplatsen ska stängas…</p>
      ${failed.length ? "<p>Det som inte gick att ta bort kan du ta bort själv i Open Source Cloud under My Apps och Services.</p>" : ""}
      <p>Ert OSC-konto finns kvar. Vill ni börja om kan ni skapa en ny Courtside på
        <a href="https://courtside.apps.osaas.io/">courtside.apps.osaas.io</a>. Kameraappen kan kopplas bort under kugghjulet.</p>
    </main>`;
  watchSiteGo(removed);
}

/** The site removes itself after answering; tell the admin once it has. */
function watchSiteGo(removed) {
  const app = removed.find((r) => r.what.startsWith("Webbplatsen"))?.what.match(/\((.+)\)/)?.[1] || "appen";
  const el = document.getElementById("teardownSite");
  const deadline = Date.now() + 3 * 60_000;
  const check = async () => {
    const up = await fetch(`${CONFIG.API_URL}/health`, { cache: "no-store" }).then((r) => r.ok).catch(() => false);
    if (!up) { el.textContent = "✓ Webbplatsen är avstängd och borttagen."; return; }
    if (Date.now() > deadline) {
      el.textContent = `Webbplatsen svarar fortfarande. Ta bort ${app} i Open Source Cloud under My Apps.`;
      el.classList.add("bad");
      return;
    }
    setTimeout(check, 5000);
  };
  setTimeout(check, 5000);
}
