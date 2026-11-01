// === VOD module ===
// VOD list fetching, rendering, polling.
// Groups recordings and highlight clips by match: the match in the schedule
// (ABL-048), or date + teams for recordings made before it.

import { CONFIG } from "./config.js";
import { state, dom } from "./state.js";
import { escapeHtml, formatDuration, mediaUrl } from "./utils.js";
import { authHeaders, showPinScreen } from "./auth.js";
import { openVodPlayer } from "./player.js";
import { fetchAllClips, playClip } from "./highlights.js";
import { copyClipLink, copyMatchLink, setClipHash } from "./deeplink.js";
import { showImage } from "./images.js";
import { loadMatches, findMatch } from "./matches.js";
import { loadTeams, teamBadge } from "./teams.js";
import { matchTeams, matchHead, spokenTeams, playedOn, teamFilter, focusedTeamFilter, focusTeamFilter, TEAM_FILTER_EVENT } from "./match-card.js";

// ============================
// Fetch
// ============================

async function fetchVod() {
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/vod`, {
      headers: authHeaders(),
    });
    if (res.status === 401) {
      state.viewerToken = null;
      localStorage.removeItem("viewerToken");
      showPinScreen();
      return null;
    }
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch {
    return null;
  }
}

// ============================
// Grouping
// ============================

/**
 * Group VOD entries and clips into match groups.
 * Grouping key: the recording's match id; for recordings made before the
 * schedule, matchDate + homeTeam + awayTeam (all lowercased).
 * Clips are attached to their group via streamId → vod → group.
 * Orphan clips (from live streams not yet in VOD index) get their own group.
 *
 * A group of a match in the schedule carries it as `match` (see matches.js),
 * and takes its teams, date and venue from it; otherwise `match` is null.
 */
function groupByMatch(vods, clips) {
  const groups = new Map(); // key → MatchGroup

  // Build groups from VOD entries
  for (const vod of vods) {
    const key = vod.matchId
      ? `match:${vod.matchId}`
      : [
        vod.matchDate || "",
        (vod.homeTeam || "").toLowerCase(),
        (vod.awayTeam || "").toLowerCase(),
      ].join("|");

    if (!groups.has(key)) {
      const match = findMatch(vod.matchId);
      groups.set(key, {
        key,
        matchId: vod.matchId || null,
        match,
        ...matchHeading(vod, match),
        recordings: [],
        clips: [],
        latestAt: vod.stoppedAt || vod.createdAt,
      });
    }

    const group = groups.get(key);
    group.recordings.push(vod);

    // Track the most recent timestamp for sorting groups
    const ts = vod.stoppedAt || vod.createdAt;
    if (ts > group.latestAt) group.latestAt = ts;
  }

  // Sort recordings within each group oldest→newest (kamera 1 before kamera 2).
  // The match's result is the newest one reported: a broadcast restarted
  // mid-match leaves an older recording with an earlier score, or none.
  for (const group of groups.values()) {
    group.recordings.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const reported = group.recordings.filter((r) => r.result);
    group.result = reported.length ? reported[reported.length - 1].result : null;
    group.cover = matchCover(group.recordings);
  }

  // Map streamId → group key for clip assignment
  const streamToGroup = new Map();
  for (const [key, group] of groups) {
    for (const vod of group.recordings) {
      streamToGroup.set(vod.id, key);
    }
  }

  // Assign clips to their group; collect orphans separately
  const orphanClips = [];
  for (const clip of clips) {
    const groupKey = streamToGroup.get(clip.streamId);
    if (groupKey) {
      groups.get(groupKey).clips.push(clip);
    } else {
      orphanClips.push(clip);
    }
  }

  // Sort clips within each group oldest→newest (chronological order)
  for (const group of groups.values()) {
    group.clips.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Sort groups newest→oldest by latestAt
  const sorted = [...groups.values()].sort((a, b) =>
    b.latestAt.localeCompare(a.latestAt)
  );

  // Prepend orphan group if any orphan clips exist (live match in progress)
  if (orphanClips.length > 0) {
    orphanClips.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    sorted.unshift({
      key: "__orphan__",
      matchId: null,
      match: null,
      matchTitle: "Pågående match",
      matchDate: "",
      location: "",
      homeTeam: "",
      awayTeam: "",
      recordings: [],
      clips: orphanClips,
      latestAt: orphanClips[orphanClips.length - 1].createdAt,
    });
  }

  return sorted;
}

/**
 * What a match's header shows: the match in the schedule as it is now (a team
 * renamed in Lag, a misspelling fixed in Matcher), or else the recording's own
 * text. A title written by hand is kept.
 */
function matchHeading(vod, match) {
  const heading = {
    matchTitle: vod.matchTitle || "Inspelning",
    matchDate: vod.matchDate || "",
    location: vod.location || "",
    homeTeam: vod.homeTeam || "",
    awayTeam: vod.awayTeam || "",
  };
  if (!match) return heading;
  const titleIsTeams = vod.matchTitle === `${vod.homeTeam} vs ${vod.awayTeam}`;
  return {
    matchTitle: titleIsTeams ? `${match.ownTeam.name} vs ${match.opponent.name}` : heading.matchTitle,
    matchDate: match.date,
    location: match.venue || "",
    homeTeam: match.ownTeam.name,
    awayTeam: match.opponent.name,
  };
}

/** Cover sources, best first. The admin's choice wins over a camera's first highlight. */
const COVER_RANK = { chosen: 0, highlight: 1, frame: 2 };

/**
 * The match's cover: the best one any of its recordings has, the first camera's
 * on a tie. Without one the card draws the two teams' badges instead.
 */
function matchCover(recordings) {
  const covers = recordings.map((r) => r.cover).filter((c) => c && c.source in COVER_RANK);
  covers.sort((a, b) => COVER_RANK[a.source] - COVER_RANK[b.source]);
  return covers[0] ?? null;
}

// ============================
// Highlights open or folded
// ============================
//
// The list is rebuilt on every poll, so whether a match's highlights are open
// is kept here rather than in the DOM. It is keyed by stream id: a match in
// progress is the "Pågående match" group and gets its real key only when it
// stops, but its streams stay the same.

/** streamId → true (open) / false (folded), for matches the viewer toggled. */
const highlightsChoice = new Map();
/** Streams seen live on this page, so their match stays open after it ends. */
const seenLive = new Set();

function groupStreamIds(group) {
  const ids = new Set(group.recordings.map((r) => r.id));
  for (const clip of group.clips) ids.add(clip.streamId);
  return [...ids];
}

/** A match in progress is open; a finished one is folded, unless the viewer said otherwise. */
function highlightsOpen(group, streamIds) {
  for (const id of streamIds) {
    if (highlightsChoice.has(id)) return highlightsChoice.get(id);
  }
  return group.key === "__orphan__" || streamIds.some((id) => seenLive.has(id));
}

// ============================
// Rendering
// ============================

/** The list as last drawn, to draw it again when the team filter changes elsewhere. */
let lastVodList = null;
document.addEventListener(TEAM_FILTER_EVENT, () => {
  if (lastVodList) renderVodList(...lastVodList);
});

function renderVodList(vods, clips) {
  lastVodList = [vods, clips];
  const groups = groupByMatch(vods, clips ?? []);
  // Polling rebuilds the list; a viewer on a highlights toggle or the team
  // filter keeps their place.
  const focused = document.activeElement?.dataset?.highlightsFor;
  const focusedFilter = focusedTeamFilter();

  if (groups.length === 0) {
    dom.vodGrid.innerHTML = "";
    dom.vodGrid.classList.add("hidden");
    dom.vodEmptyState.classList.remove("hidden");
    return;
  }

  // "Alla · P12 · F14" when the club has more than one team in the list
  for (const group of groups) {
    group.teams = group.key === "__orphan__" ? null : matchTeams(group.match, group.homeTeam, group.awayTeam);
  }
  const filter = teamFilter(groups, (g) => g.teams?.own, () => renderVodList(vods, clips));

  dom.vodEmptyState.classList.add("hidden");
  dom.vodGrid.classList.remove("hidden");
  dom.vodGrid.replaceChildren();
  if (filter.row) dom.vodGrid.appendChild(filter.row);

  filter.shown.forEach((group, i) => {
    if (i > 0) {
      dom.vodGrid.appendChild(createMatchSeparator());
    }
    dom.vodGrid.appendChild(createMatchGroup(group));
  });

  if (focused) {
    dom.vodGrid.querySelector(`[data-highlights-for="${focused}"]`)?.focus();
  }
  focusTeamFilter(dom.vodGrid, focusedFilter);
}

/** Thin gold line between match sections */
function createMatchSeparator() {
  const el = document.createElement("div");
  el.className = "match-separator";
  return el;
}

function createMatchGroup(group) {
  const el = document.createElement("div");
  el.className = "match-group";
  if (group.matchId) el.dataset.matchId = group.matchId;
  const teams = group.teams;

  if (group.recordings.length > 0) {
    if (group.cover) el.appendChild(createCover(group));
    else if (teams) el.appendChild(createTeamsCover(group, teams));
  }

  // ── Header ──────────────────────────────────────────────
  const header = document.createElement("div");
  header.className = "match-group-header";
  const heading = document.createElement("div");
  heading.className = "match-group-heading";
  header.appendChild(heading);

  // A title written by hand ("Seriefinal") is kept above the teams.
  const titleIsTeams = group.homeTeam && group.awayTeam &&
    group.matchTitle === `${group.homeTeam} vs ${group.awayTeam}`;

  if (teams) {
    if (!titleIsTeams && group.matchTitle) {
      const eyebrow = document.createElement("span");
      eyebrow.className = "match-eyebrow";
      eyebrow.textContent = group.matchTitle;
      heading.appendChild(eyebrow);
    }
    heading.appendChild(createReplayHead(group, teams));
  } else {
    // No teams to show: the orphan group, or a recording without names
    const title = document.createElement("h3");
    title.className = "match-group-title";
    title.textContent = group.matchTitle;
    heading.appendChild(title);
    const subtitleParts = [];
    if (group.matchDate) subtitleParts.push(playedOn(group.matchDate));
    if (group.location) subtitleParts.push(group.location);
    if (subtitleParts.length > 0) {
      const sub = document.createElement("p");
      sub.className = "match-group-date";
      sub.textContent = subtitleParts.join(" · ");
      heading.appendChild(sub);
    }
  }

  if (group.matchId && teams) header.appendChild(createMatchShare(group, teams));

  el.appendChild(header);

  // ── Recordings ──────────────────────────────────────────
  if (group.recordings.length > 0) {
    const recSection = document.createElement("div");
    recSection.className = "match-recordings";
    group.recordings.forEach((vod, i) => {
      recSection.appendChild(createRecordingCard(vod, i));
    });
    el.appendChild(recSection);
  }

  // ── Highlights ──────────────────────────────────────────
  if (group.clips.length > 0) {
    el.appendChild(createHighlightsSection(group));
  }

  return el;
}

/**
 * The match's cover picture. Tapping it plays the first recording; it is hidden
 * from screen readers, for whom the Spela button already does that.
 */
function createCover(group) {
  const cover = document.createElement("div");
  cover.className = "match-cover";
  cover.setAttribute("aria-hidden", "true");
  const img = document.createElement("img");
  img.alt = "";
  cover.appendChild(img);

  const first = group.recordings[0];
  cover.addEventListener("click", () => {
    openVodPlayer(first.hlsUrl, first.matchTitle, first.id);
  });
  showImage(img, group.cover.url, { onFail: () => cover.remove() });
  return cover;
}

/**
 * The teams, then "72 – 65 · lör 1 nov · Sporthallen". The score is the
 * newest one reported for the match (ABL-041), in the club's tone win or lose.
 */
function createReplayHead(group, teams) {
  const result = group.result;
  const spoken = [
    spokenTeams(teams),
    result && `resultat ${result.home} mot ${result.away}`,
    group.matchDate && new Date(`${group.matchDate}T12:00:00`)
      .toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    group.location,
  ].filter(Boolean).join(", ");
  return matchHead(teams, {
    parts: [result && createScore(result), group.matchDate && playedOn(group.matchDate), group.location],
    spoken,
  });
}

/**
 * In place of a cover: the two teams' badges on the drawn court. Like a cover,
 * tapping it plays the first recording, and screen readers skip it.
 */
function createTeamsCover(group, teams) {
  const cover = document.createElement("div");
  cover.className = "match-cover match-cover-teams";
  cover.setAttribute("aria-hidden", "true");
  const dash = document.createElement("span");
  dash.className = "match-cover-dash";
  dash.textContent = "\u2013";
  cover.append(teamBadge(teams.own, { size: "lg" }), dash, teamBadge(teams.opponent, { size: "lg" }));

  const first = group.recordings[0];
  cover.addEventListener("click", () => {
    openVodPlayer(first.hlsUrl, first.matchTitle, first.id);
  });
  return cover;
}

/** Copies a link to the match, like a highlight's share button (the page behind it is ABL-050's). */
function createMatchShare(group, teams) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "clip-share-btn match-share-btn";
  btn.setAttribute("aria-label", `Dela ${spokenTeams(teams)}`);
  btn.title = "Kopiera länk";
  btn.innerHTML = SHARE_SVG;
  btn.addEventListener("click", async () => {
    const ok = await copyMatchLink(group.matchId);
    if (ok) {
      btn.classList.add("clip-share-copied");
      btn.innerHTML = "&#10003;";
      setTimeout(() => {
        btn.classList.remove("clip-share-copied");
        btn.innerHTML = SHARE_SVG;
      }, 1500);
    }
  });
  return btn;
}

/** "★ HÖJDPUNKTER 7 ›" — a toggle over the match's highlight chips. */
function createHighlightsSection(group) {
  const hlSection = document.createElement("div");
  hlSection.className = "match-highlights";

  const streamIds = groupStreamIds(group);
  if (group.key === "__orphan__") streamIds.forEach((id) => seenLive.add(id));
  // Stream ids are hex, so the first one makes a safe element id.
  const key = group.key === "__orphan__" ? "live" : streamIds[0];
  const open = highlightsOpen(group, streamIds);
  const count = group.clips.length;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "match-highlights-label";
  toggle.dataset.highlightsFor = key;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-controls", `highlights-${key}`);
  toggle.setAttribute("aria-label", count === 1 ? "1 höjdpunkt" : `${count} höjdpunkter`);
  toggle.innerHTML =
    `<svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent-ink)" aria-hidden="true">` +
    `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>` +
    `</svg> HÖJDPUNKTER ` +
    `<span class="match-highlights-count">${count}</span>` +
    `<svg class="match-highlights-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<polyline points="9 18 15 12 9 6"/></svg>`;
  hlSection.appendChild(toggle);

  const chips = document.createElement("div");
  chips.className = "match-highlights-chips";
  chips.id = `highlights-${key}`;
  chips.hidden = !open;
  group.clips.forEach((clip, i) => {
    chips.appendChild(createClipCard(clip, i));
  });
  hlSection.appendChild(chips);

  toggle.addEventListener("click", () => {
    const nowOpen = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(nowOpen));
    chips.hidden = !nowOpen;
    streamIds.forEach((id) => highlightsChoice.set(id, nowOpen));
  });

  return hlSection;
}

