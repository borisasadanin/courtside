// === Replay markers module ===
// Highlight, period and timeout markers on a replay's progress bar, and the
// P1 · P2 · ★ row under the player for jumping by touch or keyboard (ABL-046).

import { CONFIG } from "./config.js";
import { dom } from "./state.js";
import { authHeaders } from "./auth.js";
import { fetchClipsForStream } from "./highlights.js";
import { escapeHtml, formatTime, mediaUrl } from "./utils.js";
import { t } from "./i18n.js";

/** Clips made before ABL-046 start about this long before they were saved (CLIP_DURATION_SECONDS in the API). */
const CLIP_SECONDS = 8;

const STAR_SVG =
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
  `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>` +
  `</svg>`;

/** Bumped on every open and close, so a slow load cannot draw on another replay. */
let generation = 0;
/** What the open replay knows: pause types and clips from the API, fragments from the playlist. */
let current = null;

// ============================
// Loading
// ============================

/** Start loading markers for a replay. The fragments arrive separately, from the player. */
export function loadReplayMarkers(vodId) {
  clearReplayMarkers();
  const gen = generation;
  current = { vodId, pauses: [], clips: [], frags: null, duration: 0 };

  fetch(`${CONFIG.API_URL}/api/vod/${encodeURIComponent(vodId)}`, { headers: authHeaders() })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((vod) => {
      if (gen !== generation) return;
      current.pauses = Array.isArray(vod?.pauses) ? vod.pauses : [];
      render();
    });

  fetchClipsForStream(vodId).then(async (clips) => {
    if (gen !== generation) return;
    current.clips = clips;
    render();
    // Clips made before ABL-046 do not say where they start, but their own
    // playlist does: its first segment is a segment of the recording.
    const older = clips.filter((c) => !c.startSegment && c.hlsUrl);
    if (older.length === 0) return;
    await Promise.all(older.map(async (clip) => {
      try {
        const res = await fetch(mediaUrl(clip.hlsUrl));
        if (res.ok) clip.startSegment = playlistFragments(await res.text())[0]?.file;
      } catch { /* falls back to the save time */ }
    }));
    if (gen === generation) render();
  });
}

/**
 * The replay's fragments, from hls.js or from the playlist itself.
 * @param {{ start: number, duration: number, uri: string, pdt?: number|null }[]} frags
 */
export function setReplayFragments(frags, duration) {
  if (!current) return;
  current.frags = frags.map((f) => ({ ...f, file: fileName(f.uri) }));
  current.duration = duration;
  render();
}

/** For players without hls.js (Safari's own HLS): read the fragments from the playlist. */
export async function fetchReplayFragments(playlistUrl) {
  const gen = generation;
  try {
    const res = await fetch(playlistUrl, { headers: authHeaders() });
    if (!res.ok || gen !== generation) return;
    const frags = playlistFragments(await res.text());
    const last = frags[frags.length - 1];
    setReplayFragments(frags, last ? last.start + last.duration : 0);
  } catch {
    // No markers; the replay plays as before
  }
}

export function clearReplayMarkers() {
  generation++;
  current = null;
  dom.progressBar.querySelectorAll(".replay-marker, .replay-marker-tip").forEach((el) => el.remove());
  const nav = document.getElementById("replayNav");
  if (nav) {
    nav.innerHTML = "";
    nav.classList.add("hidden");
  }
}

/** Fragments of an HLS media playlist with their start times. */
function playlistFragments(text) {
  const frags = [];
  let start = 0;
  let duration = null;
  let pdt = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      pdt = Date.parse(line.slice(25));
    } else if (line && !line.startsWith("#") && duration !== null) {
      frags.push({ start, duration, uri: line, file: fileName(line), pdt: isNaN(pdt) ? null : pdt });
      start += duration;
      duration = null;
      pdt = null;
    }
  }
  return frags;
}

function fileName(uri) {
  return uri.split("?")[0].split("/").pop();
}

// ============================
// Where things are in the replay
// ============================

