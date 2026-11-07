// === Guest spaces, in Hantera (#55) ===
//
// Clips the camera saves for the opponent go to the match's guest space, which
// the opponent opens at <site>/gast with a code. Admin sends that code: here it
// is in plain text with the link and a ready invitation to paste into an email
// or text message. Opening a space plays its clips and deletes them, one by one
// or all at once; every deletion goes into the deletion log.
//
// A match in Matcher links here when it has a guest space (guestSpaceForMatch).

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml, formatDate } from "./utils.js";
import { deactivateAdmin, showAdminPage } from "./admin.js";

/** The latest list, for the links from Matcher. Spaces without clips are not in it. */
let spaces = [];
/** The list as it loads, so Matcher can wait for it. */
let loading = null;

function adminHeaders() {
  return { "X-Admin-Token": state.adminToken };
}

async function call(method, path) {
  const res = await fetch(`${CONFIG.API_URL}${path}`, { method, headers: adminHeaders() });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401) {
    deactivateAdmin();
    throw new Error("Admin-åtkomst krävs");
  }
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

/** "7 nov. 2026" for a match date, whether a bare date or a timestamp. */
function matchDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? formatDate(value) : formatDate((value || "").slice(0, 10));
}

/** "21 november", the day the space is deleted, in the viewer's time. */
function deletionDay(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("sv-SE", { day: "numeric", month: "long" });
}

function resultText(r) {
  return r ? `${r.home} – ${r.away}` : "";
}

/** Copy `text`, and let the button say so for a moment. */
function copyButton(label, text, className = "device-revoke") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text());
      btn.textContent = "Kopierat";
    } catch {
      btn.textContent = "Kunde inte kopiera";
    }
    setTimeout(() => { btn.textContent = label; }, 1800);
  });
  return btn;
}

/** Load the spaces (once per round; Matcher waits on the same request). */
export function loadGuestSpaces() {
  if (!loading) {
    loading = call("GET", "/api/admin/guest-spaces")
      .then((list) => { spaces = list; return list; })
      .finally(() => { setTimeout(() => { loading = null; }, 0); });
  }
  return loading;
}

/** The guest space of a match in the schedule, by match id or one of its recordings. */
export async function guestSpaceForMatch(match) {
  try {
    await (loading || Promise.resolve());
  } catch {
    return null;
  }
  const ids = new Set(match.recordingIds || []);
  return spaces.find((s) => s.matchId === match.id || s.streamIds.some((id) => ids.has(id))) || null;
}

/** The list under Gästytor, and the row in Hantera. */
export async function renderGuestSpacesAdmin() {
  const list = document.getElementById("adminGuestList");
  if (!list) return;
  let all;
  try {
    all = await loadGuestSpaces();
  } catch (err) {
    list.innerHTML = `<p class="admin-empty">Kunde inte hämta gästytorna (${escapeHtml(err.message)})</p>`;
    return;
  }

  const sub = document.getElementById("adminRowGuestsSub");
  if (sub) sub.textContent = all.length ? `${all.length} st` : "Motståndarlagens highlights";

  if (all.length === 0) {
    list.innerHTML = '<p class="admin-empty">Inga gästytor just nu. En gästyta skapas när kameran sparar det första klippet åt motståndarlaget i en match.</p>';
    return;
  }
  list.replaceChildren(...all.map((s) => spaceRow(s)));
}

/** One space in the list: the match, code and link to copy, and when it goes. Opens on click. */
function spaceRow(space) {
  const item = document.createElement("div");
  item.className = "guest-admin-item";

  const open = document.createElement("button");
  open.type = "button";
  open.className = "guest-admin-open";
  const meta = [matchDay(space.matchDate)];
  if (space.venue) meta.push(space.venue);
  meta.push(space.clipCount === 1 ? "1 klipp" : `${space.clipCount} klipp`);
  open.innerHTML = `
    <span class="device-name">${escapeHtml(space.homeTeam)} – ${escapeHtml(space.awayTeam)}${space.result ? ` <span class="guest-admin-result">${escapeHtml(resultText(space.result))}</span>` : ""}</span>
    <span class="device-meta">${meta.map(escapeHtml).join(" · ")}</span>
    <span class="device-meta">Raderas ${escapeHtml(deletionDay(space.deleteAfter))}</span>`;
  open.addEventListener("click", () => openGuestSpace(space.id, "guests"));

  item.append(open, accessBlock(space));
  return item;
}

