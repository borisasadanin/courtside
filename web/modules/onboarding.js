// === Camera guide ===
//
// A new installation cannot broadcast until a phone is paired, and the people
// who set one up are team managers and parents, not technicians. So when an
// admin reaches Hantera and no camera is paired, a guide opens on top of it and
// walks them through it: what is needed, getting the app through TestFlight,
// pairing, and done. Admin only — viewers never see it.
//
// Many admins have Hantera open on the very iPhone that is going to film, where
// a QR code on the screen cannot be scanned. There the guide shows buttons
// instead: one to the install page, one that opens the camera app paired.

import {
  APP_INSTALL_URL,
  fetchActiveDevices,
  loadDevices,
  qrSvg,
  requestPairingCode,
} from "./devices.js";
import { escapeHtml } from "./utils.js";

/** Set when the admin chose "later": not again until they log in anew. */
const DISMISS_KEY = "cameraGuideDismissed";

const STEPS = ["welcome", "app", "pair", "done"];

/** How often to look for the new camera while the pairing code shows (ms). */
const POLL_MS = 3000;

let dialog = null;
let step = "welcome";
/** "phone": this is the iPhone that will film. "qr": another screen. */
let mode = /iPhone/.test(navigator.userAgent) ? "phone" : "qr";
/** Cameras that were paired before the guide began, so a new one stands out. */
let knownIds = new Set();
let newCameraName = "";
let pollTimer = null;
let expiryTimer = null;

function dismissed() {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function setDismissed(on) {
  try {
    if (on) sessionStorage.setItem(DISMISS_KEY, "1");
    else sessionStorage.removeItem(DISMISS_KEY);
  } catch {}
}

/** Called on logout: the next login asks again if there is still no camera. */
export function resetCameraGuide() {
  setDismissed(false);
  if (dialog?.open) closeGuide();
}

/**
 * Called each time Hantera has loaded its cameras. `active` is null when they
 * could not be fetched — then nothing is known, and nothing is shown.
 */
export function maybeShowCameraGuide(active) {
  if (!Array.isArray(active) || active.length > 0) return;
  if (dismissed() || dialog?.open) return;
  openCameraGuide();
}

/** Open the guide from the start, as the Kameror page's "Visa guiden" does. */
export function openCameraGuide() {
  ensureDialog();
  step = "welcome";
  render();
  if (!dialog.open) dialog.showModal();
}

// ============================
// Dialog shell
// ============================

function ensureDialog() {
  if (dialog) return;
  dialog = document.createElement("dialog");
  dialog.className = "guide";
  dialog.setAttribute("aria-labelledby", "guideTitle");
  document.body.appendChild(dialog);

  // Esc closes like "later": the admin chose not to do it now.
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    later();
  });
  dialog.addEventListener("click", (e) => {
    const action = e.target.closest("[data-guide]")?.dataset.guide;
    if (action) handle(action);
  });
}

function handle(action) {
  switch (action) {
    case "later":
      return later();
    case "start":
      return go("app");
    case "installed":
      return go("pair");
    case "back":
      return go(STEPS[Math.max(0, STEPS.indexOf(step) - 1)]);
    case "mode":
      mode = mode === "phone" ? "qr" : "phone";
      return go(step);
    case "finish":
      return closeGuide();
  }
}

function later() {
  // Closing after the camera is paired is just "done".
  if (step !== "done") setDismissed(true);
  closeGuide();
}

function closeGuide() {
  stopPairing();
  if (dialog?.open) dialog.close();
  loadDevices();
}

function go(next) {
  stopPairing();
  step = next;
  render();
}

// ============================
// Steps
// ============================

