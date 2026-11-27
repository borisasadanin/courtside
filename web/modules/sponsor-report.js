// === Rapport till sponsorer, in Hantera → Sponsring (#121, #142) ===
//
// What viewers saw of one sponsor in one season: per surface and per match,
// live and replay apart (GET /api/admin/sponsorship/report). Written for the
// club's volunteer who hands it to the sponsor: plain words, and a sheet that
// prints on A4 or saves as a PDF from the browser's print dialog.
//
// Viewers are counted per match. Someone who watched three matches is in
// each of them, so the page never adds them up over the season.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { deactivateAdmin } from "./admin.js";

/** The choices on the page, kept while the admin moves around in Hantera. */
let chosen = { sponsor: "", season: "" };
let sponsorsList = [];
let seasonStart = null;
let report = null;
let printBound = false;

async function send(method, path, body) {
  const headers = { "X-Admin-Token": state.adminToken };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${CONFIG.API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) {
    alert("Du har loggats ut från admin. Logga in igen med admin-koden.");
    deactivateAdmin();
    throw new Error(json.error || "Admin-åtkomst krävs");
  }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// --- Formatting ---

/** 0.873 → "87 %"; nothing to divide → "–". */
export function percent(rate) {
  return typeof rate === "number" && Number.isFinite(rate) ? `${Math.round(rate * 100)} %` : "–";
}

/** "2026-08-01" → "1 aug. 2026". */
export function day(date) {
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return date || "";
  return d.toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });
}

function number(n) {
  return (Number(n) || 0).toLocaleString("sv-SE");
}

function matchName(m) {
  if (m.homeTeam && m.awayTeam) return `${m.homeTeam} – ${m.awayTeam}`;
  return m.homeTeam || m.awayTeam || "Match";
}

// --- The page ---

export async function renderSponsorReport() {
  const root = document.getElementById("adminSponsorReport");
  if (!root) return;
  bindPrint();
  root.innerHTML = '<div class="spinner"></div>';
  try {
    const overview = await send("GET", "/api/admin/sponsorship");
    sponsorsList = overview.sponsors || [];
    seasonStart = overview.seasonStart ?? null;
  } catch (err) {
    root.innerHTML = `<p class="admin-empty">Kunde inte hämta sponsorerna (${escapeHtml(err.message)})</p>`;
    return;
  }
  if (sponsorsList.length === 0) {
    report = null;
    root.innerHTML = '<p class="admin-empty">Inga sponsorer ännu. Lägg till en sponsor under Sponsring först.</p>';
    return;
  }
  if (!sponsorsList.some((x) => x.id === chosen.sponsor)) chosen.sponsor = sponsorsList[0].id;
  await load(root);
}

async function load(root) {
  const q = new URLSearchParams({ sponsor: chosen.sponsor });
  if (chosen.season) q.set("season", chosen.season);
  try {
    report = await send("GET", `/api/admin/sponsorship/report?${q}`);
    chosen.season = report.season.id;
    seasonStart = report.seasonStart ?? seasonStart;
  } catch (err) {
    report = null;
    root.innerHTML = `<p class="admin-empty">Kunde inte hämta rapporten (${escapeHtml(err.message)})</p>`;
    return;
  }
  draw(root);
}

