// === Paired cameras ===
//
// A club pairs a phone by showing it a code. The code carries this
// installation's address as well, so one app from the App Store can be pointed
// at any club without being rebuilt — which is what lets a club run the system
// without Xcode and an Apple Developer account.

import QRCode from "qrcode";
import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml, formatDate } from "./utils.js";
import { loadInvites } from "./invites.js";

function adminHeaders() {
  return { "X-Admin-Token": state.adminToken };
}

/**
 * Where a phone without the camera app learns how to get it. A page on the
 * landing site rather than a TestFlight or App Store link, so moving the app
 * from TestFlight to the App Store changes one page, not every installation.
 */
export const APP_INSTALL_URL = "https://courtside.apps.osaas.io/app/";

/** Countdown timer for the visible pairing code. */
let expiryTimer = null;

/** The cameras that are paired and not removed. Throws if they cannot be fetched. */
export async function fetchActiveDevices() {
  const res = await fetch(`${CONFIG.API_URL}/api/devices`, { headers: adminHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const devices = await res.json();
  return devices.filter((d) => !d.revokedAt);
}

/** A new pairing code: { code, expiresAt, apiUrl, payload }. Throws on failure. */
export async function requestPairingCode() {
  const res = await fetch(`${CONFIG.API_URL}/api/devices/pairing-code`, {
    method: "POST",
    headers: adminHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** A QR code as SVG, dark on white so it scans against the dark theme. */
export function qrSvg(text) {
  return QRCode.toString(text, {
    type: "svg",
    margin: 1,
    color: { dark: "#0a0a0a", light: "#ffffff" },
  });
}

/**
 * Draw the camera list. Returns the active cameras, or null when they could
 * not be fetched — so the caller can tell "no camera" from "don't know".
 */
export async function loadDevices() {
  const list = document.getElementById("adminDeviceList");
  if (!list) return null;

  try {
    const active = await fetchActiveDevices();
    renderDevices(active);
    loadInvites(active);
    return active;
  } catch (err) {
    list.innerHTML = `<p class="admin-empty">Kunde inte hämta kameror (${escapeHtml(err.message)})</p>`;
    return null;
  }
}

function renderDevices(active) {
  const list = document.getElementById("adminDeviceList");

  const sub = document.getElementById("adminRowCameraSub");
  if (sub) sub.textContent = active.length === 0 ? "Ingen kamera parad ännu" : `${active.length} parad${active.length === 1 ? "" : "e"}`;

  if (active.length === 0) {
    list.innerHTML = `<p class="admin-empty">Ingen kamera är parad ännu.</p>`;
    return;
  }

  list.innerHTML = active
    .map(
      (d) => `
      <div class="device-row">
        <div class="device-info">
          <span class="device-name">${escapeHtml(d.name)}</span>
          <span class="device-meta">${d.inviteId ? "Via inbjudan · " : ""}${
            d.appVersion ? `App ${escapeHtml(d.appVersion)}` : "App 1.0"
          } · parad ${formatDate(d.createdAt.slice(0, 10))}${
            d.lastSeenAt ? ` · senast aktiv ${formatDate(d.lastSeenAt.slice(0, 10))}` : ""
          }</span>
        </div>
        <div class="device-buttons">
          <button class="device-revoke device-rename" data-rename="${escapeHtml(d.id)}">Byt namn</button>
          <button class="device-revoke" data-device="${escapeHtml(d.id)}">Ta bort</button>
        </div>
      </div>`
    )
    .join("");

  list.querySelectorAll("[data-device]").forEach((btn) => {
    btn.addEventListener("click", () => revokeDevice(btn));
  });
  list.querySelectorAll("[data-rename]").forEach((btn) => {
    const device = active.find((d) => d.id === btn.dataset.rename);
    btn.addEventListener("click", () => startRename(btn.closest(".device-row"), device));
  });
}

/** Swap the camera's name for a field, in place. */
function startRename(row, device) {
  if (!row || !device) return;
  row.innerHTML = `
    <form class="device-rename-form">
      <input class="invite-input" type="text" maxlength="60" value="${escapeHtml(device.name)}"
        aria-label="Nytt namn för ${escapeHtml(device.name)}" required>
      <div class="device-buttons">
        <button type="button" class="device-revoke" data-cancel>Avbryt</button>
        <button type="submit" class="device-revoke device-save">Spara</button>
      </div>
    </form>`;
  const form = row.querySelector("form");
  const input = form.querySelector("input");
  input.focus();
  input.select();
  form.querySelector("[data-cancel]").addEventListener("click", () => loadDevices());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return input.focus();
    const save = form.querySelector(".device-save");
    save.disabled = true;
    try {
      const res = await fetch(`${CONFIG.API_URL}/api/devices/${encodeURIComponent(device.id)}`, {
        method: "PATCH",
        headers: { ...adminHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadDevices();
    } catch {
      save.disabled = false;
      save.textContent = "Gick inte";
    }
  });
}

/** Two clicks to revoke — the same confirm pattern as deleting a recording. */
async function revokeDevice(btn) {
  const id = btn.dataset.device;
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.textContent = "Säker?";
    setTimeout(() => {
      if (btn.dataset.confirm === "1") {
        btn.dataset.confirm = "";
        btn.textContent = "Ta bort";
      }
    }, 4000);
    return;
  }

  btn.disabled = true;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/devices/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
    await loadDevices();
  } catch {
    btn.disabled = false;
    btn.textContent = "Gick inte";
  }
}

export async function startPairing() {
  const panel = document.getElementById("adminPairPanel");
  const btn = document.getElementById("adminPairBtn");
  if (!panel) return;

  btn.disabled = true;
  document.getElementById("adminInvitePanel")?.classList.add("hidden");
  panel.classList.remove("hidden");
  panel.innerHTML = `<p class="admin-empty">Hämtar kod…</p>`;

  try {
    const data = await requestPairingCode();
    const svg = await qrSvg(data.payload);
    const appSvg = await qrSvg(APP_INSTALL_URL);

    panel.innerHTML = `
      <details class="pair-get-app">
        <summary>Har telefonen inte kameraappen än?</summary>
        <p class="pair-instructions">Skanna med telefonens kamera, eller gå till
          <a href="${APP_INSTALL_URL}" target="_blank" rel="noopener">courtside.apps.osaas.io/app</a>
          på telefonen. Där står hur du installerar appen. Kom sedan tillbaka hit.</p>
        <div class="pair-qr pair-qr-small">${appSvg}</div>
      </details>
      <p class="pair-instructions">Skanna koden med telefonens kamera, eller i kameraappen.</p>
      <div class="pair-qr">${svg}</div>
      <p class="pair-code-label">Eller skriv in manuellt:</p>
      <p class="pair-code">${escapeHtml(data.code)}</p>
      <p class="pair-url">${escapeHtml(data.apiUrl)}</p>
      <p class="pair-expiry" id="pairExpiry"></p>`;

    startExpiryCountdown(new Date(data.expiresAt).getTime(), btn, panel);
    // A camera that pairs shows up in the list; refresh while the code is open.
    pollForNewDevice();
  } catch (err) {
    panel.innerHTML = `<p class="admin-empty">Kunde inte hämta kod (${escapeHtml(err.message)})</p>`;
    btn.disabled = false;
  }
}

function startExpiryCountdown(expiresAt, btn, panel) {
  clearInterval(expiryTimer);
  const el = () => document.getElementById("pairExpiry");

  const tick = () => {
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    const node = el();
    if (!node) return clearInterval(expiryTimer);
    if (left === 0) {
      clearInterval(expiryTimer);
      panel.innerHTML = `<p class="admin-empty">Koden gick ut. Skapa en ny.</p>`;
      btn.disabled = false;
      return;
    }
    node.textContent = `Koden gäller i ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  };

  tick();
  expiryTimer = setInterval(tick, 1000);
}

/** Refresh the camera list a few times so a successful pairing shows up. */
function pollForNewDevice() {
  let rounds = 0;
  const timer = setInterval(async () => {
    rounds++;
    await loadDevices();
    if (rounds >= 20) clearInterval(timer);
  }, 3000);
}
