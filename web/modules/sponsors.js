// === Sponsor clips in the player (#87, phase 4) ===
//
// The club's sponsor films, played live in the viewer's own player: when the
// match starts, in the period breaks, in overtime and when it ends. They are
// never in the broadcast itself, so replays have none.
//
//   - playSponsorReel(): the clips one after another in the same <video> as
//     the match, under the banner "<team> är sponsrat av:", with no way to
//     seek or skip. Sound follows the viewer's choice (sound.js). (#106)
//   - which surface a change of status shows, and that each one is shown at
//     most once per viewer, a reload included. (#107)
//   - what the viewer saw, for the sponsor's report: a clip started, was
//     watched to the end, played with sound. Only from a clip that plays. (#140)
//
// The clips must never stand in the way of the match: a clip that will not
// load or play is skipped, and when none play the reel is simply over.

import Hls from "hls.js";
import { CONFIG } from "./config.js";
import { dom } from "./state.js";
import { authHeaders } from "./auth.js";
import { mediaUrl } from "./utils.js";
import { playWithSound } from "./sound.js";
import { getViewerId } from "./viewer-id.js";

/** A clip that has not started this long after loading is skipped. */
const LOAD_TIMEOUT_MS = 15_000;
/** A clip whose picture stands still this long while not paused is skipped. */
const STALL_TIMEOUT_MS = 15_000;

// ============================
// Which clips, when (#107)
// ============================

/**
 * Fetch the clips of one surface: start, p1, p2, p3, ot or end. Null when
 * there is nothing to show or they could not be fetched, which is the same
 * thing to the viewer.
 */
export async function fetchSponsorReel(surface, streamId) {
  try {
    const q = new URLSearchParams({ surface });
    if (streamId) q.set("stream", streamId);
    const res = await fetch(`${CONFIG.API_URL}/api/sponsors/play?${q}`, { headers: authHeaders() });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body.clips) && body.clips.length > 0 ? body : null;
  } catch {
    return null;
  }
}

const PLAYED_KEY = "courtside-sponsors-played";
/** Old entries are dropped after this, so the list does not grow for ever. */
const PLAYED_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function readPlayed() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYED_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/**
 * Claim one transition: true the first time this viewer gets here for this
 * key, false every time after, a reload included. The key names the stream,
 * the surface and, for overtime that can come more than once, the period.
 */
export function claimTransition(key) {
  const played = readPlayed();
  if (played[key]) return false;
  const now = Date.now();
  for (const [k, at] of Object.entries(played)) if (now - at > PLAYED_TTL_MS) delete played[k];
  played[key] = now;
  try { localStorage.setItem(PLAYED_KEY, JSON.stringify(played)); } catch { /* kept for this page only */ }
  return true;
}

/** Whether a transition has been shown already, without claiming it. */
export function transitionClaimed(key) {
  return Boolean(readPlayed()[key]);
}

/**
 * A viewer who opens the page while a match is already going gets no start
 * clips: only someone who was here before it went live does. The first
 * stream list after the page opens says which matches were going then;
 * streams the player itself has seen waiting count as not going.
 */
let runningAtLoad = null;
const seenWaiting = new Set();
/**
 * Streams seen live or paused. A stream is "waiting" again for a moment when
 * the camera comes back from a pause, and that must not count as the match
 * starting: start clips would then play in the second period.
 */
const seenGoing = new Set();

function going(s) {
  return s && (s.status === "live" || s.status === "paused");
}

/** Call with every stream list. Only the first one says what was going at load. */
export function noteStreamList(streams) {
  if (!Array.isArray(streams)) return;
  for (const s of streams) if (going(s)) seenGoing.add(s.id);
  if (runningAtLoad) return;
  runningAtLoad = new Set(streams.filter(going).map((s) => s.id));
}

/** Call with every stream the player fetches: waiting before it ever went live counts as seeing it start. */
export function noteStreamStatus(stream) {
  if (!stream?.id) return;
  if (going(stream)) seenGoing.add(stream.id);
  else if (stream.status === "waiting" && !seenGoing.has(stream.id)) seenWaiting.add(stream.id);
}

/** Whether the viewer was here before this stream went live. */
export function sawStreamStart(streamId) {
  if (seenWaiting.has(streamId)) return true;
  return runningAtLoad !== null && !runningAtLoad.has(streamId);
}

// ============================
// What the viewer saw (#140)
// ============================

/**
 * Tell the server one thing that happened to a clip. The viewer's id goes in
 * the body, never in the address. Fire and forget: a lost event costs a
 * count, never the match. Live only for now: replays have no clips yet.
 */
function sendSponsorEvent(kind, clip, context) {
  if (!clip?.sponsorId || !context?.surface || !context?.streamId) return;
  try {
    fetch(`${CONFIG.API_URL}/api/sponsors/events`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        viewerId: getViewerId(),
        stream: context.streamId,
        sponsorId: clip.sponsorId,
        surface: context.surface,
        kind,
        mode: "live",
      }),
      // An end clip's "complete" may go out as the page closes.
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Nothing to do: the count is lost, the match plays on
  }
}

// ============================
// The reel (#106)
// ============================

let active = null;

/** Whether sponsor clips are playing in the player right now. */
export function isSponsorReelPlaying() {
  return active !== null;
}

/**
 * Play the clips in order in the player's <video>, with the banner on top.
 * Resolves when the last clip has ended, been skipped or failed. Never
 * rejects. The caller has stopped the match's own HLS first. `context` is
 * { surface, streamId }: where the events say the clips were seen (#140).
 */
