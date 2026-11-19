// === Sponsor clips, in Hantera (#87, phase 2) ===
//
// The club uploads short films that viewers see live at the start, in the
// period breaks, in overtime and at the end. This page:
//
//   - uploads straight to storage with a signed link, with progress (#97)
//   - lists the clips with a preview, renaming and deleting (#98)
//   - a grid of checkboxes: which clip is shown where (#99)
//   - the play order, by dragging the rows (#100)
//   - the total time per column against each break's length, with a warning (#101)
//
// The upload never passes through the API: its proxy refuses anything over
// 64 MiB, and a film is often larger.

import Hls from "hls.js";
import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { deactivateAdmin } from "./admin.js";

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

/** What the page shows: the clips in play order and the break lengths. */
let data = { clips: [], breakSeconds: {}, maxUploadBytes: 200 * 1024 * 1024 };
/** Uploads in this tab: local id → { name, loaded, total, error }. */
const uploads = new Map();
/** The clip whose details are open. */
let openId = null;
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

// --- Loading ---

/** Load the clips and draw the page and its row in Hantera. */
export async function renderSponsorsAdmin() {
  const root = document.getElementById("adminSponsors");
  if (!root) return;
  bindUpload();
  try {
    data = await send("GET", "/api/admin/sponsors");
  } catch (err) {
    root.innerHTML = `<p class="admin-empty">Kunde inte hämta sponsorklippen (${escapeHtml(err.message)})</p>`;
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
    if (!page || page.classList.contains("hidden") || dragging) return schedulePoll();
    try {
      data = await send("GET", "/api/admin/sponsors");
      draw();
    } catch { /* try again on the next round */ }
    schedulePoll();
  }, 5000);
}

// --- Upload (#97) ---

function bindUpload() {
  const btn = document.getElementById("adminSponsorUpload");
  const input = document.getElementById("adminSponsorFile");
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    for (const file of input.files) upload(file);
    input.value = "";
  });
}

async function upload(file) {
  const key = crypto.randomUUID();
  const name = file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Sponsorklipp";
  const entry = { name, loaded: 0, total: file.size, error: null };
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
    });
    data.clips.push(clip);
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

// --- The grid (#98, #99, #101) ---

function draw() {
  drawUploads();
  const sub = document.getElementById("adminRowSponsorsSub");
  const ready = data.clips.filter((c) => c.status === "ready").length;
  if (sub) sub.textContent = data.clips.length ? `${ready} klipp klara att visa` : "Klipp vid start, pauser och avslut";

  const root = document.getElementById("adminSponsors");
  if (!root) return;
  if (data.clips.length === 0) {
    root.innerHTML = `<p class="admin-empty">Inga sponsorklipp ännu. Ladda upp en film på högst 200 MB, till exempel en reklamfilm som MP4 eller MOV från telefonen.</p>`;
    return;
  }

  const sums = totals(data.clips);
  const grid = document.createElement("div");
  grid.className = "sponsor-grid";
  grid.setAttribute("role", "table");
  grid.setAttribute("aria-label", "Sponsorklipp och var de visas");

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
  for (const clip of data.clips) {
    body.append(clipRow(clip));
    if (clip.id === openId) body.append(detailPanel(clip));
  }
  grid.append(body);

  const total = document.createElement("div");
  total.className = "sponsor-row sponsor-foot";
  total.setAttribute("role", "row");
  total.innerHTML = `<span role="cell"></span><span role="cell" class="sponsor-foot-label">Totalt</span>
    ${SLOTS.map((s) => {
      const over = BREAKS.includes(s.id) && sums[s.id] > (data.breakSeconds[s.id] ?? Infinity);
      return `<span role="cell" class="sponsor-col${over ? " sponsor-over" : ""}">${clock(sums[s.id])}</span>`;
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

  root.replaceChildren(scroller, warnings(sums));
}

function clipRow(clip) {
  const row = document.createElement("div");
  row.className = "sponsor-row sponsor-clip";
  row.setAttribute("role", "row");
  row.dataset.id = clip.id;

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "sponsor-handle";
  handle.setAttribute("aria-label", `Flytta ${clip.name}. Dra, eller använd pil upp och ner.`);
  handle.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`;
  bindDrag(handle, row);
  const handleCell = document.createElement("span");
  handleCell.setAttribute("role", "cell");
  handleCell.className = "sponsor-handle-cell";
  handleCell.append(handle);

  const info = document.createElement("button");
  info.type = "button";
  info.className = "sponsor-info";
  info.setAttribute("role", "cell");
  info.setAttribute("aria-expanded", String(clip.id === openId));
  const status = clip.status === "ready"
    ? clock(clip.durationSeconds)
    : `<span class="sponsor-status sponsor-status-${clip.status}">${STATUS_TEXT[clip.status] ?? clip.status}</span>`;
  info.innerHTML = `<span class="sponsor-thumb"><img alt=""></span>
    <span class="sponsor-text"><span class="sponsor-name">${escapeHtml(clip.name)}</span><span class="sponsor-meta">${status}</span></span>`;
  loadThumb(info.querySelector("img"), clip.thumbnailUrl);
  info.addEventListener("click", () => {
    openId = openId === clip.id ? null : clip.id;
    draw();
  });

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
    if (sums[s.id] <= limit) continue;
    const p = document.createElement("p");
    p.className = "sponsor-warning";
    p.textContent = `${s.label}: Klippen är längre än pausen (${clock(sums[s.id])} mot ${clock(limit)}). Tittarna ser klart klippen och kommer tillbaka till matchen ${clock(sums[s.id] - limit)} för sent.`;
    box.append(p);
  }
  return box;
}