function render() {
  const n = STEPS.indexOf(step) + 1;
  const dots = STEPS.map(
    (s, i) => `<span class="guide-dot${i < n ? " on" : ""}"></span>`
  ).join("");

  dialog.innerHTML = `
    <div class="guide-top">
      <div class="guide-progress" aria-label="Steg ${n} av ${STEPS.length}">
        <span class="guide-step-label">Steg ${n} av ${STEPS.length}</span>
        <span class="guide-dots" aria-hidden="true">${dots}</span>
      </div>
      <button type="button" class="guide-close" data-guide="later" aria-label="Stäng">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="guide-body">${STEP_HTML[step]()}</div>`;

  // Focus the main action, so Enter moves on and a screen reader starts here.
  dialog.querySelector(".guide-primary")?.focus();
  dialog.querySelector(".guide-body").scrollTop = 0;

  if (step === "app" && mode === "qr") drawQr("guideAppQr", APP_INSTALL_URL);
  if (step === "pair") startPairing();
}

const modeSwitch = () =>
  mode === "qr"
    ? `<button type="button" class="guide-link" data-guide="mode">Har du guiden öppen på iPhonen som ska filma? Tryck här.</button>`
    : `<button type="button" class="guide-link" data-guide="mode">Ska en annan telefon filma? Visa koder att skanna i stället.</button>`;

const STEP_HTML = {
  welcome: () => `
    <div class="guide-hero" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
    </div>
    <h2 class="guide-title" id="guideTitle">Nu kopplar vi er första kamera</h2>
    <p class="guide-text">Kameran är en vanlig iPhone med vår kameraapp. När den är kopplad kan ni sända matcher direkt härifrån.</p>
    <p class="guide-text">Det tar ungefär fem minuter. Vi visar varje steg.</p>
    <div class="guide-needs">
      <p class="guide-needs-title">Det här behöver du</p>
      <ul>
        <li>iPhonen som ska filma matcherna (iOS 16 eller senare)</li>
        <li>Ditt Apple-ID på den iPhonen, för att hämta appar</li>
      </ul>
    </div>
    <div class="guide-actions">
      <button type="button" class="guide-primary" data-guide="start">Sätt igång</button>
      <button type="button" class="guide-secondary" data-guide="later">Gör det senare</button>
    </div>`,

  app: () => `
    <h2 class="guide-title" id="guideTitle">Hämta kameraappen</h2>
    ${
      mode === "qr"
        ? `<p class="guide-text">Ta fram iPhonen som ska filma. Öppna kameran och rikta den mot koden. Tryck på länken som dyker upp.</p>
           <div class="pair-qr guide-qr" id="guideAppQr"><div class="spinner"></div></div>`
        : `<p class="guide-text">Tryck på knappen. En sida öppnas med knappar för allt du behöver göra.</p>
           <p class="guide-center"><a class="guide-primary guide-link-btn" href="${APP_INSTALL_URL}" target="_blank" rel="noopener">Öppna sidan för kameraappen</a></p>`
    }
    <p class="guide-needs-title">Sedan gör du så här på iPhonen</p>
    <ol class="guide-list">
      <li><strong>Hämta TestFlight</strong> från App Store. Det är Apples egen, gratis app för nya appar. Kameraappen finns där tills vidare.</li>
      <li><strong>Öppna inbjudan</strong> med knappen på sidan och tryck <em>Acceptera</em>.</li>
      <li><strong>Tryck <em>Installera</em></strong> vid <em>Sports Camera – Eyevinn</em>.</li>
    </ol>
    <p class="guide-hint">Har iPhonen redan appen? Gå bara vidare.</p>
    <div class="guide-actions">
      <button type="button" class="guide-primary" data-guide="installed">Appen är installerad</button>
      <button type="button" class="guide-secondary" data-guide="back">Tillbaka</button>
    </div>
    ${modeSwitch()}`,

  pair: () => `
    <h2 class="guide-title" id="guideTitle">Koppla iPhonen hit</h2>
    ${
      mode === "qr"
        ? `<p class="guide-text">Öppna kameraappen på iPhonen. Skanna koden med appen eller med iPhonens vanliga kamera.</p>
           <div class="pair-qr guide-qr" id="guidePairQr"><div class="spinner"></div></div>`
        : `<p class="guide-text">Tryck på knappen. Kameraappen öppnas och kopplas till er Courtside av sig själv.</p>
           <p class="guide-center"><a class="guide-primary guide-link-btn" id="guidePairLink" aria-disabled="true">Koppla den här iPhonen</a></p>`
    }
    <p class="guide-wait" role="status"><span class="guide-pulse" aria-hidden="true"></span><span id="guidePairStatus">Hämtar kod…</span></p>
    <details class="guide-manual">
      <summary>Går det inte? Skriv in koden för hand</summary>
      <p class="guide-text">Tryck <em>Skriv in koden manuellt</em> i appen, fyll i det här och tryck <em>Anslut</em>.</p>
      <p class="pair-code-label">Klubbens adress</p>
      <p class="pair-url" id="guidePairUrl">…</p>
      <p class="pair-code-label">Parningskod</p>
      <p class="pair-code" id="guidePairCode">…</p>
    </details>
    <div class="guide-actions">
      <button type="button" class="guide-secondary" data-guide="back">Tillbaka</button>
    </div>
    ${modeSwitch()}`,

  done: () => `
    <div class="guide-hero guide-hero-ok" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <h2 class="guide-title" id="guideTitle">Klart! Kameran är kopplad</h2>
    <p class="guide-text"><strong>${escapeHtml(newCameraName || "iPhonen")}</strong> hör nu till er Courtside.</p>
    <p class="guide-needs-title">Så sänder ni en match</p>
    <ol class="guide-list">
      <li>Ställ iPhonen så att den ser hela planen, gärna på ett stativ.</li>
      <li>Öppna kameraappen och tryck <em>Starta sändningsmotor</em>. Det tar 1–3 minuter.</li>
      <li>Tryck <em>Starta sändning</em> och sedan <em>GO LIVE</em>.</li>
    </ol>
    <p class="guide-text">Matchen syns då under <em>Live</em> för alla som har adressen och tittarkoden.</p>
    <div class="guide-actions">
      <button type="button" class="guide-primary" data-guide="finish">Klar</button>
    </div>`,
};