/**
 * Period starts, timeouts and highlights, in seconds into the replay.
 * Pause segments are named pause{n}; the recording says which were timeouts.
 * Recordings from before pause types count every pause as a period break, as the API does.
 */
function layout() {
  const { frags, pauses, clips } = current;
  const typeOf = new Map(pauses.map((p) => [p.n, p.type]));

  const pauseSpans = new Map();
  for (const f of frags) {
    const m = /^pause(\d+)_/.exec(f.file);
    if (!m) continue;
    const span = pauseSpans.get(m[1]) ?? { n: Number(m[1]), start: f.start, end: f.start };
    span.end = f.start + f.duration;
    pauseSpans.set(m[1], span);
  }

  const periods = [{ number: 1, start: 0 }];
  const timeouts = [];
  for (const span of [...pauseSpans.values()].sort((a, b) => a.start - b.start)) {
    if (typeOf.get(span.n) === "timeout") {
      timeouts.push({ start: span.start });
    } else {
      // The period starts where play does, after the pause card
      periods.push({ number: periods.length + 1, start: span.end });
    }
  }

  const byFile = new Map(frags.map((f) => [f.file, f]));
  const highlights = [];
  for (const clip of clips) {
    const start = clipStart(clip, byFile, frags);
    if (start !== null) highlights.push({ clip, start });
  }
  highlights.sort((a, b) => a.start - b.start);
  highlights.forEach((h, i) => { h.number = i + 1; });

  return { periods, timeouts, highlights };
}

/** Where a clip starts: its first segment, or failing that its save time minus its length. */
function clipStart(clip, byFile, frags) {
  const first = clip.startSegment && byFile.get(clip.startSegment);
  if (first) return first.start;

  // Approximate, and only possible where the playlist carries wall-clock times
  const at = Date.parse(clip.createdAt) - CLIP_SECONDS * 1000;
  let match = null;
  for (const f of frags) {
    if (f.pdt != null && f.pdt <= at) match = f;
  }
  if (!match || at > match.pdt + (match.duration + CLIP_SECONDS) * 1000) return null;
  return match.start + Math.min(match.duration, (at - match.pdt) / 1000);
}

// ============================
// Drawing
// ============================

function render() {
  if (!current?.frags || !current.duration) return;
  const { periods, timeouts, highlights } = layout();
  renderBarMarkers(periods, timeouts, highlights);
  renderNav(periods, highlights);
}

function renderBarMarkers(periods, timeouts, highlights) {
  const bar = dom.progressBar;
  bar.querySelectorAll(".replay-marker, .replay-marker-tip").forEach((el) => el.remove());

  const tip = document.createElement("div");
  tip.className = "replay-marker-tip";
  tip.hidden = true;

  // The row under the player is the keyboard and screen-reader way to jump;
  // these are a pointer shortcut, kept out of the tab order.
  const add = (kind, start, label, clip) => {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `replay-marker replay-marker-${kind}`;
    marker.tabIndex = -1;
    marker.setAttribute("aria-label", `${label}, ${formatTime(start)}`);
    marker.style.left = pct(start) + "%";
    if (kind === "highlight") marker.innerHTML = STAR_SVG;

    // Seeking from the bar starts on mousedown; a marker seeks to its own time instead
    marker.addEventListener("mousedown", (e) => e.stopPropagation());
    marker.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      tip.hidden = true;
      seek(start);
    });
    marker.addEventListener("mouseenter", () => showTip(tip, start, label, clip));
    marker.addEventListener("mouseleave", () => { tip.hidden = true; });
    bar.appendChild(marker);
  };

  // The first period starts at 0:00: no marker needed there
  for (const p of periods.slice(1)) add("period", p.start, t("replay-markers.period", { n: p.number }));
  for (const to of timeouts) add("timeout", to.start, t("replay-markers.timeout"));
  for (const h of highlights) add("highlight", h.start, h.clip.label || t("replay-markers.highlight", { n: h.number }), h.clip);
  bar.appendChild(tip);
}

