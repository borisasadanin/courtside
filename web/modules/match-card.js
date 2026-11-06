// === Match cards ===
//
// One look for a match wherever it shows (ABL-049): live, coming up and played.
//
//   [logo] Älta  –  Hornets [logo]
//   LIVE  Period 2 · 14 tittare             (live)
//   lör 8 nov 14:00 · Sporthallen           (coming up)
//   72 – 65 · lör 1 nov · Sporthallen       (played)
//
// The club's own team is on the left, as in the titles. Nothing marks a win or
// a loss. Screen readers get the match as one sentence ("Älta mot Hornets,
// live, period 2") instead of the badges and dots.
//
// The filter per team ("Alla · P12 · F14") goes above the replays and the
// coming matches when more than one of the club's teams is in the list.

import { teamFor, teamBadge, teamKey } from "./teams.js";
import { formatMatchWhen, localToday } from "./matches.js";
import { t, locale } from "./i18n.js";

/**
 * A match's two teams, own team first: the schedule's, or else the names on
 * the recording (one camera, no schedule). Null when the names are not known.
 */
export function matchTeams(match, homeTeam, awayTeam) {
  if (match) return { own: match.ownTeam, opponent: match.opponent };
  if (!homeTeam || !awayTeam) return null;
  return { own: teamFor(homeTeam), opponent: teamFor(awayTeam) };
}

/** "Älta mot Hornets" */
export function spokenTeams(teams) {
  return t("match-card.spokenTeams", { own: teams.own.name, opponent: teams.opponent.name });
}

/** "Älta – Hornets", for the player's title. */
export function matchName(teams) {
  return `${teams.own.name} – ${teams.opponent.name}`;
}

/**
 * The head of a match card: the teams, then the status line.
 *
 * tag     "h3" for a card of its own, "span" inside a button (a live card).
 * pill    { text, cls } — a status label at the start of the line ("LIVE"),
 *         drawn like the live card's badges (stream-card-badge).
 * parts   the rest of the line, joined with " · ": strings or nodes (the score);
 *         empty ones are left out.
 * spoken  what a screen reader says for the whole head.
 */
export function matchHead(teams, { tag = "h3", pill, parts = [], spoken }) {
  const inline = tag === "span";
  const head = document.createElement(inline ? "span" : "div");
  head.className = "mc-head";

  const title = document.createElement(tag);
  title.className = "mc-title";
  const said = document.createElement("span");
  said.className = "sr-only";
  said.textContent = spoken || spokenTeams(teams);
  const row = document.createElement("span");
  row.className = "mc-teams";
  row.setAttribute("aria-hidden", "true");
  row.append(teamSide(teams.own, "own"), dash(), teamSide(teams.opponent, "opponent"));
  title.append(said, row);

  const status = document.createElement(inline ? "span" : "p");
  status.className = "mc-status";
  status.setAttribute("aria-hidden", "true");
  if (pill) {
    const label = document.createElement("span");
    label.className = `stream-card-badge mc-pill ${pill.cls}`;
    label.textContent = pill.text;
    status.append(label);
  }
  for (const part of parts) {
    if (!part) continue;
    const item = document.createElement("span");
    item.className = "mc-part";
    item.append(part);
    status.append(item);
  }

  head.append(title, status);
  return head;
}

function teamSide(team, side) {
  const el = document.createElement("span");
  el.className = `mc-team mc-${side}`;
  const name = document.createElement("span");
  name.className = "mc-name";
  name.textContent = team.name;
  const badge = teamBadge(team, { size: "md" });
  if (side === "own") el.append(badge, name);
  else el.append(name, badge);
  return el;
}

function dash() {
  const el = document.createElement("span");
  el.className = "mc-dash";
  el.textContent = "–";
  return el;
}

// --- Dates ---

/** "lör 1 nov", with the year when it is not this year's. */
export function playedOn(date, today = localToday()) {
  const day = formatMatchWhen({ date }, today);
  return date.slice(0, 4) === today.slice(0, 4) ? day : `${day} ${date.slice(0, 4)}`;
}