export function playSponsorReel(clips, teamName, context = {}) {
  if (active) return active.done;
  if (!Array.isArray(clips) || clips.length === 0) return Promise.resolve();

  const video = dom.video;
  const saved = {
    badgeText: dom.liveBadge.textContent,
    badgeClass: dom.liveBadge.className,
    overlayHidden: dom.overlay.classList.contains("hidden"),
  };
  const banner = buildBanner(teamName);
  dom.wrapper.append(banner.el);
  dom.wrapper.classList.add("sponsor-reel");
  dom.overlay.classList.add("hidden");
  dom.liveBadge.textContent = "SPONSOR";
  dom.liveBadge.className = "live-badge sponsor";

  let index = -1;
  let hls = null;
  let maxTime = 0;
  let lastTime = -1;
  let lastProgressAt = 0;
  let loadTimer = null;
  let finished = false;
  /** The current clip's events already sent: once each per clip. */
  let sent = { start: false, sound: false };
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  active = { done, finish: () => finish() };

  const remaining = () => {
    let total = Math.max(0, (clips[index]?.durationSec ?? 0) - (video.currentTime || 0));
    for (let i = index + 1; i < clips.length; i++) total += clips[i].durationSec ?? 0;
    return total;
  };

  // No seeking forward: back to the furthest point watched. Native fullscreen
  // on iOS has its own scrubber, so this is the only real guard.
  const onSeeking = () => {
    if (video.currentTime > maxTime + 1) video.currentTime = maxTime;
  };
  const onRate = () => {
    if (video.playbackRate !== 1) video.playbackRate = 1;
  };
  const hasSound = () => !video.muted && video.volume > 0;
  // "start" once the clip really plays, not when it has loaded.
  const onPlaying = () => {
    const clip = clips[index];
    if (!clip || sent.start) return;
    sent.start = true;
    sendSponsorEvent("start", clip, context);
  };
  const onTime = () => {
    // The first moment the clip plays with sound, whenever the viewer turns it on.
    if (sent.start && !sent.sound && !video.paused && hasSound()) {
      sent.sound = true;
      sendSponsorEvent("sound", clips[index], context);
    }
    if (!video.seeking) maxTime = Math.max(maxTime, video.currentTime);
    if (video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      lastProgressAt = Date.now();
    }
    banner.setRemaining(remaining());
  };
  const onEnded = () => {
    if (sent.start) sendSponsorEvent("complete", clips[index], context);
    next();
  };
  const watchdog = setInterval(() => {
    // A clip that has started but stands still is skipped. A viewer who
    // paused it is waited for: pausing skips nothing.
    if (!lastProgressAt || video.paused) return;
    if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) next();
  }, 1000);

  video.addEventListener("seeking", onSeeking);
  video.addEventListener("ratechange", onRate);
  video.addEventListener("timeupdate", onTime);
  video.addEventListener("ended", onEnded);
  video.addEventListener("playing", onPlaying);

  function clearClip() {
    clearTimeout(loadTimer);
    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.onerror = null;
  }

  function next() {
    if (finished) return;
    clearClip();
    index++;
    if (index >= clips.length) return finish();
    const clip = clips[index];
    maxTime = 0;
    lastTime = -1;
    lastProgressAt = 0;
    sent = { start: false, sound: false };
    banner.setSponsor(clip.name);
    banner.setRemaining(remaining());

    const started = () => {
      clearTimeout(loadTimer);
      lastProgressAt = Date.now();
      playWithSound();
    };
    loadTimer = setTimeout(next, LOAD_TIMEOUT_MS);

    const url = mediaUrl(clip.hlsUrl);
    if (Hls.isSupported()) {
      hls = new Hls({
        maxBufferLength: 10,
        xhrSetup: (xhr) => {
          const { Authorization } = authHeaders();
          if (Authorization) xhr.setRequestHeader("Authorization", Authorization);
        },
      });
      hls.on(Hls.Events.MANIFEST_PARSED, started);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) next();
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.onerror = () => next();
      video.addEventListener("loadedmetadata", started, { once: true });
      video.src = url;
    } else {
      next();
    }
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(watchdog);
    clearClip();
    video.removeEventListener("seeking", onSeeking);
    video.removeEventListener("ratechange", onRate);
    video.removeEventListener("timeupdate", onTime);
    video.removeEventListener("ended", onEnded);
    video.removeEventListener("playing", onPlaying);
    video.pause();
    video.removeAttribute("src");
    video.load();
    banner.el.remove();
    dom.wrapper.classList.remove("sponsor-reel");
    dom.liveBadge.textContent = saved.badgeText;
    dom.liveBadge.className = saved.badgeClass;
    dom.overlay.classList.toggle("hidden", saved.overlayHidden);
    active = null;
    resolve();
  }

  next();
  return done;
}

/** Stop a running reel at once, as when the viewer closes the player. */
export function cancelSponsorReel() {
  active?.finish();
}

function buildBanner(teamName) {
  const el = document.createElement("div");
  el.className = "sponsor-banner";
  el.setAttribute("role", "status");
  el.innerHTML = `<span class="sponsor-banner-lead"></span>
    <span class="sponsor-banner-name"></span>
    <span class="sponsor-banner-time" aria-hidden="true"></span>`;
  el.querySelector(".sponsor-banner-lead").textContent = `${teamName || "Laget"} är sponsrat av:`;
  const name = el.querySelector(".sponsor-banner-name");
  const time = el.querySelector(".sponsor-banner-time");
  let shown = "";
  return {
    el,
    setSponsor(text) {
      name.textContent = text;
    },
    setRemaining(seconds) {
      const s = Math.ceil(seconds);
      const text = s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "";
      if (text !== shown) time.textContent = shown = text;
    },
  };
}