/** Code and link in plain text, each with a copy button, and the invitation. */
function accessBlock(space) {
  const block = document.createElement("div");
  block.className = "guest-admin-access";

  const codeRow = document.createElement("div");
  codeRow.className = "guest-admin-line";
  codeRow.innerHTML = `<span class="guest-admin-key">Kod</span><code class="guest-admin-code">${escapeHtml(space.code)}</code>`;
  codeRow.append(copyButton("Kopiera", () => space.code));

  const linkRow = document.createElement("div");
  linkRow.className = "guest-admin-line";
  linkRow.innerHTML = `<span class="guest-admin-key">Länk</span><a class="guest-admin-link" href="${escapeHtml(space.link)}" target="_blank" rel="noopener">${escapeHtml(space.link.replace(/^https?:\/\//, ""))}</a>`;
  linkRow.append(copyButton("Kopiera", () => space.link));

  block.append(codeRow, linkRow, copyButton("Kopiera inbjudan", () => space.invitation, "admin-pair-btn guest-admin-invite"));
  return block;
}

/**
 * Open one space in Hantera. `from` is the page its back button returns to
 * ("guests" or "matches").
 */
export async function openGuestSpace(id, from = "guests") {
  const back = document.getElementById("adminGuestBack");
  if (back) {
    back.dataset.adminOpen = from;
    back.querySelector("span").textContent = from === "matches" ? "Matcher" : "Gästytor";
  }
  const el = document.getElementById("adminGuestSpace");
  el.innerHTML = '<div class="spinner"></div>';
  showAdminPage("guest-space");
  try {
    renderSpace(el, await call("GET", `/api/admin/guest-spaces/${encodeURIComponent(id)}`), from);
  } catch (err) {
    el.innerHTML = `<p class="admin-empty">Kunde inte öppna gästytan (${escapeHtml(err.message)})</p>`;
  }
}

function renderSpace(el, space, from) {
  const reload = () => {
    openGuestSpace(space.id, from);
    loading = null;
    renderGuestSpacesAdmin();
  };
  const facts = [matchDay(space.matchDate)];
  if (space.venue) facts.push(space.venue);
  if (space.result) facts.push(`Resultat ${resultText(space.result)}`);

  el.innerHTML = `
    <h2 class="admin-page-title">${escapeHtml(space.homeTeam)} – ${escapeHtml(space.awayTeam)}</h2>
    <p class="privacy-admin-intro">${facts.map(escapeHtml).join(" · ")}<br>Gästytan raderas med alla klipp ${escapeHtml(deletionDay(space.deleteAfter))}.</p>`;

  const card = document.createElement("div");
  card.className = "admin-card guest-admin-card";
  card.append(accessBlock(space));

  // A new code: the one already sent stops working at once.
  const codeBtn = document.createElement("button");
  codeBtn.type = "button";
  codeBtn.className = "branding-link";
  codeBtn.textContent = "Ny kod";
  codeBtn.addEventListener("click", async () => {
    if (!confirm("Slumpa en ny kod? Den gamla koden slutar gälla direkt, så den som redan fått den behöver den nya.")) return;
    codeBtn.disabled = true;
    try {
      await call("POST", `/api/admin/guest-spaces/${encodeURIComponent(space.id)}/code`);
      reload();
    } catch (err) {
      alert(`Kunde inte byta kod (${err.message})`);
      codeBtn.disabled = false;
    }
  });
  card.append(codeBtn);
  el.append(card);

  const head = document.createElement("div");
  head.className = "admin-section-head guest-admin-clips-head";
  head.innerHTML = `<p class="admin-eyebrow">${space.clips.length === 1 ? "1 klipp" : `${space.clips.length} klipp`}</p>`;
  el.append(head);

  if (space.clips.length === 0) {
    el.append(Object.assign(document.createElement("p"), {
      className: "admin-empty",
      textContent: "Inga klipp kvar. Gästytan visas inte i listan förrän kameran sparar nya klipp åt motståndarlaget.",
    }));
    return;
  }

  const onRequest = document.createElement("label");
  onRequest.className = "admin-on-request";
  onRequest.innerHTML = `<input type="checkbox"><span>Det jag tar bort nu görs på begäran av någon som syns i klippen. Noteras i raderingsloggen.</span>`;
  const query = () => (onRequest.querySelector("input").checked ? "?onRequest=1" : "");

  const removeAll = document.createElement("button");
  removeAll.type = "button";
  removeAll.className = "device-revoke";
  removeAll.textContent = "Ta bort alla";
  removeAll.addEventListener("click", async () => {
    if (!confirm(`Ta bort alla ${space.clips.length} klipp för alltid? Motståndarlaget kan inte längre se eller ladda ner dem.`)) return;
    removeAll.disabled = true;
    try {
      await call("DELETE", `/api/admin/guest-spaces/${encodeURIComponent(space.id)}/clips${query()}`);
      reload();
    } catch (err) {
      alert(`Kunde inte ta bort klippen (${err.message})`);
      removeAll.disabled = false;
    }
  });
  head.append(removeAll);

  const list = document.createElement("div");
  list.className = "guest-admin-clips";
  list.append(...space.clips.map((clip, i) => clipRow(space, clip, i, query, reload)));
  el.append(onRequest, list);
}

