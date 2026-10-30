// === VOD module ===
// VOD list fetching, rendering, polling.
// Groups recordings and highlight clips by match (date + teams).

import { CONFIG } from "./config.js";
import { state, dom } from "./state.js";
import { escapeHtml, formatDuration, formatDateFull, mediaUrl } from "./utils.js";
import { authHeaders, showPinScreen } from "./auth.js";
import { openVodPlayer } from "./player.js";
import { fetchAllClips, playClip } from "./highlights.js";
import { copyClipLink, setClipHash } from "./deeplink.js";

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
 * Grouping key: matchDate + homeTeam + awayTeam (all lowercased).
 * Clips are attached to their group via streamId → vod → group.
 * Orphan clips (from live streams not yet in VOD index) get their own group.
 */
function groupByMatch(vods, clips) {
  const groups = new Map(); // key → MatchGroup

  // Build groups from VOD entries
  for (const vod of vods) {
    const key = [
      vod.matchDate || "",
      (vod.homeTeam || "").toLowerCase(),
      (vod.awayTeam || "").toLowerCase(),
    ].join("|");

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        matchTitle: vod.matchTitle || "Inspelning",
        matchDate: vod.matchDate || "",
        location: vod.location || "",
        homeTeam: vod.homeTeam || "",
        awayTeam: vod.awayTeam || "",
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

  // Sort recordings within each group oldest→newest (kamera 1 before kamera 2)
  for (const group of groups.values()) {
    group.recordings.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

// ============================
// Rendering
// ============================

function renderVodList(vods, clips) {
  const groups = groupByMatch(vods, clips ?? []);

  if (groups.length === 0) {
    dom.vodGrid.innerHTML = "";
    dom.vodGrid.classList.add("hidden");
    dom.vodEmptyState.classList.remove("hidden");
    return;
  }

  dom.vodEmptyState.classList.add("hidden");
  dom.vodGrid.classList.remove("hidden");
  dom.vodGrid.replaceChildren();

  for (let i = 0; i < groups.length; i++) {
    if (i > 0) {
      dom.vodGrid.appendChild(createMatchSeparator());
    }
    dom.vodGrid.appendChild(createMatchGroup(groups[i]));
  }
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

  // ── Header ──────────────────────────────────────────────
  const header = document.createElement("div");
  header.className = "match-group-header";

  // "MATCH" eyebrow label (not shown for orphan group)
  if (group.key !== "__orphan__") {
    const eyebrow = document.createElement("span");
    eyebrow.className = "match-eyebrow";
    eyebrow.textContent = "MATCH";
    header.appendChild(eyebrow);
  }

  const title = document.createElement("h3");
  title.className = "match-group-title";
  title.textContent = group.matchTitle;
  header.appendChild(title);

  // Date + location subtitle
  const subtitleParts = [];
  if (group.matchDate) subtitleParts.push(formatDateFull(group.matchDate));
  if (group.location)  subtitleParts.push(escapeHtml(group.location));
  if (subtitleParts.length > 0) {
    const sub = document.createElement("p");
    sub.className = "match-group-date";
    sub.textContent = subtitleParts.join(" · ");
    header.appendChild(sub);
  }

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
    const hlSection = document.createElement("div");
    hlSection.className = "match-highlights";

    const labelEl = document.createElement("div");
    labelEl.className = "match-highlights-label";
    labelEl.innerHTML =
      `<svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent)" aria-hidden="true">` +
      `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>` +
      `</svg> HÖJDPUNKTER ` +
      `<span class="match-highlights-count">${group.clips.length}</span>`;
    hlSection.appendChild(labelEl);

    const chips = document.createElement("div");
    chips.className = "match-highlights-chips";
    group.clips.forEach((clip, i) => {
      chips.appendChild(createClipCard(clip, i));
    });
    hlSection.appendChild(chips);

    el.appendChild(hlSection);
  }

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
    `<span class="clip-chip-num">${STAR_SVG} ${index + 1}</span>` +
    `<span class="clip-chip-time">${escapeHtml(time)}</span>` +
    `<span class="clip-chip-dur">${escapeHtml(dur)}</span>`;

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
  const [vods, clips] = await Promise.all([fetchVod(), fetchAllClips()]);
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
