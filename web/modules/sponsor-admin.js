// === Sponsring, in Hantera (#87, #121) ===
//
// The club's sponsors, each a card (sponsor-cards.js), and under each its
// short films that viewers see live at the start, in the period breaks, in
// overtime and at the end. This page:
//
//   - switches the surfaces on and off, and orders the sponsors (#134)
//   - uploads a sponsor's clips straight to storage with a signed link, with progress (#97, #133)
//   - lists each sponsor's clips with a preview, renaming, moving and deleting (#98, #133)
//   - a grid of checkboxes: which clip is shown where (#99)
//   - the play order within a sponsor, by dragging the rows (#100)
//   - the total time per break against its length, with a warning (#101)
//
// The upload never passes through the API: its proxy refuses anything over
// 64 MiB, and a film is often larger.

import Hls from "hls.js";
import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { deactivateAdmin } from "./admin.js";
import {
  addSponsorForm,
  bindSortable,
  conflictNotice,
  isDragging,
  sponsorCard,
  surfaceSection,
  teamsText,
} from "./sponsor-cards.js";

/** The admin's columns, in the order a match goes. */
const SLOTS = [
  { id: "start", label: "Start" },
  { id: "p1", label: "Paus 1" },
  { id: "p2", label: "Paus 2" },
  { id: "p3", label: "Paus 3" },
  { id: "ot", label: "Övertid" },
  { id: "end", label: "Avslut" },
];
const BREAKS = ["p1", "p2", "p3", "ot"];

const STATUS_TEXT = {
  uploading: "Laddas upp",
  queued: "Väntar på bearbetning",
  processing: "Bearbetas",
  failed: "Fel",
};

/** What the page shows: GET /api/admin/sponsorship, the clips grouped by sponsor in play order. */
let data = { sponsors: [], packages: [], surfaces: [], clips: [], breakSeconds: {}, maxUploadBytes: 200 * 1024 * 1024 };
/** The club's own teams, for the cards. */
let ownTeams = [];
/** The sponsor the next picked files are uploaded under. */
let uploadTarget = null;
/** Uploads in this tab: local id → { name, sponsorId, loaded, total, error }. */
const uploads = new Map();
/** The clip whose details are open. */
let openId = null;
/** The clip whose removal waits for "Ja, ta bort". No timer: the admin decides (#118). */
let confirmDeleteId = null;
let pollTimer = null;
/** thumbnail URL → blob URL, so a redraw does not fetch it again. */
const thumbs = new Map();
let previewHls = null;

