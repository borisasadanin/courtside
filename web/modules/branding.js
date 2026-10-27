// === Club look, from the admin view ===
//
// Name, tagline, accent colour and logo. Saved in the club's own storage and
// served back through /api/club, so a change shows at once for every viewer
// without touching the OSC configuration.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { club, applyTheme } from "./club.js";
import { escapeHtml } from "./utils.js";

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
        <label class="admin-pair-btn branding-upload">
          Byt logotyp
          <input type="file" id="brandingLogoInput" accept="image/png,image/jpeg,image/webp" hidden>
        </label>
        ${club.logoUrl.startsWith("/api/club/logo") ? '<button class="branding-link" id="brandingLogoRemove">Ta bort logotyp</button>' : ""}
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
    document.documentElement.style.setProperty("--accent", colour.value);
    showContrast(colour.value);
  });
  showContrast(colour.value);

  document.getElementById("brandingSave").addEventListener("click", save);
  document.getElementById("brandingLogoInput").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) uploadLogo(file);
  });
  document.getElementById("brandingLogoRemove")?.addEventListener("click", removeLogo);
}

function currentLogo() {
  return club.logoUrl || document.querySelector("[data-club-logo]")?.getAttribute("src") || "";
}

function setStatus(text, isError = false) {
  const el = document.getElementById("brandingStatus");
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
  setStatus("Laddar upp…");
  try {
    await send("PUT", "/api/admin/club/logo", { dataUrl: await resize(file) });
    renderBranding();
    setStatus("Logotypen är bytt.");
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function removeLogo() {
  try {
    await send("DELETE", "/api/admin/club/logo");
    // The shipped placeholder is only known after a reload.
    location.reload();
  } catch (err) {
    setStatus(err.message, true);
  }
}

/** Scale an image down in the browser, so a photo straight off a phone is fine to pick. */
async function resize(file) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Bilden gick inte att läsa. Välj en PNG eller JPG.");
  });
  const scale = Math.min(1, LOGO_MAX_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
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
  el.textContent = ratio < 3 ? "För mörk mot bakgrunden — svår att se" : "";
}
