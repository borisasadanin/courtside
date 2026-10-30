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
    el.innerHTML = '<p class="teardown-text">Kunde inte läsa koderna.</p>';
    return;
  }

  const current = info.viewerPin
    ? `Tittarkoden är <b class="pins-current">${escapeHtml(info.viewerPin)}</b>.`
    : "Ingen tittarkod: alla med adressen kan titta.";
  if (!info.changeable) {
    el.innerHTML = `<p class="teardown-text">${current} ${escapeHtml(info.reason || "")}</p>`;
    return;
  }

  el.innerHTML = `
    <p class="teardown-text">${current} Glömda koder går inte att läsa ut, men ni kan sätta nya här.
      De gamla slutar gälla direkt.</p>
    <label class="branding-field">Ny tittarkod (4–8 siffror)
      <input type="tel" id="pinsViewer" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off">
    </label>
    <div class="branding-save-row">
      <button class="admin-pair-btn" id="pinsViewerSave">Byt tittarkod</button>
      ${info.viewerPin ? '<button class="branding-link" id="pinsViewerRemove" type="button">Ta bort tittarkoden</button>' : ""}
      <span class="branding-status" id="pinsViewerStatus" role="status"></span>
    </div>
    <label class="branding-field pins-admin">Nuvarande admin-kod
      <input type="password" id="pinsAdminCurrent" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="current-password">
    </label>
    <label class="branding-field">Ny admin-kod (6–8 siffror)
      <input type="tel" id="pinsAdmin" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off">
    </label>
    <div class="branding-save-row">
      <button class="admin-pair-btn" id="pinsAdminSave">Byt admin-kod</button>
      <span class="branding-status" id="pinsAdminStatus" role="status"></span>
    </div>`;

  document.getElementById("pinsViewerSave").addEventListener("click", () => {
    const viewerPin = document.getElementById("pinsViewer").value.trim();
    if (!viewerPin) return say("pinsViewerStatus", "Skriv en ny tittarkod.", true);
    save({ viewerPin }, "pinsViewerStatus", "Tittarkoden är bytt. Tittarna behöver ange den nya koden.");
  });
  document.getElementById("pinsViewerRemove")?.addEventListener("click", () => {
    if (!window.confirm("Utan tittarkod kan alla som har adressen se era matcher. Det är oftast barn på filmen. Ta bara bort koden om föräldrarna vet om det och ni har stöd för att visa matcherna öppet. Ta bort koden?")) return;
    save({ viewerPin: "", openAccess: true }, "pinsViewerStatus", "Tittarkoden är borttagen. Alla med adressen kan titta.");
  });
  document.getElementById("pinsAdminSave").addEventListener("click", () => {
    const currentAdminPin = document.getElementById("pinsAdminCurrent").value.trim();
    const adminPin = document.getElementById("pinsAdmin").value.trim();
    if (!currentAdminPin || !adminPin) return say("pinsAdminStatus", "Fyll i både nuvarande och ny admin-kod.", true);
    save({ currentAdminPin, adminPin }, "pinsAdminStatus", "Admin-koden är bytt.");
  });
}

function say(id, text, error = false) {
  const status = document.getElementById(id);
  status.textContent = text;
  status.classList.toggle("error", error);
}

async function save(body, statusId, done) {
  say(statusId, "Sparar…");
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/admin/pins`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (res.status === 401) return deactivateAdmin();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return say(statusId, data.error || `Det gick inte (HTTP ${res.status}).`, true);

    // The old sessions died with the old codes; keep this browser signed in.
    state.viewerToken = data.token;
    state.adminToken = data.adminToken;
    localStorage.setItem("viewerToken", data.token);
    localStorage.setItem("adminToken", data.adminToken);
    await renderPins();
    say(statusId, done);
  } catch {
    say(statusId, "Kunde inte nå servern. Försök igen.", true);
  }
}