function showTip(tip, start, label, clip) {
  const thumb = clip?.thumbnailUrl
    ? `<img src="${escapeHtml(mediaUrl(clip.thumbnailUrl))}" alt="" loading="lazy">`
    : "";
  tip.innerHTML = `${thumb}<span>${escapeHtml(label)}</span><span class="replay-marker-tip-time">${formatTime(start)}</span>`;
  const at = pct(start);
  tip.style.left = at + "%";
  // Keep the tip inside the player near either end
  tip.dataset.edge = at < 12 ? "start" : at > 88 ? "end" : "";
  tip.hidden = false;
}

function renderNav(periods, highlights) {
  const nav = document.getElementById("replayNav");
  if (!nav) return;
  const listOpen = nav.querySelector(".replay-nav-star")?.getAttribute("aria-expanded") === "true";
  nav.innerHTML = "";
  if (periods.length < 2 && highlights.length === 0) {
    nav.classList.add("hidden");
    return;
  }

  const row = document.createElement("div");
  row.className = "replay-nav-row";

  if (periods.length > 1) {
    for (const p of periods) {
      // The label starts with the visible text, so voice control finds it
      const btn = navButton(`P${p.number}`, t("replay-markers.periodButton", { n: p.number, time: formatTime(p.start) }));
      btn.classList.add("replay-nav-period");
      btn.dataset.start = String(p.start);
      btn.addEventListener("click", () => seek(p.start));
      row.appendChild(btn);
    }
  }

  if (highlights.length > 0) {
    const star = navButton("", t("replay-markers.highlights", { n: highlights.length }));
    star.classList.add("replay-nav-star");
    star.innerHTML = `${STAR_SVG}<span>${highlights.length}</span>`;
    star.setAttribute("aria-controls", "replayHighlights");
    star.setAttribute("aria-expanded", String(listOpen));
    row.appendChild(star);

    const list = document.createElement("ol");
    list.className = "replay-highlights";
    list.id = "replayHighlights";
    list.hidden = !listOpen;
    for (const h of highlights) {
      const li = document.createElement("li");
      const btn = navButton("");
      const label = h.clip.label || t("replay-markers.highlight", { n: h.number });
      btn.innerHTML =
        `<span class="replay-highlights-num">${STAR_SVG}${h.number}</span>` +
        `<span class="replay-highlights-label">${escapeHtml(label)}</span>` +
        `<span class="replay-highlights-time">${formatTime(h.start)}</span>`;
      btn.addEventListener("click", () => seek(h.start));
      li.appendChild(btn);
      list.appendChild(li);
    }

    star.addEventListener("click", () => {
      const open = star.getAttribute("aria-expanded") !== "true";
      star.setAttribute("aria-expanded", String(open));
      list.hidden = !open;
    });

    nav.appendChild(row);
    nav.appendChild(list);
  } else {
    nav.appendChild(row);
  }

  nav.classList.remove("hidden");
  markCurrentPeriod();
}

function navButton(text, label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "replay-nav-btn";
  btn.textContent = text;
  if (label) btn.setAttribute("aria-label", label);
  return btn;
}

/** Which period is playing, for the row's P buttons. */
function markCurrentPeriod() {
  const buttons = document.querySelectorAll("#replayNav .replay-nav-period");
  if (buttons.length === 0) return;
  const t = dom.video.currentTime || 0;
  let currentIdx = 0;
  buttons.forEach((btn, i) => {
    if (t >= Number(btn.dataset.start) - 0.5) currentIdx = i;
  });
  buttons.forEach((btn, i) => {
    if (i === currentIdx) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
  });
}

function pct(seconds) {
  return Math.max(0, Math.min(100, (seconds / current.duration) * 100));
}

function seek(seconds) {
  dom.video.currentTime = seconds;
  if (dom.video.paused) dom.video.play().catch(() => {});
}

// ============================
// Init
// ============================

export function initReplayMarkers() {
  dom.video.addEventListener("timeupdate", () => {
    if (current) markCurrentPeriod();
  });

  // Space and Enter belong to the focused button here, not to the player's
  // play/pause shortcut on the document.
  document.getElementById("replayNav")?.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") e.stopPropagation();
  });
}