async function drawQr(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  try {
    el.innerHTML = await qrSvg(text);
  } catch {
    el.innerHTML = `<p class="admin-empty">Kunde inte visa koden</p>`;
  }
}

// ============================
// Pairing: code, countdown, waiting for the camera
// ============================

async function startPairing() {
  const status = (text) => {
    const el = document.getElementById("guidePairStatus");
    if (el) el.textContent = text;
  };

  try {
    // Remember who was here before, so only the new phone counts.
    knownIds = new Set((await fetchActiveDevices()).map((d) => d.id));
    const data = await requestPairingCode();
    if (step !== "pair") return; // left the step while waiting

    if (mode === "qr") {
      await drawQr("guidePairQr", data.payload);
    } else {
      const link = document.getElementById("guidePairLink");
      if (link) {
        link.href = data.payload;
        link.removeAttribute("aria-disabled");
      }
    }
    document.getElementById("guidePairCode").textContent = data.code;
    document.getElementById("guidePairUrl").textContent = data.apiUrl;

    const expiresAt = new Date(data.expiresAt).getTime();
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      if (left === 0) {
        // An expired code is no use to anyone: fetch a fresh one quietly.
        stopPairing();
        if (step === "pair") render();
        return;
      }
      status(`Väntar på iPhonen… Koden gäller ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} till.`);
    };
    tick();
    expiryTimer = setInterval(tick, 1000);
    pollTimer = setInterval(checkForNewCamera, POLL_MS);
  } catch {
    status("Kunde inte hämta någon kod. Kontrollera internet och tryck Tillbaka, och sedan Appen är installerad igen.");
  }
}

async function checkForNewCamera() {
  try {
    const fresh = (await fetchActiveDevices()).find((d) => !knownIds.has(d.id));
    if (!fresh || step !== "pair") return;
    newCameraName = fresh.name;
    go("done");
    loadDevices();
  } catch {
    // Try again on the next round.
  }
}

function stopPairing() {
  clearInterval(pollTimer);
  clearInterval(expiryTimer);
  pollTimer = null;
  expiryTimer = null;
}
