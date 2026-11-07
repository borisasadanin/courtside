// === Guest page (#54) ===
//
// The opponent's coach logs in with the guest code and sees that match's clips:
// play, download, share, or download all as a zip. Nothing else of the
// platform: this page only ever calls /api/guest/*, and it carries no club
// colour or logo. The club appears only as "Inspelat av <klubb>".

import { CONFIG } from "./modules/config.js";
import { escapeHtml, mediaUrl } from "./modules/utils.js";

const TOKEN_KEY = "courtside-guest-token";
const REFRESH_MS = 60_000;

const $ = (id) => document.getElementById(id);

const PLAY_SVG =
  '<svg width="56" height="56" viewBox="0 0 24 24" fill="white" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

let token = readToken();
let refreshTimer = null;

// --- Token, per browser. Storage may be unavailable (private mode): then the
// session lasts as long as the page.

function readToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const { token: t, expiresAt } = JSON.parse(raw);
    if (!t || Date.parse(expiresAt) < Date.now()) return null;
    return t;
  } catch {
    return null;
  }
}

function saveToken(t, expiresAt) {
  token = t;
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: t, expiresAt })); } catch { /* page session only */ }
}

function clearToken() {
  token = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
}

// --- Views

function show(view) {
  for (const id of ["loginView", "loading", "spaceView"]) $(id).classList.toggle("hidden", id !== view);
}

function showLogin(message) {
  clearInterval(refreshTimer);
  show("loginView");
  const err = $("loginError");
  err.textContent = message || "";
  err.classList.toggle("hidden", !message);
  $("guestCode").focus();
}

const dateFmt = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "long", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", minute: "2-digit" });

function formatDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : dateFmt.format(d);
}

function formatTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : timeFmt.format(d);
}

/** Download a clip with a sensible name; a new tab if the browser cannot. */
async function downloadClip(clip, fileName, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Hämtar…";
  try {
    const res = await fetch(mediaUrl(clip.mp4Url));
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    window.open(mediaUrl(clip.mp4Url), "_blank", "noopener");
  }
  btn.textContent = original;
  btn.disabled = false;
}

/** Share the clip's neutral link: the share sheet where there is one, else the clipboard. */
async function shareClip(clip, title, btn) {
  const url = `${window.location.origin}/g/${encodeURIComponent(clip.id)}`;
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch {
      // Cancelled or refused: fall through to copying.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = "Kopierad!";
    setTimeout(() => { btn.textContent = "Dela"; }, 1500);
  } catch {
    window.prompt("Kopiera länken:", url);
  }
}