/** The signed address of an admin media url, for <img> and <video>. */
async function signed(url) {
  const res = await fetch(`${CONFIG.API_URL}${url}?link=1`, { headers: adminHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).url;
}

function clipRow(space, clip, i, query, reload) {
  const item = document.createElement("div");
  item.className = "guest-admin-clip";

  const play = document.createElement("button");
  play.type = "button";
  play.className = "guest-admin-thumb";
  play.setAttribute("aria-label", `Spela ${clip.label || `klipp ${i + 1}`}`);
  play.innerHTML = '<span class="guest-admin-play" aria-hidden="true">&#9654;</span>';
  if (clip.thumbnailUrl) {
    signed(clip.thumbnailUrl).then((url) => {
      const img = document.createElement("img");
      img.alt = "";
      img.src = url;
      play.prepend(img);
    }).catch(() => {});
  }

  const t = new Date(clip.createdAt);
  const time = isNaN(t) ? "" : t.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  const info = document.createElement("div");
  info.className = "device-info";
  info.innerHTML = `
    <span class="device-name">${escapeHtml(clip.label || `Klipp ${i + 1}`)}</span>
    <span class="device-meta">${escapeHtml([time, clip.durationSeconds ? `${Math.round(clip.durationSeconds)} s` : ""].filter(Boolean).join(" · "))}</span>`;

  const del = document.createElement("button");
  del.type = "button";
  del.className = "device-revoke";
  del.textContent = "Ta bort";
  del.addEventListener("click", async () => {
    // Two clicks, like the club's own clips.
    if (del.dataset.confirm !== "1") {
      del.dataset.confirm = "1";
      del.textContent = "Bekräfta?";
      setTimeout(() => { del.dataset.confirm = ""; del.textContent = "Ta bort"; }, 3000);
      return;
    }
    del.disabled = true;
    del.textContent = "Tar bort…";
    try {
      await call("DELETE", `/api/admin/guest-spaces/${encodeURIComponent(space.id)}/clips/${encodeURIComponent(clip.id)}${query()}`);
      reload();
    } catch (err) {
      del.textContent = "Misslyckades";
      del.disabled = false;
    }
  });

  const row = document.createElement("div");
  row.className = "guest-admin-clip-row";
  row.append(play, info, del);
  item.append(row);

  play.addEventListener("click", async () => {
    const existing = item.querySelector("video");
    if (existing) {
      existing.remove();
      return;
    }
    try {
      const video = document.createElement("video");
      video.className = "guest-admin-video";
      video.controls = true;
      video.playsInline = true;
      video.src = await signed(clip.mp4Url);
      item.append(video);
      video.play().catch(() => {});
    } catch {
      alert("Kunde inte spela klippet");
    }
  });
  return item;
}