function adminHeaders(json) {
  const h = { "X-Admin-Token": state.adminToken };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

/**
 * For a clip's files, which redirect to storage: only Authorization, the one
 * header storage's CORS accepts and the browser drops on that redirect.
 */
function mediaHeaders() {
  return { Authorization: `Bearer ${state.adminToken}` };
}

async function send(method, path, body) {
  const res = await fetch(`${CONFIG.API_URL}${path}`, {
    method,
    headers: adminHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401) {
    alert("Du har loggats ut från admin. Logga in igen med admin-koden.");
    deactivateAdmin();
    throw new Error(json.error || "Admin-åtkomst krävs");
  }
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { data: json });
  return json;
}

// --- Formatting ---

/** 95 → "1:35". */
export function clock(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "2:30", "2" or "150s" → seconds, or null when it cannot be read. */
export function parseClock(text) {
  const t = String(text ?? "").trim();
  let m = t.match(/^(\d{1,2}):([0-5]\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = t.match(/^(\d{1,2})$/);
  if (m) return Number(m[1]) * 60;
  m = t.match(/^(\d{1,4})\s*s$/i);
  if (m) return Number(m[1]);
  return null;
}

/** Seconds of ready clips per column. */
export function totals(clips) {
  const out = Object.fromEntries(SLOTS.map((s) => [s.id, 0]));
  for (const c of clips) {
    if (c.status !== "ready") continue;
    for (const slot of c.slots) out[slot] += c.durationSeconds || 0;
  }
  return out;
}

/**
 * Whether a sponsor's clips are played in a slot, as the API decides it
 * (sponsorsFor in sponsor-surfaces.ts): the surface is on, in its package,
 * not switched off for it, and the sponsor is active and has teams.
 */
function plays(d, sponsor, slot) {
  const surface = d.surfaces.find((s) => s.id === slot);
  const pkg = d.packages.find((p) => p.id === sponsor.packageId);
  return Boolean(surface?.on && surface.available && pkg?.surfaces.includes(slot) && !sponsor.off.includes(slot)
    && sponsor.active && !sponsor.teamsGone);
}

/**
 * The longest a break's clips run, per column: a team's matches play the
 * team's sponsors and the club's, so each team is summed on its own. Says
 * which team when it is longer than the club's alone.
 */
export function breakTotals(d, teams) {
  const scopes = [null, ...new Set(d.sponsors.flatMap((x) => x.teamIds))];
  const out = Object.fromEntries(SLOTS.map((s) => [s.id, { seconds: 0, team: null }]));
  for (const scope of scopes) {
    const sponsors = d.sponsors.filter((x) => (x.teamIds.length === 0 && !x.teamsGone) || (scope && x.teamIds.includes(scope)));
    for (const slot of SLOTS) {
      const ids = new Set(sponsors.filter((x) => plays(d, x, slot.id)).map((x) => x.id));
      const sum = totals(d.clips.filter((c) => ids.has(c.sponsorId) && c.slots.includes(slot.id)))[slot.id];
      if (sum > out[slot.id].seconds) out[slot.id] = { seconds: sum, team: scope && (teams.find((t) => t.id === scope)?.name ?? null) };
    }
  }
  return out;
}

// --- Loading ---

/** Load the sponsors and their clips and draw the page and its row in Hantera. */
export async function renderSponsorsAdmin() {
  const root = document.getElementById("adminSponsors");
  if (!root) return;
  bindUpload();
  bindAdd();
  try {
    const [overview, teams] = await Promise.all([
      send("GET", "/api/admin/sponsorship"),
      fetch(`${CONFIG.API_URL}/api/teams`, { headers: adminHeaders(false) }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]);
    data = overview;
    ownTeams = (Array.isArray(teams) ? teams : []).filter((t) => t.own);
  } catch (err) {
    root.innerHTML = `<p class="admin-empty">Kunde inte hämta sponsorerna (${escapeHtml(err.message)})</p>`;
    return;
  }
  draw();
  schedulePoll();
}

/** While a clip is on its way, ask again every five seconds (#97). */
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = data.clips.some((c) => c.status === "queued" || c.status === "processing");
  if (!busy) return;
  pollTimer = setTimeout(async () => {
    const page = document.querySelector('[data-admin-page="sponsors"]');
    if (!page || page.classList.contains("hidden") || isDragging() || page.querySelector(".sponsor-edit")) return schedulePoll();
    try {
      data = await send("GET", "/api/admin/sponsorship");
      draw();
    } catch { /* try again on the next round */ }
    schedulePoll();
  }, 5000);
}

// --- Upload (#97) ---

/** One file input for every card: "Ladda upp klipp" in a card says whose the files are. */
function bindUpload() {
  const input = document.getElementById("adminSponsorFile");
  if (!input || input.dataset.bound) return;
  input.dataset.bound = "1";
  input.addEventListener("change", () => {
    for (const file of input.files) upload(file, uploadTarget);
    input.value = "";
  });
}

function pickUpload(sponsorId) {
  uploadTarget = sponsorId;
  document.getElementById("adminSponsorFile")?.click();
}

function bindAdd() {
  const btn = document.getElementById("adminSponsorAdd");
  const panel = document.getElementById("adminSponsorAddPanel");
  if (!btn || !panel || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => addSponsorForm(panel, cardContext()));
}

async function upload(file, sponsorId) {
  const key = crypto.randomUUID();
  const name = file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Sponsorklipp";
  const sponsorName = data.sponsors.find((x) => x.id === sponsorId)?.name;
  const entry = { name: sponsorName ? `${sponsorName}: ${name}` : name, loaded: 0, total: file.size, error: null };
  uploads.set(key, entry);
  drawUploads();

  // Some phones leave the type empty for a .mov; the server checks the file anyway.
  if (file.type && !file.type.startsWith("video/")) {
    entry.error = "Filen är ingen video. Välj en film, till exempel MP4 eller MOV.";
    return drawUploads();
  }
  if (file.size > data.maxUploadBytes) {
    entry.error = "Filen är större än 200 MB. Exportera den i lägre kvalitet och försök igen.";
    return drawUploads();
  }

  try {
    const { clip, upload: put } = await send("POST", "/api/admin/sponsors/uploads", {
      name,
      sizeBytes: file.size,
      contentType: file.type || "",
      ...(sponsorId && { sponsorId }),
    });
    data.clips.push(clip);
    countClips();
    draw();

    await putFile(put, file, (loaded) => {
      entry.loaded = loaded;
      drawUploads();
    });
    const done = await send("POST", `/api/admin/sponsors/${clip.id}/uploaded`);
    replaceClip(done.clip);
    uploads.delete(key);
  } catch (err) {
    entry.error = err.data?.clip ? err.message : `Uppladdningen misslyckades: ${err.message}`;
    if (err.data?.clip) replaceClip(err.data.clip);
  }
  draw();
  schedulePoll();
}

/** PUT the file to storage, with progress. fetch() cannot report upload progress, XHR can. */
function putFile(put, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(put.method, put.url);
    for (const [k, v] of Object.entries(put.headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`lagringen svarade ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("nätverksfel"));
    xhr.send(file);
  });
}

function replaceClip(clip) {
  const i = data.clips.findIndex((c) => c.id === clip.id);
  if (i === -1) data.clips.push(clip);
  else data.clips[i] = clip;
}

function drawUploads() {
  const box = document.getElementById("adminSponsorUploads");
  if (!box) return;
  box.replaceChildren(...[...uploads.entries()].map(([key, u]) => {
    const row = document.createElement("div");
    row.className = "sponsor-upload";
    const pct = u.total ? Math.floor((u.loaded / u.total) * 100) : 0;
    row.innerHTML = u.error
      ? `<span class="sponsor-upload-name">${escapeHtml(u.name)}</span>
         <span class="sponsor-upload-error">${escapeHtml(u.error)}</span>
         <button class="device-revoke" type="button">Stäng</button>`
      : `<span class="sponsor-upload-name">${escapeHtml(u.name)}</span>
         <span class="sponsor-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></span>
         <span class="sponsor-upload-pct">${pct} %</span>`;
    row.querySelector("button")?.addEventListener("click", () => { uploads.delete(key); drawUploads(); });
    return row;
  }));
}

/** The clips per sponsor, kept on the cards; the API counts them, a new upload is counted here. */
function countClips() {
  for (const x of data.sponsors) x.clipCount = data.clips.filter((c) => c.sponsorId === x.id).length;
}

/** What the cards need from this page (sponsor-cards.js). */
function cardContext() {
  return {
    data,
    teams: ownTeams,
    send,
    reload: renderSponsorsAdmin,
    redraw: draw,
    clips: clipGrid,
    upload: pickUpload,
    saveOrder: saveSponsorOrder,
  };
}

// --- The page (#98, #99, #101, #131, #134) ---

function draw() {
  drawUploads();
  const sub = document.getElementById("adminRowSponsorsSub");
  const ready = data.clips.filter((c) => c.status === "ready").length;
  if (sub) {
    sub.textContent = data.sponsors.length
      ? `${data.sponsors.length} ${data.sponsors.length === 1 ? "sponsor" : "sponsorer"} · ${ready} klipp klara att visa`
      : "Sponsorer och deras klipp";
  }

  const root = document.getElementById("adminSponsors");
  if (!root) return;
  const ctx = cardContext();
  const parts = [];
  if (data.sponsors.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-empty";
    empty.textContent = "Inga sponsorer ännu. Lägg till en sponsor och ladda sedan upp dess klipp, till exempel en reklamfilm som MP4 eller MOV från telefonen.";
    parts.push(empty);
  } else {
    const notice = conflictNotice(ctx);
    if (notice) parts.push(notice);
    const list = document.createElement("div");
    list.className = "sponsor-cards";
    data.sponsors.forEach((x, i) => list.append(sponsorCard(x, i, ctx)));
    parts.push(list, pausesSection());
  }
  // The surfaces last: set once, while the cards and pauses are daily work.
  parts.push(surfaceSection(ctx));
  root.replaceChildren(...parts);
}

/** One sponsor's clips: a grid of checkboxes per slot, and the open clip's details below it. */
function clipGrid(sponsor) {
  const wrap = document.createElement("div");
  const clips = data.clips.filter((c) => c.sponsorId === sponsor.id);
  if (clips.length === 0) {
    wrap.innerHTML = `<p class="sponsor-card-empty">Inga klipp ännu. Ladda upp en film på högst 200 MB.</p>`;
    return wrap;
  }

  const grid = document.createElement("div");
  grid.className = "sponsor-grid";
  grid.setAttribute("role", "table");
  grid.setAttribute("aria-label", `${sponsor.name}: klipp och var de visas`);

  const head = document.createElement("div");
  head.className = "sponsor-row sponsor-head";
  head.setAttribute("role", "row");
  head.innerHTML = `<span role="columnheader" class="sponsor-handle-cell"><span class="sr-only">Ordning</span></span>
    <span role="columnheader">Klipp</span>
    ${SLOTS.map((s) => `<span role="columnheader" class="sponsor-col">${s.label}</span>`).join("")}`;
  grid.append(head);

  const body = document.createElement("div");
  body.className = "sponsor-body";
  body.setAttribute("role", "rowgroup");
  for (const clip of clips) body.append(clipRow(clip));
  grid.append(body);

  const scroller = document.createElement("div");
  scroller.className = "sponsor-scroll";
  scroller.append(grid);

  // The details go below the table, at full width: inside it they scrolled
  // sideways with the columns and were cut off on a phone (#118).
  const open = clips.find((c) => c.id === openId);
  wrap.append(scroller, ...(open ? [detailPanel(open)] : []));
  return wrap;
}

/** The total per break against its length, for every sponsor together, and the warnings (#101). */
function pausesSection() {
  const sums = breakTotals(data, ownTeams);
  const section = document.createElement("section");
  section.className = "sponsor-section";
  section.setAttribute("aria-labelledby", "sponsorPausesTitle");
  section.innerHTML = `<h3 class="admin-section-title" id="sponsorPausesTitle">Pauser</h3>
    <p class="privacy-admin-intro">Klippens sammanlagda längd i varje paus, för det lag som har flest klipp.</p>`;

  const grid = document.createElement("div");
  grid.className = "sponsor-grid";
  grid.setAttribute("role", "table");
  grid.setAttribute("aria-label", "Klippens längd per paus");

  const head = document.createElement("div");
  head.className = "sponsor-row sponsor-head";
  head.setAttribute("role", "row");
  head.innerHTML = `<span role="columnheader"></span><span role="columnheader"></span>
    ${SLOTS.map((s) => `<span role="columnheader" class="sponsor-col">${s.label}</span>`).join("")}`;
  grid.append(head);

  const total = document.createElement("div");
  total.className = "sponsor-row sponsor-foot";
  total.setAttribute("role", "row");
  total.innerHTML = `<span role="cell"></span><span role="cell" class="sponsor-foot-label">Totalt</span>
    ${SLOTS.map((s) => {
      const over = BREAKS.includes(s.id) && sums[s.id].seconds > (data.breakSeconds[s.id] ?? Infinity);
      return `<span role="cell" class="sponsor-col${over ? " sponsor-over" : ""}">${clock(sums[s.id].seconds)}</span>`;
    }).join("")}`;
  grid.append(total);

  const lengths = document.createElement("div");
  lengths.className = "sponsor-row sponsor-foot";
  lengths.setAttribute("role", "row");
  lengths.innerHTML = `<span role="cell"></span><span role="cell" class="sponsor-foot-label">Pauslängd</span>
    ${SLOTS.map((s) => BREAKS.includes(s.id)
      ? `<span role="cell" class="sponsor-col"><input class="sponsor-break" inputmode="numeric" data-break="${s.id}"
           value="${clock(data.breakSeconds[s.id])}" aria-label="Längd på ${s.label} i minuter och sekunder"></span>`
      : `<span role="cell" class="sponsor-col sponsor-na">–</span>`).join("")}`;
  lengths.querySelectorAll("input").forEach(bindBreakInput);
  grid.append(lengths);

  const scroller = document.createElement("div");
  scroller.className = "sponsor-scroll";
  scroller.append(grid);
  section.append(scroller, warnings(sums));
  return section;
}

/** Open or close a clip's details, and bring them into view. */
function toggleDetails(id) {
  openId = openId === id ? null : id;
  confirmDeleteId = null;
  draw();
  if (openId) document.querySelector("#adminSponsors .sponsor-detail")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function clipRow(clip) {
  const row = document.createElement("div");
  row.className = `sponsor-row sponsor-clip${clip.id === openId ? " sponsor-open" : ""}`;
  row.setAttribute("role", "row");
  row.dataset.id = clip.id;

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "sponsor-handle";
  handle.setAttribute("aria-label", `Flytta ${clip.name}. Dra, eller använd pil upp och ner.`);
  handle.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`;
  bindSortable(handle, row, {
    selector: ".sponsor-clip",
    ids: order,
    onStart: () => {
      // The open details would sit between the rows being sorted.
      document.querySelector("#adminSponsors .sponsor-detail")?.remove();
      openId = null;
      confirmDeleteId = null;
    },
    onDrop: saveOrder,
    onKey: (dir) => move(clip.id, dir).then(() => {
      document.querySelector(`.sponsor-clip[data-id="${clip.id}"] .sponsor-handle`)?.focus();
    }),
  });
  const handleCell = document.createElement("span");
  handleCell.setAttribute("role", "cell");
  handleCell.className = "sponsor-handle-cell";
  handleCell.append(handle);

  const info = document.createElement("button");
  info.type = "button";
  info.className = "sponsor-info";
  info.setAttribute("role", "cell");
  info.setAttribute("aria-expanded", String(clip.id === openId));
  info.setAttribute("aria-controls", "sponsorDetail");
  const status = clip.status === "ready"
    ? clock(clip.durationSeconds)
    : clip.status === "failed"
      ? `<span class="sponsor-status sponsor-status-failed">Fel – tryck här</span>`
      : `<span class="sponsor-status sponsor-status-${clip.status}">${STATUS_TEXT[clip.status] ?? clip.status}</span>`;
  info.innerHTML = `<span class="sponsor-thumb"><img alt=""></span>
    <span class="sponsor-text"><span class="sponsor-name">${escapeHtml(clip.name)}</span><span class="sponsor-meta">${status}</span></span>
    <svg class="sponsor-chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  loadThumb(info.querySelector("img"), clip.thumbnailUrl);
  info.addEventListener("click", () => toggleDetails(clip.id));

  row.append(handleCell, info);
  for (const s of SLOTS) {
    const cell = document.createElement("span");
    cell.setAttribute("role", "cell");
    cell.className = "sponsor-col";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "sponsor-check";
    box.checked = clip.slots.includes(s.id);
    // A clip that cannot be played yet cannot be chosen either (#99).
    box.disabled = clip.status !== "ready";
    box.setAttribute("aria-label", `${clip.name} – ${s.label}`);
    box.addEventListener("change", () => toggleSlot(clip, s.id, box));
    cell.append(box);
    row.append(cell);
  }
  return row;
}

async function toggleSlot(clip, slot, box) {
  const slots = box.checked ? [...clip.slots, slot] : clip.slots.filter((x) => x !== slot);
  box.disabled = true;
  try {
    const res = await send("PATCH", `/api/admin/sponsors/${clip.id}`, { slots });
    replaceClip(res.clip);
  } catch (err) {
    alert(`Kunde inte spara: ${err.message}`);
  }
  draw();
}

function bindBreakInput(input) {
  input.addEventListener("change", async () => {
    const seconds = parseClock(input.value);
    if (seconds === null || seconds < 1 || seconds > 3600) {
      alert("Skriv pausens längd som minuter och sekunder, högst 60:00, till exempel 2:00 eller 15:00.");
      input.value = clock(data.breakSeconds[input.dataset.break]);
      return;
    }
    try {
      const res = await send("PATCH", "/api/admin/sponsors/breaks", { [input.dataset.break]: seconds });
      data.breakSeconds = res.breakSeconds;
    } catch (err) {
      alert(`Kunde inte spara: ${err.message}`);
    }
    draw();
  });
}

/** One line per break whose clips run longer than the break. */
function warnings(sums) {
  const box = document.createElement("div");
  box.className = "sponsor-warnings";
  box.setAttribute("aria-live", "polite");
  for (const s of SLOTS) {
    if (!BREAKS.includes(s.id)) continue;
    const limit = data.breakSeconds[s.id];
    const { seconds, team } = sums[s.id];
    if (seconds <= limit) continue;
    const p = document.createElement("p");
    p.className = "sponsor-warning";
    p.textContent = `${s.label}${team ? ` (${team})` : ""}: Klippen är längre än pausen (${clock(seconds)} mot ${clock(limit)}). Tittarna ser klart klippen och kommer tillbaka till matchen ${clock(seconds - limit)} för sent.`;
    box.append(p);
  }
  return box;
}

// --- Details: preview, rename, delete (#98) ---

function detailPanel(clip) {
  const panel = document.createElement("section");
  panel.className = "sponsor-detail";
  panel.id = "sponsorDetail";
  panel.setAttribute("aria-label", `Klippet ${clip.name}`);

  const media = clip.status === "ready"
    ? `<video class="sponsor-preview" controls playsinline preload="metadata"></video>`
    : clip.status === "failed"
      ? `<p class="sponsor-upload-error">${escapeHtml(clip.error || "Klippet kunde inte bearbetas.")}</p>`
      : `<p class="privacy-admin-intro">${STATUS_TEXT[clip.status]}. Förhandsvisningen kommer när klippet är klart.</p>`;

  const confirming = confirmDeleteId === clip.id;
  const removal = confirming
    ? `<div class="sponsor-confirm" role="alertdialog" aria-labelledby="sponsorConfirm-${clip.id}">
        <p id="sponsorConfirm-${clip.id}">Ta bort <strong>${escapeHtml(clip.name)}</strong>? Klippet och dess filer tas bort för gott, och det visas inte längre för tittarna.</p>
        <div class="sponsor-confirm-actions">
          <button class="device-revoke sponsor-delete-yes" type="button" data-act="delete-yes">Ja, ta bort</button>
          <button class="admin-pair-btn" type="button" data-act="delete-no">Avbryt</button>
        </div>
      </div>`
    : `<button class="device-revoke sponsor-delete" type="button" data-act="delete">Ta bort klippet</button>`;

  panel.innerHTML = `<div class="sponsor-detail-inner">
    <div class="sponsor-detail-head">
      <h3 class="sponsor-detail-title">${escapeHtml(clip.name)}</h3>
      <button class="sponsor-detail-close" type="button" data-act="close" aria-label="Stäng">✕</button>
    </div>
    ${media}
    <label class="invite-label" for="sponsorName-${clip.id}">Namn</label>
    <div class="sponsor-rename">
      <input class="invite-input" id="sponsorName-${clip.id}" maxlength="80" value="${escapeHtml(clip.name)}">
      <button class="admin-pair-btn" type="button" data-act="save">Spara</button>
    </div>
    <div class="sponsor-move" role="group" aria-label="Ordning">
      <button class="admin-pair-btn" type="button" data-act="up"${neighbour(clip, -1) ? "" : " disabled"}>Flytta upp</button>
      <button class="admin-pair-btn" type="button" data-act="down"${neighbour(clip, 1) ? "" : " disabled"}>Flytta ner</button>
    </div>
    ${data.sponsors.length > 1 ? `
    <label class="invite-label" for="sponsorOwner-${clip.id}">Flytta till sponsor</label>
    <div class="sponsor-rename">
      <select class="sponsor-select" id="sponsorOwner-${clip.id}">
        ${data.sponsors.map((x) => `<option value="${escapeHtml(x.id)}"${x.id === clip.sponsorId ? " selected" : ""}>${escapeHtml(x.name)} · ${escapeHtml(teamsText(x, ownTeams))}</option>`).join("")}
      </select>
      <button class="admin-pair-btn" type="button" data-act="owner">Flytta</button>
    </div>` : ""}
    ${removal}
  </div>`;

  const video = panel.querySelector("video");
  if (video) startPreview(video, clip.hlsUrl);

  // #133: the clip moves to another sponsor, last among its clips, with its slots.
  panel.querySelector('[data-act="owner"]')?.addEventListener("click", async () => {
    const sponsorId = panel.querySelector("select").value;
    if (sponsorId === clip.sponsorId) return;
    try {
      const res = await send("PATCH", `/api/admin/sponsors/${clip.id}`, { sponsorId });
      data.clips = [...data.clips.filter((c) => c.id !== clip.id), res.clip];
      groupClips();
      countClips();
      draw();
      document.querySelector(`#adminSponsors .sponsor-clip[data-id="${clip.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (err) {
      alert(`Kunde inte flytta klippet: ${err.message}`);
    }
  });

  const nameInput = panel.querySelector("input");
  panel.querySelector('[data-act="save"]').addEventListener("click", async () => {
    try {
      const res = await send("PATCH", `/api/admin/sponsors/${clip.id}`, { name: nameInput.value });
      replaceClip(res.clip);
      draw();
    } catch (err) {
      alert(err.message);
    }
  });

  // Buttons for the order too, for the keyboard and screen readers (#100).
  for (const act of ["up", "down"]) {
    panel.querySelector(`[data-act="${act}"]`).addEventListener("click", () => {
      move(clip.id, act === "up" ? -1 : 1).then(() => {
        const again = document.querySelector(`#adminSponsors .sponsor-detail [data-act="${act}"]`);
        (again && !again.disabled ? again : document.querySelector(`#adminSponsors .sponsor-detail [data-act="${act === "up" ? "down" : "up"}"]`))?.focus();
      });
    });
  }

  panel.querySelector('[data-act="close"]').addEventListener("click", () => {
    toggleDetails(clip.id);
    document.querySelector(`#adminSponsors .sponsor-clip[data-id="${clip.id}"] .sponsor-info`)?.focus();
  });

  // Removing asks once, in words, and waits for the answer: no timer that
  // quietly takes the question back (#118).
  panel.querySelector('[data-act="delete"]')?.addEventListener("click", () => {
    confirmDeleteId = clip.id;
    draw();
    document.querySelector('#adminSponsors [data-act="delete-no"]')?.focus();
  });
  panel.querySelector('[data-act="delete-no"]')?.addEventListener("click", () => {
    confirmDeleteId = null;
    draw();
    document.querySelector('#adminSponsors [data-act="delete"]')?.focus();
  });
  const yes = panel.querySelector('[data-act="delete-yes"]');
  yes?.addEventListener("click", async () => {
    yes.disabled = true;
    yes.textContent = "Tar bort…";
    try {
      await send("DELETE", `/api/admin/sponsors/${clip.id}`);
      data.clips = data.clips.filter((c) => c.id !== clip.id);
    } catch (err) {
      // Already gone on the server: it is gone here too
      if (err.message === "Klippet finns inte.") data.clips = data.clips.filter((c) => c.id !== clip.id);
      else alert(`Kunde inte ta bort: ${err.message}`);
    }
    openId = null;
    confirmDeleteId = null;
    countClips();
    draw();
  });
  return panel;
}

function startPreview(video, url) {
  previewHls?.destroy();
  previewHls = null;
  const src = `${CONFIG.API_URL}${url}`;
  if (Hls.isSupported()) {
    previewHls = new Hls({
      xhrSetup: (xhr) => {
        for (const [k, v] of Object.entries(mediaHeaders())) xhr.setRequestHeader(k, v);
      },
    });
    previewHls.loadSource(src);
    previewHls.attachMedia(video);
  } else {
    // Safari's own player cannot send the code; without a viewer PIN it still plays.
    video.src = src;
  }
}

function loadThumb(img, url) {
  if (!url) return img.parentElement.classList.add("sponsor-thumb-empty");
  const cached = thumbs.get(url);
  if (cached) return void (img.src = cached);
  fetch(`${CONFIG.API_URL}${url}`, { headers: mediaHeaders() })
    .then((res) => (res.ok ? res.blob() : Promise.reject()))
    .then((blob) => {
      const blobUrl = URL.createObjectURL(blob);
      thumbs.set(url, blobUrl);
      img.src = blobUrl;
    })
    .catch(() => img.parentElement.classList.add("sponsor-thumb-empty"));
}

// --- Order of the clips within a sponsor (#100, #133) ---

/** The clip next to this one in its sponsor's list: -1 above, 1 below. */
function neighbour(clip, step) {
  const own = data.clips.filter((c) => c.sponsorId === clip.sponsorId);
  return own[own.findIndex((c) => c.id === clip.id) + step] ?? null;
}

/** The clips grouped by sponsor, in the sponsors' order, as the API keeps them. */
function groupClips() {
  const at = new Map(data.sponsors.map((x, i) => [x.id, i]));
  data.clips = data.clips
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (at.get(a.c.sponsorId) ?? 1e9) - (at.get(b.c.sponsorId) ?? 1e9) || a.i - b.i)
    .map((x) => x.c);
}

/** Move one clip a step up (-1) or down (1) among its sponsor's clips, and save. */
async function move(id, step) {
  const clip = data.clips.find((c) => c.id === id);
  const other = clip && neighbour(clip, step);
  if (!other) return;
  const ids = data.clips.map((c) => c.id);
  const i = ids.indexOf(id);
  const j = ids.indexOf(other.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await saveOrder(ids);
}

/** The clip ids in the order the rows are on screen: sponsor by sponsor, as the cards are. */
function order() {
  return [...document.querySelectorAll("#adminSponsors .sponsor-clip")].map((r) => r.dataset.id);
}

async function saveOrder(ids) {
  const byId = new Map(data.clips.map((c) => [c.id, c]));
  data.clips = ids.map((id) => byId.get(id));
  draw();
  try {
    const res = await send("PUT", "/api/admin/sponsors/order", { ids });
    data.clips = res.clips;
  } catch (err) {
    alert(`Kunde inte spara ordningen: ${err.message}`);
    await renderSponsorsAdmin();
    return;
  }
  draw();
}

// --- Order of the sponsors (#134) ---

/** A new order of the sponsors. Their clips follow, so the play order changes too. */
async function saveSponsorOrder(ids) {
  const byId = new Map(data.sponsors.map((x) => [x.id, x]));
  data.sponsors = ids.map((id) => byId.get(id));
  groupClips();
  draw();
  try {
    const res = await send("PUT", "/api/admin/sponsorship/sponsors/order", { ids });
    data = res;
  } catch (err) {
    alert(`Kunde inte spara ordningen: ${err.message}`);
    await renderSponsorsAdmin();
    return;
  }
  draw();
}