function clipCard(clip, space) {
  const card = document.createElement("article");
  card.className = "guest-clip";
  const time = formatTime(clip.createdAt);
  const label = clip.label || `Klipp ${time}`;
  const match = `${space.homeTeam} - ${space.awayTeam}`;
  const fileName = `${match} ${time.replace(":", ".")}.mp4`.replace(/[\\/:*?"<>|]/g, "");

  card.innerHTML =
    `<div class="guest-clip-media">` +
    (clip.thumbnailUrl ? `<img alt="" loading="lazy">` : "") +
    `<button class="guest-play" type="button" aria-label="Spela ${escapeHtml(label)}">${PLAY_SVG}</button>` +
    `</div>` +
    `<div class="guest-clip-info">` +
    `<div><div class="guest-clip-time">${escapeHtml(clip.label || time)}</div>` +
    `<div class="guest-clip-dur">${clip.label ? escapeHtml(time) + " · " : ""}${Math.round(clip.durationSeconds)} s</div></div>` +
    `<div class="guest-clip-buttons">` +
    `<button class="guest-btn secondary" type="button" data-act="download">Ladda ner</button>` +
    `<button class="guest-btn secondary" type="button" data-act="share">Dela</button>` +
    `</div></div>`;

  const media = card.querySelector(".guest-clip-media");
  const img = card.querySelector("img");
  if (img) {
    img.src = mediaUrl(clip.thumbnailUrl);
    img.onerror = () => img.remove();
  }

  card.querySelector(".guest-play").addEventListener("click", (e) => {
    const video = document.createElement("video");
    video.src = mediaUrl(clip.mp4Url);
    video.controls = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    media.replaceChildren(video);
    video.play().catch(() => {});
    e.stopPropagation();
  });

  const dl = card.querySelector('[data-act="download"]');
  dl.addEventListener("click", () => downloadClip(clip, fileName, dl));
  const share = card.querySelector('[data-act="share"]');
  share.addEventListener("click", () => shareClip(clip, `${label} — ${space.homeTeam} – ${space.awayTeam}`, share));
  return card;
}

let shownClipIds = "";

function render(space) {
  show("spaceView");
  document.title = `${space.homeTeam} – ${space.awayTeam}`;

  $("teams").textContent = `${space.homeTeam} – ${space.awayTeam}`;
  const score = $("score");
  score.classList.toggle("hidden", !space.result);
  if (space.result) score.textContent = `${space.result.home}–${space.result.away}`;

  const meta = [formatDate(space.matchDate), space.venue].filter(Boolean).map(escapeHtml).join(" · ");
  $("meta").innerHTML = `${meta}<br>Inspelat av ${escapeHtml(space.club.name)}`;

  const until = formatDate(space.deleteAfter);
  $("deadline").textContent = `Klippen raderas för alltid den ${until}`;
  $("deadlineText").textContent =
    `Ladda ner de klipp ni vill spara. Efter ${until} finns de inte kvar och kan inte återskapas.`;

  const all = $("downloadAll");
  all.classList.toggle("hidden", space.clips.length === 0);
  // A plain link the browser downloads itself, so a phone saves it as a file.
  // A link cannot carry a header, so the token goes in the query (only this
  // route accepts it there).
  all.href = `${CONFIG.API_URL}/api/guest/clips.zip?token=${encodeURIComponent(token)}`;

  // Rebuild the grid only when the clips change, so a playing video is not cut off.
  const ids = space.clips.map((c) => c.id).join(",");
  if (ids !== shownClipIds) {
    shownClipIds = ids;
    $("clips").replaceChildren(...space.clips.map((c) => clipCard(c, space)));
  }
  $("noClips").classList.toggle("hidden", space.clips.length > 0);

  const p = space.privacy;
  const contact = p.contact
    ? /^[^\s@]+@[^\s@]+$/.test(p.contact)
      ? `<a href="mailto:${escapeHtml(p.contact)}">${escapeHtml(p.contact)}</a>`
      : escapeHtml(p.contact)
    : escapeHtml(space.club.name);
  $("info").innerHTML =
    `<h3>Om klippen</h3>` +
    `<p>${escapeHtml(p.controller)} ansvarar för inspelningen och klippen. ` +
    `Vill ni att ett klipp tas bort, kontakta ${contact}.` +
    (p.policyUrl && /^https?:\/\//.test(p.policyUrl)
      ? ` <a href="${escapeHtml(p.policyUrl)}" target="_blank" rel="noopener">Integritetsinformation</a>`
      : "") +
    `</p>`;

  const made = $("madeWith");
  if (space.product && space.product.url) {
    // The landing page greets visitors from a guest page at #gast.
    made.href = `${space.product.url}/#gast`;
    made.innerHTML = `Gjort med <b>${escapeHtml(space.product.name)}</b>`;
    made.hidden = false;
  }
}

async function loadSpace() {
  if (!token) return showLogin();
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/guest/space`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      clearToken();
      return showLogin("Logga in med koden igen.");
    }
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
  } catch {
    // Keep what is on screen; the next refresh tries again.
    if ($("spaceView").classList.contains("hidden")) showLogin("Kunde inte nå servern. Försök igen.");
  }
}

function startRefresh() {
  clearInterval(refreshTimer);
  // The result may be set or corrected after the match.
  refreshTimer = setInterval(loadSpace, REFRESH_MS);
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("guestCode").value.trim();
  if (!code) return showLogin("Skriv koden.");
  const btn = $("loginBtn");
  btn.disabled = true;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/guest/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) return showLogin("För många försök. Vänta en minut och försök igen.");
    if (!res.ok) return showLogin(body.message || "Koden fungerar inte, eller så har klippen tagits bort.");
    saveToken(body.token, body.expiresAt);
    $("guestCode").value = "";
    render(body.space);
    startRefresh();
  } catch {
    showLogin("Kunde inte nå servern. Försök igen.");
  } finally {
    btn.disabled = false;
  }
});

$("logout").addEventListener("click", () => {
  clearToken();
  shownClipIds = "";
  showLogin();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && token) loadSpace();
});

if (token) {
  show("loading");
  loadSpace().then(() => { if (token) startRefresh(); });
} else {
  showLogin();
}