function draw(root) {
  const controls = document.createElement("div");
  controls.className = "sponsor-report-controls";
  controls.innerHTML = `
    <label class="sponsor-report-field">
      <span>Sponsor</span>
      <select class="sponsor-select" data-report="sponsor">
        ${sponsorsList.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join("")}
      </select>
    </label>
    <label class="sponsor-report-field">
      <span>Säsong</span>
      <select class="sponsor-select" data-report="season">
        ${(report.seasons || [report.season.id]).map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(seasonName(s))}</option>`).join("")}
      </select>
    </label>
    <button class="admin-pair-btn" type="button" data-report="print">Skriv ut / spara som PDF</button>`;
  controls.querySelector('[data-report="sponsor"]').value = chosen.sponsor;
  controls.querySelector('[data-report="season"]').value = chosen.season;
  controls.querySelector('[data-report="sponsor"]').addEventListener("change", (e) => {
    chosen.sponsor = e.target.value;
    load(root);
  });
  controls.querySelector('[data-report="season"]').addEventListener("change", (e) => {
    chosen.season = e.target.value;
    load(root);
  });
  controls.querySelector('[data-report="print"]').addEventListener("click", printReport);

  root.replaceChildren(controls, sheet(report), seasonStartSection(root));
}

function seasonName(id) {
  const next = String((Number(id) + 1) % 100).padStart(2, "0");
  return `${id}/${next}`;
}

/** The report itself: what is printed. */
function sheet(r) {
  const el = document.createElement("article");
  el.className = "sponsor-report-sheet";
  const live = sumLive(r.surfaces);
  const replayShown = r.surfaces.some((s) => s.replay.starts > 0 || s.replay.seen > 0);

  el.innerHTML = `
    <div class="sponsor-report-head">
      <p class="sponsor-report-eyebrow">Sponsorrapport</p>
      <h3 class="sponsor-report-title">${escapeHtml(r.sponsor.name)}</h3>
      <p class="sponsor-report-period">Säsong ${escapeHtml(r.season.label)} · ${escapeHtml(day(r.season.from))} – ${escapeHtml(day(r.season.to))}</p>
    </div>
    ${r.matches.length === 0
      ? `<p class="sponsor-report-empty">Inga matcher med ${escapeHtml(r.sponsor.name)} den här säsongen ännu. Antalen syns här när någon har sett sponsorns klipp i en sändning.</p>`
      : `
    <div class="sponsor-report-keys">
      ${key(number(r.matches.length), r.matches.length === 1 ? "match" : "matcher")}
      ${key(number(live.starts), "gånger klippen startade live")}
      ${key(percent(live.starts ? live.completes / live.starts : null), "sågs klart")}
      ${key(percent(live.starts ? live.sounds / live.starts : null), "spelades med ljud")}
    </div>

    <h4 class="sponsor-report-h">Live, per plats i matchen</h4>
    ${surfaceTable(r.surfaces, "live")}

    <h4 class="sponsor-report-h">Repriser</h4>
    ${replayShown ? surfaceTable(r.surfaces, "replay") : '<p class="sponsor-report-small">Inga sponsorklipp visades i repriser den här säsongen.</p>'}

    <h4 class="sponsor-report-h">Per match</h4>
    ${matchTable(r.matches)}
    `}

    <div class="sponsor-report-note">
      <p><strong>Så läser du rapporten.</strong> <em>Tittare</em> är hur många olika personer som såg sponsorn under en match.
      De räknas för varje match för sig: den som såg tre matcher räknas en gång i varje match. Tittarna från olika matcher
      kan därför inte läggas ihop till ett antal personer.</p>
      <p><em>Startade</em> är hur många gånger ett klipp började spela. <em>Sågs klart</em> och <em>med ljud</em> är hur stor
      del av dem som sågs till slutet och som spelades med ljudet på.</p>
    </div>
    <p class="sponsor-report-foot">Hämtad ${escapeHtml(day(new Date().toISOString().slice(0, 10)))}. Bara antal räknas, aldrig vem som tittade.</p>`;
  return el;
}

function key(value, label) {
  return `<div class="sponsor-report-key"><span class="sponsor-report-key-value">${escapeHtml(value)}</span><span class="sponsor-report-key-label">${escapeHtml(label)}</span></div>`;
}

function sumLive(surfaces) {
  return surfaces.reduce((t, s) => ({
    starts: t.starts + s.live.starts,
    completes: t.completes + s.live.completes,
    sounds: t.sounds + s.live.sounds,
  }), { starts: 0, completes: 0, sounds: 0 });
}

function surfaceTable(surfaces, mode) {
  const rows = surfaces.filter((s) => s[mode].starts > 0 || s[mode].seen > 0);
  return `<div class="sponsor-report-scroll"><table class="sponsor-report-table">
    <thead><tr><th>Plats</th><th class="num">Matcher</th><th class="num">Startade</th><th class="num">Sågs klart</th><th class="num">Med ljud</th></tr></thead>
    <tbody>${rows.map((s) => `<tr>
      <td class="nowrap">${escapeHtml(placeName(s))}</td>
      <td class="num">${number(s[mode].matches)}</td>
      <td class="num">${number(s[mode].starts)}</td>
      <td class="num">${percent(s[mode].completeRate)}</td>
      <td class="num">${percent(s[mode].soundRate)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

/** "Klipp vid start" → "Start", as the columns in Sponsring name them. */
const PLACES = { start: "Start", p1: "Paus 1", p2: "Paus 2", p3: "Paus 3", ot: "Övertid", end: "Avslut" };

function placeName(s) {
  return PLACES[s.id] || s.label || s.id;
}

function matchTable(matches) {
  return `<div class="sponsor-report-scroll"><table class="sponsor-report-table">
    <thead><tr>
      <th>Datum</th><th>Match</th>
      <th class="num">Tittare live</th><th class="num">Startade live</th><th class="num">Sågs klart</th><th class="num">Med ljud</th>
      <th class="num">Tittare repris</th>
    </tr></thead>
    <tbody>${matches.map((m) => {
      const live = m.surfaces.reduce((t, s) => ({
        starts: t.starts + s.live.starts, completes: t.completes + s.live.completes, sounds: t.sounds + s.live.sounds,
      }), { starts: 0, completes: 0, sounds: 0 });
      return `<tr>
        <td class="nowrap">${escapeHtml(day(m.date))}</td>
        <td>${escapeHtml(matchName(m))}</td>
        <td class="num">${number(m.viewers.live)}</td>
        <td class="num">${number(live.starts)}</td>
        <td class="num">${percent(live.starts ? live.completes / live.starts : null)}</td>
        <td class="num">${percent(live.starts ? live.sounds / live.starts : null)}</td>
        <td class="num">${number(m.viewers.replay)}</td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

/** Where the season starts: one date, whose day and month start every season. */
function seasonStartSection(root) {
  const box = document.createElement("section");
  box.className = "sponsor-section sponsor-report-season";
  box.innerHTML = `
    <h3 class="admin-section-title">Säsongen börjar</h3>
    <p class="privacy-admin-intro">Rapporten räknar en säsong i taget. Välj den dag säsongen börjar. Dag och månad gäller varje år. Utan datum börjar säsongen 1 augusti.</p>
    <div class="sponsor-report-season-row">
      <input type="date" class="sponsor-select" aria-label="Säsongen börjar" value="${escapeHtml(seasonStart || "")}">
      <button class="admin-pair-btn admin-pair-btn-secondary" type="button">Spara</button>
    </div>
    <p class="sponsor-report-small" role="status"></p>`;
  const input = box.querySelector("input");
  const button = box.querySelector("button");
  const status = box.querySelector('[role="status"]');
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "";
    try {
      const res = await send("PATCH", "/api/admin/sponsorship/season", { seasonStart: input.value || null });
      seasonStart = res.seasonStart;
      // Today's season may be another one now.
      chosen.season = "";
      await load(root);
    } catch (err) {
      status.textContent = err.message;
      button.disabled = false;
    }
  });
  return box;
}

// --- Printing (#142) ---

/**
 * Only the sheet is printed: a copy of it goes at the top of <body>, and the
 * print CSS hides everything else while the class is on. Cmd+P on this page
 * does the same as the button.
 */
function preparePrint() {
  const page = document.querySelector('[data-admin-page="sponsor-report"]');
  const sheetEl = document.querySelector("#adminSponsorReport .sponsor-report-sheet");
  if (!page || page.classList.contains("hidden") || !sheetEl) return false;
  let holder = document.getElementById("sponsorReportPrint");
  if (!holder) {
    holder = document.createElement("div");
    holder.id = "sponsorReportPrint";
    holder.className = "sponsor-report-print";
    document.body.append(holder);
  }
  holder.replaceChildren(sheetEl.cloneNode(true));
  document.documentElement.classList.add("print-sponsor-report");
  return true;
}

function printReport() {
  if (preparePrint()) window.print();
}

function bindPrint() {
  if (printBound) return;
  printBound = true;
  window.addEventListener("beforeprint", preparePrint);
  window.addEventListener("afterprint", () => {
    document.documentElement.classList.remove("print-sponsor-report");
  });
}
