// === Club look, from the admin view ===
//
// Name, tagline, accent colour and logo. Saved in the club's own storage and
// served back through /api/club, so a change shows at once for every viewer
// without touching the OSC configuration.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { club, applyTheme, applyAccent } from "./club.js";
import { escapeHtml } from "./utils.js";
import { deactivateAdmin } from "./admin.js";
import { initPrivacy } from "./privacy.js";

/** Logos are scaled down to this before upload — plenty for a header and an icon. */
const LOGO_MAX_PX = 512;

function adminHeaders() {
  return { "X-Admin-Token": state.adminToken, "Content-Type": "application/json" };
}

export function renderBranding() {
  const el = document.getElementById("adminBranding");
  if (!el) return;

  el.innerHTML = `
    <div class="branding-logo-row">
      <img class="branding-logo" id="brandingLogoPreview" src="${escapeHtml(currentLogo())}" alt="">
      <div class="branding-logo-actions">
        <button type="button" class="admin-pair-btn branding-upload" id="brandingLogoPick">Byt logotyp</button>
        <input type="file" id="brandingLogoInput" accept="image/*" class="visually-hidden-file">
        ${club.logoUrl.startsWith("/api/club/logo") ? '<button class="branding-link" id="brandingLogoRemove">Ta bort logotyp</button>' : ""}
        <span class="branding-status" id="brandingLogoStatus" role="status"></span>
      </div>
    </div>
    <label class="branding-field">Namn
      <input type="text" id="brandingName" maxlength="60" value="${escapeHtml(club.name)}">
    </label>
    <label class="branding-field">Kort beskrivning (visas när någon delar en länk)
      <input type="text" id="brandingTagline" maxlength="140" value="${escapeHtml(club.tagline)}">
    </label>
    <label class="branding-field branding-colour">Färg
      <input type="color" id="brandingColour" value="${escapeHtml(club.accentColor || "#C8A43F")}">
      <span class="branding-contrast" id="brandingContrast"></span>
    </label>
    <div class="branding-save-row">
      <button class="admin-pair-btn" id="brandingSave">Spara</button>
      <span class="branding-status" id="brandingStatus" role="status"></span>
    </div>`;

  const colour = document.getElementById("brandingColour");
  colour.addEventListener("input", () => {
    applyAccent(colour.value);
    showContrast(colour.value);
  });
  showContrast(colour.value);

  document.getElementById("brandingSave").addEventListener("click", save);
  // Safari greys out "Open" in the file dialog when accept lists exact MIME
  // types, and is unreliable with a display:none input, so the input is
  // visually hidden instead and opened from a button.
  const input = document.getElementById("brandingLogoInput");
  document.getElementById("brandingLogoPick").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) uploadLogo(file);
  });
  document.getElementById("brandingLogoRemove")?.addEventListener("click", removeLogo);
}

/** Who answers for the recordings, shown to viewers under "Om inspelningarna". */
export function renderPrivacyAdmin() {
  const el = document.getElementById("adminPrivacy");
  if (!el) return;
  const p = club.privacy || {};
  el.innerHTML = `
    <p class="privacy-admin-intro">Föreningen ansvarar för det som spelas in. Tittarna ser de här uppgifterna under <a href="#" data-privacy-open>Om inspelningarna</a>, längst ner på sidan och vid tittarkoden. Texter till föräldrar och motståndarlag, och en skylt till hallen, finns på <a href="https://courtside.apps.osaas.io/gdpr/" target="_blank" rel="noopener">courtside.apps.osaas.io/gdpr</a>.</p>
    <label class="branding-field">Ansvarig förening
      <input type="text" id="privacyController" maxlength="100" placeholder="${escapeHtml(club.shortName || club.name)}" value="${escapeHtml(p.controller || "")}">
    </label>
    <label class="branding-field">E-post för frågor om inspelningarna
      <input type="email" id="privacyContact" maxlength="120" placeholder="t.ex. styrelsen@forening.se" value="${escapeHtml(p.contact || "")}">
    </label>
    <label class="branding-field">Länk till föreningens integritetspolicy (valfri)
      <input type="url" id="privacyPolicy" maxlength="300" placeholder="https://" value="${escapeHtml(p.policyUrl || "")}">
    </label>
    <div class="branding-save-row">
      <button class="admin-pair-btn" id="privacySave">Spara</button>
      <span class="branding-status" id="privacyStatus" role="status"></span>
    </div>`;
  initPrivacy();
  document.getElementById("privacySave").addEventListener("click", async () => {
    setStatus("Sparar…", false, "privacyStatus");
    try {
      await send("PUT", "/api/admin/club/privacy", {
        controller: document.getElementById("privacyController").value,
        contact: document.getElementById("privacyContact").value,
        policyUrl: document.getElementById("privacyPolicy").value,
      });
      setStatus("Sparat.", false, "privacyStatus");
    } catch (err) {
      setStatus(err.message, true, "privacyStatus");
    }
  });
}

