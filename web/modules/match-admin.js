// === Matches, in Hantera ===
//
// The club's schedule (ABL-048), entered by hand: own team, opponent, date,
// and optionally time and place. Teams come from the registry (Lag); a new one
// can be added right here, with a logo if one is at hand. Upcoming matches
// first, played ones folded away below.
//
// A match with recordings can be changed (a misspelt team is then fixed on its
// replays too) but not removed here: its recordings are removed under
// Inspelningar, where the deletion log applies.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { deactivateAdmin } from "./admin.js";
import { resize } from "./branding.js";
import { club } from "./club.js";
import { setTeams, getTeams, teamBadge } from "./teams.js";
import { setMatches, localToday, formatMatchWhen } from "./matches.js";
import { guestSpaceForMatch, openGuestSpace } from "./guest-admin.js";

/** The match whose form is open, kept open across a reload of the list. */
let openId = null;

/** Select value for a team typed into the form rather than picked. */
const NEW_TEAM = "__new__";

function adminHeaders(json) {
  const h = { "X-Admin-Token": state.adminToken };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function send(method, path, body) {
  const res = await fetch(`${CONFIG.API_URL}${path}`, {
    method,
    headers: adminHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401) {
    alert("Du har loggats ut från admin. Logga in igen med admin-koden.");
    deactivateAdmin();
    throw new Error(data.error || "Admin-åtkomst krävs");
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Load the schedule and the teams, and draw the list, the add form and the row in Hantera. */
export async function renderMatchesAdmin() {
  const list = document.getElementById("adminMatchList");
  if (!list) return;
  bindAdd();

  let matches;
  try {
    const [matchRes, teamRes] = await Promise.all([
      fetch(`${CONFIG.API_URL}/api/matches`, { headers: adminHeaders(false) }),
      fetch(`${CONFIG.API_URL}/api/teams`, { headers: adminHeaders(false) }),
    ]);
    if (!matchRes.ok) throw new Error(`HTTP ${matchRes.status}`);
    if (teamRes.ok) setTeams(await teamRes.json());
    matches = setMatches(await matchRes.json());
  } catch (err) {
    list.innerHTML = `<p class="admin-empty">Kunde inte hämta matcherna (${escapeHtml(err.message)})</p>`;
    return;
  }

  // Upcoming: today or later and not over. A match on now stays here until it ends.
  const today = localToday();
  const upcoming = matches.filter((m) => m.date >= today && m.status !== "ended");
  const played = matches.filter((m) => !upcoming.includes(m)).reverse();

  const sub = document.getElementById("adminRowMatchesSub");
  if (sub) sub.textContent = upcoming.length ? `${upcoming.length} kommande` : "Inga kommande matcher";

  if (matches.length === 0) {
    list.innerHTML = `<p class="admin-empty">Inga matcher ännu. Lägg in kommande matcher, så ser tittarna när nästa match spelas och kan lägga in den i kalendern.</p>`;
    return;
  }

  list.replaceChildren();
  list.append(heading("Kommande"));
  if (upcoming.length) list.append(...upcoming.map(matchRow));
  else list.append(Object.assign(document.createElement("p"), { className: "admin-empty", textContent: "Inga kommande matcher." }));

  if (played.length) {
    const details = document.createElement("details");
    details.className = "match-played";
    details.open = played.some((m) => m.id === openId);
    const summary = document.createElement("summary");
    summary.textContent = `Spelade matcher (${played.length})`;
    details.append(summary, ...played.map(matchRow));
    list.append(details);
  }
}

function heading(text) {
  const h = document.createElement("p");
  h.className = "admin-eyebrow team-group";
  h.textContent = text;
  return h;
}

function bindAdd() {
  const btn = document.getElementById("adminMatchAdd");
  const panel = document.getElementById("adminMatchAddPanel");
  if (!btn || !panel || btn.dataset.bound) return;
  btn.dataset.bound = "1";

  btn.addEventListener("click", () => {
    panel.classList.remove("hidden");
    panel.replaceChildren(matchForm(null, () => panel.classList.add("hidden")));
    panel.querySelector("select")?.focus();
  });
}

/** One match: the two teams, when and where, what it has; and a form to change it. */
function matchRow(match) {
  const wrap = document.createElement("div");
  wrap.className = "match-item";

  const row = document.createElement("div");
  row.className = "device-row match-row";
  const badges = document.createElement("span");
  badges.className = "match-row-badges";
  badges.append(teamBadge(match.ownTeam, { size: "sm" }), teamBadge(match.opponent, { size: "sm" }));

  const meta = [formatMatchWhen(match)];
  if (match.venue) meta.push(match.venue);
  if (match.status === "live") meta.push("sänds nu");
  const n = match.recordingIds.length;
  if (n && match.status !== "live") meta.push(n === 1 ? "1 inspelning" : `${n} inspelningar`);
  if (match.result) meta.push(`${match.result.home}–${match.result.away}`);

  const info = document.createElement("div");
  info.className = "device-info";
  info.innerHTML = `
    <span class="device-name">${escapeHtml(match.ownTeam.name)} – ${escapeHtml(match.opponent.name)}</span>
    <span class="device-meta">${meta.map(escapeHtml).join(" · ")}</span>`;
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "device-revoke";
  edit.textContent = "Ändra";
  row.append(badges, info, edit);

  // The match's guest space (#55), only when it has one.
  guestSpaceForMatch(match).then((space) => {
    if (!space) return;
    const link = document.createElement("button");
    link.type = "button";
    link.className = "branding-link match-guest-link";
    link.textContent = "Gästyta";
    link.addEventListener("click", () => openGuestSpace(space.id, "matches"));
    info.append(link);
  });

  const form = matchForm(match, () => {
    openId = null;
    form.classList.add("hidden");
  });
  form.classList.add("match-edit");
  form.classList.toggle("hidden", openId !== match.id);
  edit.addEventListener("click", () => {
    const opening = form.classList.contains("hidden");
    openId = opening ? match.id : null;
    form.classList.toggle("hidden", !opening);
  });

  wrap.append(row, form);
  return wrap;
}

/** <option>s for every team, the side's own kind first, then "Nytt lag…". */
function teamOptions(own) {
  const teams = getTeams();
  const first = teams.filter((t) => t.own === own);
  const rest = teams.filter((t) => t.own !== own);
  const group = (label, list) => list.length
    ? `<optgroup label="${label}">${list.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("")}</optgroup>`
    : "";
  return `<option value="">Välj lag…</option>` +
    group(own ? "Egna lag" : "Motståndare", first) +
    group(own ? "Andra lag" : "Egna lag", rest) +
    `<option value="${NEW_TEAM}">Nytt lag…</option>`;
}

/** One side of the match: pick a team, or type a new one and optionally give it a logo. */
function teamField(label, side, team) {
  const own = side === "own";
  const field = document.createElement("div");
  field.className = "match-team";
  field.innerHTML = `
    <label class="branding-field">${label}
      <select name="${side}">${teamOptions(own)}</select>
    </label>
    <div class="match-new-team hidden">
      <label class="branding-field">Nytt lag
        <input type="text" name="${side}Name" maxlength="60" autocomplete="off" placeholder="${own ? "t.ex. P12" : "t.ex. Hornets"}">
      </label>
      <div class="match-logo">
        <button type="button" class="branding-link" data-action="pick">Lägg till logga (valfritt)</button>
        <input type="file" accept="image/*" class="visually-hidden-file">
        <span class="match-logo-name"></span>
      </div>
    </div>`;

  const select = field.querySelector("select");
  const name = field.querySelector('input[type="text"]');
  const newTeam = field.querySelector(".match-new-team");
  const known = team && team.id && getTeams().some((t) => t.id === team.id);
  if (known) {
    select.value = team.id;
  } else if (team) {
    // A team the registry no longer has: typed again, it is added back.
    select.value = NEW_TEAM;
    name.value = team.name;
  } else if (own) {
    const ownTeams = getTeams().filter((t) => t.own);
    if (ownTeams.length === 1) select.value = ownTeams[0].id;
    else if (getTeams().length === 0) select.value = NEW_TEAM;
  }
  const showNew = () => newTeam.classList.toggle("hidden", select.value !== NEW_TEAM);
  select.addEventListener("change", () => {
    showNew();
    if (select.value === NEW_TEAM) name.focus();
  });
  showNew();

  // Same file picking as the club logo: a hidden input opened from a button (Safari).
  let logo = null;
  const input = field.querySelector('input[type="file"]');
  const pick = field.querySelector('[data-action="pick"]');
  const picked = field.querySelector(".match-logo-name");
  pick.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    logo = input.files?.[0] || null;
    input.value = "";
    picked.textContent = logo ? logo.name : "";
    pick.textContent = logo ? "Byt logga" : "Lägg till logga (valfritt)";
  });

  return {
    el: field,
    /** Whether the side names a team. */
    ok: () => (select.value === NEW_TEAM ? name.value.trim() !== "" : select.value !== ""),
    /** What the API takes for this side. */
    body: () => (select.value === NEW_TEAM
      ? { [`${own ? "ownTeam" : "opponent"}Name`]: name.value.trim() }
      : { [`${own ? "ownTeam" : "opponent"}Id`]: select.value }),
    /** A logo chosen for a team typed here. */
    logo: () => (select.value === NEW_TEAM ? logo : null),
  };
}

/** Add a match (match null) or change one. done() closes the form. */
function matchForm(match, done) {
  const form = document.createElement("form");
  form.className = "admin-branding match-form";
  form.noValidate = true;

  const own = teamField("Eget lag", "own", match?.ownTeam);
  const opponent = teamField("Motståndare", "opponent", match?.opponent);
  const teamsRow = document.createElement("div");
  teamsRow.className = "match-form-row";
  teamsRow.append(own.el, opponent.el);

  const rest = document.createElement("div");
  rest.className = "admin-branding";
  const canRemove = match && match.recordingIds.length === 0;
  rest.innerHTML = `
    <div class="match-form-row">
      <label class="branding-field">Datum
        <input type="date" name="date" required value="${escapeHtml(match?.date ?? "")}">
      </label>
      <label class="branding-field">Tid (valfri)
        <input type="time" name="time" value="${escapeHtml(match?.time ?? "")}">
      </label>
    </div>
    <label class="branding-field">Plats
      <input type="text" name="venue" maxlength="80" autocomplete="off" value="${escapeHtml(match ? match.venue ?? "" : club.venue)}">
    </label>
    ${match && !canRemove ? `<p class="privacy-admin-intro">Matchen har inspelningar och kan inte tas bort här. Inspelningarna tas bort under Inspelningar. Det du ändrar här ändras också på inspelningarna.</p>` : ""}
    <div class="branding-save-row">
      <button class="admin-pair-btn" type="submit">${match ? "Spara" : "Lägg till"}</button>
      <button class="branding-link" type="button" data-action="cancel">Avbryt</button>
      ${canRemove ? '<button class="device-revoke" type="button" data-action="delete">Ta bort match</button>' : ""}
      <span class="branding-status" role="status"></span>
    </div>`;
  form.append(teamsRow, rest);

  const date = form.querySelector('input[name="date"]');
  const time = form.querySelector('input[name="time"]');
  const venue = form.querySelector('input[name="venue"]');
  const save = form.querySelector('[type="submit"]');
  const status = form.querySelector(".branding-status");
  const say = (text, isError = false) => {
    status.textContent = text;
    status.classList.toggle("error", isError);
  };

  // Teams and date are required; time and place are not.
  const refresh = () => { save.disabled = !(own.ok() && opponent.ok() && date.value); };
  form.addEventListener("input", refresh);
  form.addEventListener("change", refresh);
  refresh();

  form.querySelector('[data-action="cancel"]').addEventListener("click", done);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (save.disabled) return;
    const body = { ...own.body(), ...opponent.body(), date: date.value, time: time.value, venue: venue.value };
    save.disabled = true;
    say("Sparar…");
    let saved;
    try {
      saved = await send(match ? "PUT" : "POST", match ? `/api/admin/matches/${encodeURIComponent(match.id)}` : "/api/admin/matches", body);
    } catch (err) {
      say(err.message, true);
      refresh();
      return;
    }

    // A logo for a team typed here goes to that team, once the match has made it.
    const failed = [];
    for (const [side, team] of [[own, saved.ownTeam], [opponent, saved.opponent]]) {
      const file = side.logo();
      if (!file || !team.id) continue;
      try {
        await send("PUT", `/api/admin/teams/${encodeURIComponent(team.id)}/logo`, { dataUrl: await resize(file) });
      } catch (err) {
        failed.push(`${team.name}: ${err.message}`);
      }
    }

    openId = match ? match.id : null;
    if (!match) done();
    await renderMatchesAdmin();
    if (failed.length) alert(`Matchen är sparad, men loggan kunde inte laddas upp (${failed.join("; ")}). Ladda upp den under Lag.`);
  });

  // Two clicks, like removing a team.
  const del = form.querySelector('[data-action="delete"]');
  del?.addEventListener("click", async () => {
    if (del.dataset.confirm !== "1") {
      del.dataset.confirm = "1";
      del.textContent = "Säker?";
      setTimeout(() => {
        del.dataset.confirm = "";
        del.textContent = "Ta bort match";
      }, 4000);
      return;
    }
    say("Tar bort…");
    try {
      await send("DELETE", `/api/admin/matches/${encodeURIComponent(match.id)}`);
      openId = null;
      await renderMatchesAdmin();
    } catch (err) {
      say(err.message, true);
    }
  });

  return form;
}
