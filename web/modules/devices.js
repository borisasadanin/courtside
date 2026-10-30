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

function adminHeaders() {
  return { "X-Admin-Token": state.adminToken };
}

/** Countdown timer for the visible pairing code. */
let expiryTimer = null;

export async function loadDevices() {
  const list = document.getElementById("adminDeviceList");
  if (!list) return;

  try {
    const res = await fetch(`${CONFIG.API_URL}/api/devices`, { headers: adminHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderDevices(await res.json());
  } catch (err) {
    list.innerHTML = `<p class="admin-empty">Kunde inte hämta kameror (${escapeHtml(err.message)})</p>`;
  }
}

function renderDevices(devices) {
  const list = document.getElementById("adminDeviceList");
  const active = devices.filter((d) => !d.revokedAt);

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
          <span class="device-meta">Parad ${formatDate(d.createdAt.slice(0, 10))}${
            d.lastSeenAt ? ` · senast aktiv ${formatDate(d.lastSeenAt.slice(0, 10))}` : ""
          }</span>
        </div>
        <button class="device-revoke" data-device="${escapeHtml(d.id)}">Ta bort</button>
      </div>`
    )
    .join("");

  list.querySelectorAll(".device-revoke").forEach((btn) => {
    btn.addEventListener("click", () => revokeDevice(btn));
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
  panel.classList.remove("hidden");
  panel.innerHTML = `<p class="admin-empty">Hämtar kod…</p>`;

  try {
    const res = await fetch(`${CONFIG.API_URL}/api/devices/pairing-code`, {
      method: "POST",
      headers: adminHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const svg = await QRCode.toString(data.payload, {
      type: "svg",
      margin: 1,
      color: { dark: "#0a0a0a", light: "#ffffff" },
    });

    panel.innerHTML = `
      <p class="pair-instructions">Skanna koden med telefonens kamera, eller i Courtside-appen.</p>
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
