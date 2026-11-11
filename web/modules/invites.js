// === Camera invites (#68) ===
//
// An admin invites someone to pair their own camera later, without standing
// next to them. The invite pairs one camera and works for three days; the
// camera takes the name the admin gives it here.
//
// It has to work from a computer as well as a phone, so the main action is
// copying a ready-made message to paste into WhatsApp, Outlook, Gmail or SMS.
// Sharing through the phone's share sheet is offered only where it exists.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { qrSvg } from "./devices.js";

function adminHeaders(json = false) {
  const headers = { "X-Admin-Token": state.adminToken };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/** "fre 14 nov kl 10:30" — the way the message and the list say when. */
export function formatWhen(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  return `${day} kl ${time}`;
}

/** The text an admin pastes into a message. Plain text, so it survives any app. */
export function inviteMessage(invite) {
  return [
    `Hej! Du är inbjuden att filma för ${invite.club} med Courtside.`,
    "",
    `1. Öppna länken på din iPhone: ${invite.link}`,
    "2. Installera appen och tryck Öppna appen. Klubbens adress fylls i av sig själv.",
    `3. Skriv in koden: ${invite.code}`,
    "",
    `Klubbens adress, om du behöver skriva in den själv: ${invite.apiUrl}`,
    `Inbjudan gäller till ${formatWhen(invite.expiresAt)} och kan bara kopplas till en kamera.`,
  ].join("\n");
}

/**
 * Copy text. The Clipboard API needs a secure page and permission; when it is
 * missing or refused, fall back to selecting a hidden textarea. Returns
 * whether the text is now on the clipboard.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the older way.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

// --- Creating an invite ---

export function openInviteForm() {
  const panel = document.getElementById("adminInvitePanel");
  if (!panel) return;
  document.getElementById("adminPairPanel")?.classList.add("hidden");

  panel.classList.remove("hidden");
  panel.innerHTML = `
    <form class="invite-form" id="inviteForm" novalidate>
      <label class="invite-label" for="inviteName">Vems kamera är det?</label>
      <input class="invite-input" id="inviteName" name="name" type="text" maxlength="60"
        autocomplete="off" placeholder="t.ex. Anna – P13" required>
      <p class="pair-instructions invite-help">Namnet blir kamerans namn, så att du vet vems den är.
        Inbjudan gäller i 3 dagar och kan kopplas till en kamera.</p>
      <p class="invite-error hidden" id="inviteError" role="alert"></p>
      <div class="invite-actions">
        <button type="button" class="device-revoke" id="inviteCancel">Avbryt</button>
        <button type="submit" class="admin-pair-btn" id="inviteCreate">Skapa inbjudan</button>
      </div>
    </form>`;

  const input = document.getElementById("inviteName");
  input.focus();
  document.getElementById("inviteCancel").addEventListener("click", closeInvitePanel);
  document.getElementById("inviteForm").addEventListener("submit", (e) => {
    e.preventDefault();
    createInvite(input.value);
  });
}

function closeInvitePanel() {
  const panel = document.getElementById("adminInvitePanel");
  if (!panel) return;
  panel.classList.add("hidden");
  panel.innerHTML = "";
}

function showFormError(message) {
  const el = document.getElementById("inviteError");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
}

async function createInvite(rawName) {
  const name = rawName.trim();
  if (!name) {
    showFormError("Skriv vems kamera det är.");
    document.getElementById("inviteName")?.focus();
    return;
  }

  const btn = document.getElementById("inviteCreate");
  btn.disabled = true;
  btn.textContent = "Skapar…";

  try {
    const res = await fetch(`${CONFIG.API_URL}/api/devices/invites`, {
      method: "POST",
      headers: adminHeaders(true),
      body: JSON.stringify({ name }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    await showInvite(body);
    loadInvites();
  } catch (err) {
    showFormError(`Kunde inte skapa inbjudan (${err.message}).`);
    btn.disabled = false;
    btn.textContent = "Skapa inbjudan";
  }
}

async function showInvite(invite) {
  const panel = document.getElementById("adminInvitePanel");
  const message = inviteMessage(invite);
  const svg = await qrSvg(invite.link);
  const canShare = typeof navigator.share === "function";

  panel.innerHTML = `
    <h3 class="invite-title">Inbjudan till ${escapeHtml(invite.name)}</h3>
    <p class="pair-instructions">Kopiera inbjudan och klistra in den i ett meddelande, till exempel i
      WhatsApp, ett mejl eller ett sms. Står personen bredvid dig kan den skanna QR-koden med sin iPhone
      och skriva in koden nedan.</p>
    <div class="invite-buttons">
      <button type="button" class="admin-pair-btn" id="inviteCopy">Kopiera inbjudan</button>
      <button type="button" class="device-revoke" id="inviteCopyLink">Kopiera länk</button>
      ${canShare ? '<button type="button" class="device-revoke" id="inviteShare">Dela…</button>' : ""}
    </div>
    <p class="invite-copied" id="inviteCopied" role="status" aria-live="polite"></p>
    <textarea class="invite-message" id="inviteMessage" readonly rows="8" aria-label="Inbjudan att kopiera">${escapeHtml(message)}</textarea>
    <div class="pair-qr">${svg}</div>
    <p class="pair-code-label">Kod att skriva in i kameraappen:</p>
    <p class="pair-code">${escapeHtml(invite.code)}</p>
    <p class="pair-url">${escapeHtml(invite.apiUrl)}</p>
    <p class="pair-expiry">Gäller till ${escapeHtml(formatWhen(invite.expiresAt))}. Koden visas bara nu, så kopiera den innan du stänger.</p>
    <div class="invite-actions">
      <button type="button" class="device-revoke" id="inviteDone">Klar</button>
    </div>`;

  const copied = document.getElementById("inviteCopied");
  const say = (ok, what) => {
    copied.textContent = ok
      ? `${what} kopierad – klistra in i ditt meddelande.`
      : "Kunde inte kopiera. Markera texten i rutan och kopiera den själv.";
    if (!ok) document.getElementById("inviteMessage")?.select();
  };

  document.getElementById("inviteCopy").addEventListener("click", async () => say(await copyText(message), "Inbjudan"));
  document.getElementById("inviteCopyLink").addEventListener("click", async () => say(await copyText(invite.link), "Länken"));
  document.getElementById("inviteShare")?.addEventListener("click", async () => {
    try {
      await navigator.share({ title: `Kamera för ${invite.club}`, text: message });
    } catch {
      // Cancelled, or the share sheet failed; copying is still there.
    }
  });
  document.getElementById("inviteDone").addEventListener("click", closeInvitePanel);
}

// --- The list ---

const STATUS_TEXT = {
  used: "Använd",
  expired: "Gick ut",
  revoked: "Återkallad",
};

/** Draw the invites. Quietly hides the section if they cannot be fetched. */
export async function loadInvites(devices) {
  const section = document.getElementById("adminInviteSection");
  const list = document.getElementById("adminInviteList");
  if (!section || !list) return;

  let invites;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/devices/invites`, { headers: adminHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    invites = await res.json();
  } catch {
    section.classList.add("hidden");
    return;
  }

  section.classList.toggle("hidden", invites.length === 0);
  const names = new Map((devices || []).map((d) => [d.id, d.name]));

  list.innerHTML = invites
    .map((i) => {
      const meta =
        i.status === "pending"
          ? `Väntar · gäller till ${escapeHtml(formatWhen(i.expiresAt))}`
          : i.status === "used"
            ? `Kopplad ${escapeHtml(formatWhen(i.usedAt))}${
                names.has(i.deviceId) ? ` · kameran heter ${escapeHtml(names.get(i.deviceId))}` : ""
              }`
            : STATUS_TEXT[i.status] || "";
      return `
      <div class="device-row invite-row" data-status="${escapeHtml(i.status)}">
        <div class="device-info">
          <span class="device-name">${escapeHtml(i.name)}</span>
          <span class="device-meta">${meta}</span>
        </div>
        ${
          i.status === "pending"
            ? `<button class="device-revoke" data-invite="${escapeHtml(i.id)}">Återkalla</button>`
            : ""
        }
      </div>`;
    })
    .join("");

  list.querySelectorAll("[data-invite]").forEach((btn) => {
    btn.addEventListener("click", () => revokeInvite(btn, devices));
  });
}

/** Two clicks, like removing a camera. */
async function revokeInvite(btn, devices) {
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.textContent = "Säker?";
    setTimeout(() => {
      if (btn.dataset.confirm === "1") {
        btn.dataset.confirm = "";
        btn.textContent = "Återkalla";
      }
    }, 4000);
    return;
  }

  btn.disabled = true;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/devices/invites/${encodeURIComponent(btn.dataset.invite)}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    // 409: it was used or ran out meanwhile; the list will say which.
    if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
    await loadInvites(devices);
  } catch {
    btn.disabled = false;
    btn.textContent = "Gick inte";
  }
}
