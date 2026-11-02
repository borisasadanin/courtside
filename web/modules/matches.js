// === Match schedule ===
//
// The club's matches (ABL-048), as GET /api/matches gives them:
//
//   { id, date: "YYYY-MM-DD", time?: "HH:MM", venue?, ownTeam, opponent,
//     status: "planned" | "live" | "ended", recordingIds: [...],
//     result?: { home, away }, source: "admin" | "camera" }
//
// ownTeam is always the club's side (homeTeam on the recordings). Both teams
// have the registry's shape (id, name, shortName, color, own, logoUrl?), so
// teamBadge() takes them as they are. A team the registry no longer has comes
// with id "".
//
// loadMatches() keeps the list for a minute; findMatch(id) looks in it. The
// rest formats a match for people and calendars.

import { CONFIG } from "./config.js";
import { state } from "./state.js";
import { t } from "./i18n.js";

/** How long a loaded schedule is used before it is fetched again (ms). */
const MAX_AGE_MS = 60000;

let matches = [];
let byId = new Map();
let loadedAt = 0;
let loading = null;

/**
 * Every match, by date and time. Fetched at most once a minute; pass
 * { force: true } after a change. Never rejects: without the schedule the
 * pages just show no matches.
 */
export function loadMatches({ force = false } = {}) {
  if (loading) return loading;
  if (!force && loadedAt && Date.now() - loadedAt < MAX_AGE_MS) return Promise.resolve(matches);
  const headers = {};
  if (state.viewerToken) headers["Authorization"] = `Bearer ${state.viewerToken}`;
  if (state.adminToken) headers["X-Admin-Token"] = state.adminToken;
  loading = fetch(`${CONFIG.API_URL}/api/matches`, { headers })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((list) => {
      loading = null;
      return setMatches(list);
    })
    .catch((err) => {
      loading = null;
      console.warn("[matches] Could not load the schedule:", err.message);
      return matches;
    });
  return loading;
}

/** Replace the cached list, e.g. with one the admin view just fetched. */
export function setMatches(list) {
  matches = Array.isArray(list) ? list : [];
  byId = new Map(matches.map((m) => [m.id, m]));
  loadedAt = Date.now();
  return matches;
}

/** The cached list, empty until loadMatches() has finished. */
export function getMatches() {
  return matches;
}

/** The match with this id, or null. Call loadMatches() first. */
export function findMatch(id) {
  return (id && byId.get(id)) || null;
}

/** Today as YYYY-MM-DD, on this device. */
export function localToday(at = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * Matches still to be played: not started, today or later, soonest first. A
 * match today stays here all day, also after its time, until a camera starts it.
 */
export function upcomingMatches(list = matches, today = localToday()) {
  return list.filter((m) => m.status === "planned" && m.date >= today);
}

const WEEKDAYS = t("matches.weekdays").split(" ");
const MONTHS = t("matches.months").split(" ");

/** The date as a Date at noon, so no time zone moves it to another day. */
function dayOf(date) {
  return new Date(`${date}T12:00:00`);
}

/** "lör 8 nov 14:00", "i dag 14:00", "i morgon"; just the date when there is no time. */
export function formatMatchWhen(match, today = localToday()) {
  const d = dayOf(match.date);
  const tomorrow = new Date(dayOf(today).getTime() + 86400000);
  const day = match.date === today
    ? t("matches.today")
    : match.date === localToday(tomorrow)
      ? t("matches.tomorrow")
      : t("matches.day", { weekday: WEEKDAYS[d.getDay()], day: d.getDate(), month: MONTHS[d.getMonth()] });
  return match.time ? `${day} ${match.time}` : day;
}

/**
 * "lör 8 nov 14:00 mot Hornets, Sporthallen". With { withOwnTeam: true }, for
 * a club with several teams: "lör 8 nov 14:00 P12 mot Hornets, Sporthallen".
 */
export function describeMatch(match, { withOwnTeam = false, today } = {}) {
  const teams = withOwnTeam
    ? t("matches.ownAgainst", { own: match.ownTeam.name, opponent: match.opponent.name })
    : t("matches.against", { opponent: match.opponent.name });
  return `${formatMatchWhen(match, today)} ${teams}${match.venue ? `, ${match.venue}` : ""}`;
}

/** Whether matches in the list are played by more than one of the club's teams. */
export function severalOwnTeams(list) {
  return new Set(list.map((m) => m.ownTeam.id || m.ownTeam.name)).size > 1;
}

// --- Calendar ---
//
// An .ics file made here, so it needs no request the calendar app would have
// to make with the viewer code. Times are local ("floating"): the match is at
// 14:00 where the viewer is, which for a club's own matches is the same place.

/** How long a match with a time is put in the calendar for (minutes). */
const MATCH_MINUTES = 120;

function icsText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Fold a content line at 75 octets, as the format asks. */
function fold(line) {
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const code = ch.codePointAt(0);
    const n = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + n > 75) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

function icsDate(d) {
  return localToday(d).replace(/-/g, "");
}

function icsDateTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${icsDate(d)}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

/** The match as an iCalendar file. A match without a time is an all-day event. */
export function matchIcs(match, { url = location.origin, clubName = "" } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Courtside//Matchschema//SV",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${match.id}@${location.host || "courtside"}`,
    `DTSTAMP:${stamp}`,
  ];
  if (match.time) {
    const start = new Date(`${match.date}T${match.time}:00`);
    const end = new Date(start.getTime() + MATCH_MINUTES * 60000);
    lines.push(`DTSTART:${icsDateTime(start)}`, `DTEND:${icsDateTime(end)}`);
  } else {
    const day = dayOf(match.date);
    lines.push(`DTSTART;VALUE=DATE:${icsDate(day)}`, `DTEND;VALUE=DATE:${icsDate(new Date(day.getTime() + 86400000))}`);
  }
  lines.push(`SUMMARY:${icsText(t("matches.icsSummary", { own: match.ownTeam.name, opponent: match.opponent.name }))}`);
  if (match.venue) lines.push(`LOCATION:${icsText(match.venue)}`);
  lines.push(`DESCRIPTION:${icsText(`${clubName ? `${clubName}. ` : ""}${t("matches.icsDescription", { url })}`)}`);
  if (url) lines.push(`URL:${url}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Hand the match to the device's calendar as an .ics download. */
export function downloadIcs(match, options) {
  const blob = new Blob([matchIcs(match, options)], { type: "text/calendar;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `match-${match.date}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}