function currentLogo() {
  return club.logoUrl || document.querySelector("[data-club-logo]")?.getAttribute("src") || "";
}

// The logo has its own status line beside the button: one far below, by
// "Spara", is out of sight and a failed upload looks like nothing happened.
function setStatus(text, isError = false, id = "brandingStatus") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", isError);
}

async function send(method, path, body) {
  const res = await fetch(`${CONFIG.API_URL}${path}`, {
    method,
    headers: adminHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // The admin session has ended (expired, or the admin code was changed).
    // Say so and log out, rather than leave a view where every save fails.
    alert("Du har loggats ut från admin. Logga in igen med admin-koden.");
    deactivateAdmin();
    throw new Error(data.error || "Admin-åtkomst krävs");
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  Object.assign(club, data);
  applyTheme();
}

async function save() {
  setStatus("Sparar…");
  try {
    await send("PUT", "/api/admin/club", {
      name: document.getElementById("brandingName").value,
      tagline: document.getElementById("brandingTagline").value,
      accentColor: document.getElementById("brandingColour").value,
    });
    setStatus("Sparat. Alla tittare ser ändringen direkt.");
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function uploadLogo(file) {
  setStatus("Laddar upp…", false, "brandingLogoStatus");
  try {
    await send("PUT", "/api/admin/club/logo", { dataUrl: await resize(file) });
    renderBranding();
    setStatus("Logotypen är bytt.", false, "brandingLogoStatus");
  } catch (err) {
    setStatus(err.message, true, "brandingLogoStatus");
  }
}

async function removeLogo() {
  try {
    await send("DELETE", "/api/admin/club/logo");
    // The shipped placeholder is only known after a reload.
    location.reload();
  } catch (err) {
    setStatus(err.message, true, "brandingLogoStatus");
  }
}

/** Scale an image down in the browser, so a photo straight off a phone is fine to pick. */
async function resize(file) {
  const bitmap = await decode(file).catch(() => {
    throw new Error("Bilden gick inte att läsa. Välj en PNG eller JPG.");
  });
  const scale = Math.min(1, LOGO_MAX_PX / Math.max(bitmap.width || bitmap.naturalWidth, bitmap.height || bitmap.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((bitmap.width || bitmap.naturalWidth) * scale);
  canvas.height = Math.round((bitmap.height || bitmap.naturalHeight) * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/** createImageBitmap where it works, an <img> otherwise (older Safari, HEIC). */
async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- Contrast against the dark background, WCAG relative luminance ---

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function showContrast(hex) {
  const el = document.getElementById("brandingContrast");
  if (!el || !/^#[0-9a-f]{6}$/i.test(hex)) return;
  const background = luminance("#0a0a0a");
  const ratio = (luminance(hex) + 0.05) / (background + 0.05);
  el.textContent = ratio < 4.5
    ? "Mörk mot bakgrunden. Text i klubbfärgen ljusas upp automatiskt så att den syns."
    : "";
}