// --- Details: preview, rename, delete (#98) ---

function detailPanel(clip) {
  const panel = document.createElement("div");
  panel.className = "sponsor-detail";
  panel.setAttribute("role", "row");

  const media = clip.status === "ready"
    ? `<video class="sponsor-preview" controls playsinline preload="metadata"></video>`
    : clip.status === "failed"
      ? `<p class="sponsor-upload-error">${escapeHtml(clip.error || "Klippet kunde inte bearbetas.")}</p>`
      : `<p class="privacy-admin-intro">${STATUS_TEXT[clip.status]}. Förhandsvisningen kommer när klippet är klart.</p>`;

  panel.innerHTML = `<div role="cell" class="sponsor-detail-inner">
    ${media}
    <label class="invite-label" for="sponsorName-${clip.id}">Namn</label>
    <div class="sponsor-rename">
      <input class="invite-input" id="sponsorName-${clip.id}" maxlength="80" value="${escapeHtml(clip.name)}">
      <button class="admin-pair-btn" type="button" data-act="save">Spara</button>
    </div>
    <div class="sponsor-move" role="group" aria-label="Ordning">
      <button class="admin-pair-btn" type="button" data-act="up"${index(clip) === 0 ? " disabled" : ""}>Flytta upp</button>
      <button class="admin-pair-btn" type="button" data-act="down"${index(clip) === data.clips.length - 1 ? " disabled" : ""}>Flytta ner</button>
    </div>
    <button class="device-revoke sponsor-delete" type="button" data-act="delete">Ta bort klippet</button>
  </div>`;

  const video = panel.querySelector("video");
  if (video) startPreview(video, clip.hlsUrl);

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

  const del = panel.querySelector('[data-act="delete"]');
  del.addEventListener("click", async () => {
    // Same two-step confirm as removing a camera.
    if (del.dataset.confirm !== "1") {
      del.dataset.confirm = "1";
      del.textContent = "Tryck igen för att ta bort";
      setTimeout(() => { del.dataset.confirm = ""; del.textContent = "Ta bort klippet"; }, 4000);
      return;
    }
    try {
      await send("DELETE", `/api/admin/sponsors/${clip.id}`);
      data.clips = data.clips.filter((c) => c.id !== clip.id);
      openId = null;
      draw();
    } catch (err) {
      alert(`Kunde inte ta bort: ${err.message}`);
    }
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

// --- Order, by dragging (#100) ---

let dragging = false;

/**
 * Drag a row by its handle, with a finger or a mouse. The row follows the
 * pointer and the others make room; the new order is saved when it is let go.
 * Arrow keys on the handle do the same for the keyboard.
 */
function bindDrag(handle, row) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Listened for on the window: moving the row in the DOM releases any pointer capture.
    const pointer = e.pointerId;
    dragging = true;
    const body = row.parentElement;
    // The open details would sit between the rows being sorted.
    body.querySelector(".sponsor-detail")?.remove();
    openId = null;
    const startY = e.clientY;
    const startTop = row.offsetTop;
    const before = order();
    row.classList.add("sponsor-dragging");

    const move = (ev) => {
      if (ev.pointerId !== pointer) return;
      const rows = [...body.querySelectorAll(".sponsor-clip")].filter((r) => r !== row);
      // Where the row's middle would be, without the transform.
      const mid = startTop + (ev.clientY - startY) + row.offsetHeight / 2;
      const next = rows.find((r) => mid < r.offsetTop + r.offsetHeight / 2);
      if (next) { if (row.nextElementSibling !== next) body.insertBefore(row, next); }
      else if (body.lastElementChild !== row) body.append(row);
      // The row follows the pointer from wherever the DOM has put it.
      row.style.transform = `translateY(${ev.clientY - startY - (row.offsetTop - startTop)}px)`;
    };
    const up = (ev) => {
      if (ev.pointerId !== pointer) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      row.classList.remove("sponsor-dragging");
      row.style.transform = "";
      dragging = false;
      const after = order();
      if (after.join() !== before.join()) saveOrder(after);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });

  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    move(row.dataset.id, e.key === "ArrowUp" ? -1 : 1).then(() => {
      document.querySelector(`.sponsor-clip[data-id="${row.dataset.id}"] .sponsor-handle`)?.focus();
    });
  });
}

function index(clip) {
  return data.clips.findIndex((c) => c.id === clip.id);
}

/** Move one clip a step up (-1) or down (1) and save. */
async function move(id, step) {
  const ids = data.clips.map((c) => c.id);
  const i = ids.indexOf(id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await saveOrder(ids);
}

/** The clip ids in the order the rows are on screen. */
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