/** "72 – 65", own team first. */
function createScore(result) {
  const el = document.createElement("span");
  el.className = "match-score";
  el.textContent = `${result.home}\u2009\u2013\u2009${result.away}`;
  return el;
}

// ── SVG icons ──────────────────────────────────────────────

const CAMERA_SVG =
  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ` +
  `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>` +
  `</svg>`;

const PLAY_SVG =
  `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
  `<polygon points="5 3 19 12 5 21 5 3"/>` +
  `</svg>`;

const STAR_SVG =
  `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
  `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>` +
  `</svg>`;

const SHARE_SVG =
  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>` +
  `<line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>` +
  `</svg>`;

const DOWNLOAD_SVG =
  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>` +
  `</svg>`;

/** Large card for a main recording (one per camera) */
function createRecordingCard(vod, index) {
  const btn = document.createElement("button");
  btn.className = "recording-card";
  const name = vod.cameraName || `Kamera ${index + 1}`;
  btn.setAttribute("aria-label", `Spela ${escapeHtml(name)}`);

  const duration = formatDuration(vod.durationSeconds);

  btn.innerHTML =
    `<span class="recording-card-icon">${CAMERA_SVG}</span>` +
    `<span class="recording-card-name">${escapeHtml(name)}</span>` +
    (duration ? `<span class="recording-card-dur">${escapeHtml(duration)}</span>` : "") +
    `<span class="recording-card-play">${PLAY_SVG} Spela</span>`;

  btn.addEventListener("click", () => {
    openVodPlayer(vod.hlsUrl, vod.matchTitle, vod.id);
  });

  return btn;
}

/** Smaller card for a highlight clip, with share button */
function createClipCard(clip, index) {
  const wrapper = document.createElement("div");
  wrapper.className = "clip-chip-wrapper";

  const btn = document.createElement("button");
  btn.className = "clip-chip";
  const label = clip.label || `Höjdpunkt ${index + 1}`;
  btn.setAttribute("aria-label", label);
  btn.title = label;

  const time = formatClipTime(clip.createdAt);
  const dur = `${Math.round(clip.durationSeconds)}s`;

  btn.innerHTML =
    (clip.thumbnailUrl ? `<span class="clip-chip-thumb"><img alt=""></span>` : "") +
    `<span class="clip-chip-num">${STAR_SVG} ${index + 1}</span>` +
    `<span class="clip-chip-time">${escapeHtml(time)}</span>` +
    `<span class="clip-chip-dur">${escapeHtml(dur)}</span>`;

  // The clip's thumbnail. Without one the chip is text only, as before.
  if (clip.thumbnailUrl) {
    btn.classList.add("has-thumb");
    const thumb = btn.querySelector(".clip-chip-thumb");
    showImage(thumb.firstChild, clip.thumbnailUrl, {
      onFail: () => {
        thumb.remove();
        btn.classList.remove("has-thumb");
      },
    });
  }

  btn.addEventListener("click", () => {
    setClipHash(clip.id);
    playClip(clip.hlsUrl);
  });

  // Share button
  const shareBtn = document.createElement("button");
  shareBtn.className = "clip-share-btn";
  shareBtn.setAttribute("aria-label", `Dela ${label}`);
  shareBtn.title = "Kopiera länk";
  shareBtn.innerHTML = SHARE_SVG;

  shareBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await copyClipLink(clip.id);
    if (ok) {
      shareBtn.classList.add("clip-share-copied");
      shareBtn.innerHTML = "&#10003;";
      setTimeout(() => {
        shareBtn.classList.remove("clip-share-copied");
        shareBtn.innerHTML = SHARE_SVG;
      }, 1500);
    }
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(shareBtn);

  // Download button (only if MP4 is available). The MP4 is behind the PIN:
  // only a shared clip's segments and thumbnail open without it.
  if (clip.mp4Url) {
    const dlBtn = document.createElement("button");
    dlBtn.className = "clip-share-btn clip-download-btn";
    dlBtn.setAttribute("aria-label", `Ladda ner ${label}`);
    dlBtn.title = "Ladda ner";
    dlBtn.innerHTML = DOWNLOAD_SVG;

    dlBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      dlBtn.disabled = true;
      dlBtn.innerHTML = "&#8987;";
      try {
        const res = await fetch(mediaUrl(clip.mp4Url), { headers: authHeaders() });
        if (!res.ok) throw new Error(res.status);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${label}.mp4`;
        a.click();
        URL.revokeObjectURL(url);
        dlBtn.innerHTML = DOWNLOAD_SVG;
      } catch {
        dlBtn.textContent = "!";
        dlBtn.title = "Kunde inte ladda ner";
        setTimeout(() => { dlBtn.innerHTML = DOWNLOAD_SVG; dlBtn.title = "Ladda ner"; }, 2000);
      }
      dlBtn.disabled = false;
    });

    wrapper.appendChild(dlBtn);
  }

  return wrapper;
}

function formatClipTime(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// ============================
// Polling
// ============================

async function pollVodList() {
  // The schedule and the teams only name the matches: without them the list
  // still groups by match id, with the names the recordings carry.
  const [vods, clips] = await Promise.all([fetchVod(), fetchAllClips(), loadMatches(), loadTeams()]);
  if (vods !== null) {
    renderVodList(vods, clips ?? []);
  }
}

export function startVodPolling() {
  clearInterval(state.vodPollTimer);
  pollVodList();
  state.vodPollTimer = setInterval(pollVodList, CONFIG.VOD_POLL_INTERVAL);
}

export function stopVodPolling() {
  clearInterval(state.vodPollTimer);
}

// ============================
// Init
// ============================

export function initVod() {
  // No special init needed — polling is started by the orchestrator
}