/** "lördag 8 november 14:00", or "i dag 14:00": the date written out, for screen readers. */
export function spokenWhen(match, today = localToday()) {
  const short = formatMatchWhen({ date: match.date }, today);
  const day = short === t("matches.today") || short === t("matches.tomorrow")
    ? short
    : new Date(`${match.date}T12:00:00`).toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long" });
  return match.time ? `${day} ${match.time}` : day;
}

/** The head of a match still to be played: "lör 8 nov 14:00 · Sporthallen". */
export function upcomingHead(match, { pill } = {}) {
  const teams = matchTeams(match);
  const spoken = [spokenTeams(teams), pill?.spoken, spokenWhen(match), match.venue].filter(Boolean).join(", ");
  return matchHead(teams, { pill, parts: [formatMatchWhen(match), match.venue], spoken });
}

// ============================
// Filter per team
// ============================

const FILTER_KEY = "teamFilter";
/** Fired on document when the viewer picks a team in either list. */
export const TEAM_FILTER_EVENT = "courtside:teamfilter";
/** The choice when the browser keeps no storage (private mode, blocked). */
let remembered = null;

function chosenTeam() {
  try {
    const stored = localStorage.getItem(FILTER_KEY);
    if (stored !== null) return stored;
  } catch {
    // No storage: the choice lasts while the page is open
  }
  return remembered;
}

function chooseTeam(key) {
  remembered = key || null;
  try {
    if (key) localStorage.setItem(FILTER_KEY, key);
    else localStorage.removeItem(FILTER_KEY);
  } catch {
    // As above
  }
}

/** How the filter knows a team: by id, or by name for one not in the registry. */
function filterKey(team) {
  return team.id ? `id:${team.id}` : `name:${teamKey(team.name)}`;
}

/**
 * The filter per team over a list. ownOf(item) gives the item's own team, or
 * null. With fewer than two own teams in the list there is no filter: `row` is
 * null and every item is shown. Under a team, an item without one is left out.
 * A choice of a team that is not in this list shows all of it, and is kept for
 * the next list it is in.
 *
 * Returns { row, shown, chosen, keys }; onChange runs after the viewer picks.
 */
export function teamFilter(items, ownOf, onChange) {
  const teams = new Map();
  for (const item of items) {
    const team = ownOf(item);
    if (team?.name && !teams.has(filterKey(team))) teams.set(filterKey(team), team.name);
  }
  if (teams.size < 2) return { row: null, shown: items, chosen: "", keys: [] };

  const stored = chosenTeam();
  const chosen = stored && teams.has(stored) ? stored : "";
  const shown = chosen
    ? items.filter((item) => {
      const team = ownOf(item);
      return team?.name && filterKey(team) === chosen;
    })
    : items;
  // Team names are the club's own (Swedish), so they sort the Swedish way in either language.
  const options = [...teams].sort((a, b) => a[1].localeCompare(b[1], "sv", { numeric: true }));
  return { row: filterRow([["", t("match-card.filterAll")], ...options], chosen, onChange), shown, chosen, keys: options.map(([k]) => k) };
}

function filterRow(options, chosen, onChange) {
  const row = document.createElement("div");
  row.className = "team-filter";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", t("match-card.filterLabel"));
  for (const [key, name] of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "team-filter-btn";
    btn.dataset.teamFilter = key;
    btn.textContent = name;
    btn.setAttribute("aria-pressed", String(key === chosen));
    btn.addEventListener("click", () => {
      if (key === chosen) return;
      const container = row.parentElement;
      chooseTeam(key);
      onChange();
      // Repriser and the upcoming list share the choice; the other one redraws too.
      document.dispatchEvent(new CustomEvent(TEAM_FILTER_EVENT));
      if (container) focusTeamFilter(container, key);
    });
    row.append(btn);
  }
  return row;
}

/** The filter button a viewer is on, so a list rebuilt under them keeps their place. */
export function focusedTeamFilter() {
  const el = document.activeElement;
  return el?.classList?.contains("team-filter-btn") ? el.dataset.teamFilter : null;
}

export function focusTeamFilter(container, key) {
  if (key === null || key === undefined) return;
  for (const btn of container.querySelectorAll(".team-filter-btn")) {
    if (btn.dataset.teamFilter === key) {
      btn.focus();
      return;
    }
  }
}
