// === Player module ===
// HLS setup, video controls, overlay, progress bar, PiP, quality menu,
// seek, keyboard shortcuts, fullscreen, viewer heartbeat.

import Hls from "hls.js";
import { CONFIG } from "./config.js";
import { state, dom, MAX_RECONNECT_ATTEMPTS } from "./state.js";
import { formatTime, mediaUrl } from "./utils.js";
import { authHeaders } from "./auth.js";
import { stopListPolling } from "./streams.js";
import { stopVodPolling } from "./vod.js";
import { fetchClipsForStream } from "./highlights.js";
import { unlockResumeSignal, playResumeSignal } from "./resume-signal.js";
import { getViewerId } from "./viewer-id.js";
import { playWithSound, unlockVideoSound, onMuteChangedByViewer, hideTapForSound, bindTapForSound } from "./sound.js";
import {
  fetchSponsorReel, playSponsorReel, cancelSponsorReel, isSponsorReelPlaying,
  claimTransition, transitionClaimed, sawStreamStart, noteStreamStatus,
  forgetSponsorSurfaces,
} from "./sponsors.js";
import { loadReplayMarkers, setReplayFragments, fetchReplayFragments, clearReplayMarkers, initReplayMarkers } from "./replay-markers.js";

// Callbacks injected by the orchestrator
let onClosePlayer = null; // called when player is closed (returns to list)

// Consecutive poll failure counter — only close player after multiple failures
let pollFailCount = 0;
const MAX_POLL_FAILURES = 6; // 6 × 5s = 30 seconds of consecutive failures before giving up

// ============================
// Status
// ============================

/** Viewer-facing name of a pause. An unknown or missing type (older backend) is just a pause. */
export function pauseLabel(pauseType) {
  if (pauseType === "period") return "PERIODPAUS";
  if (pauseType === "timeout") return "TIMEOUT";
  return "PAUS";
}

const PAUSE_SUB = "Matchen återupptas strax";
const PAUSE_SUB_HIGHLIGHTS = "Matchen återupptas strax — här är höjdpunkterna";

/**
 * Show the pause banner, or update it if the pause type changed.
 * The title is the live region, so screen readers hear it once per pause —
 * not again when the subline changes or the next highlight starts.
 */
function showPauseBanner(pauseType) {
  state.pauseType = pauseType || null;
  clearTimeout(resumeBannerTimer);
  dom.pauseBanner.classList.remove("resuming");
  const title = pauseLabel(state.pauseType);
  if (dom.pauseBannerTitle.textContent !== title) dom.pauseBannerTitle.textContent = title;
  dom.pauseBannerSub.textContent = state.isPlayingHighlights ? PAUSE_SUB_HIGHLIGHTS : PAUSE_SUB;
  dom.pauseBanner.classList.remove("hidden");
  if (state.currentStatus === "paused" && !state.isPlayingHighlights) {
    dom.liveBadge.textContent = title;
  }
}

/** How long "the match is back" stays on screen after a pause. */
const RESUME_BANNER_MS = 5000;
let resumeBannerTimer = null;

/**
 * The match is coming back after a pause: chime, and turn the pause banner
 * into a short notice. The notice shows even when the chime cannot play.
 */
function announceResume() {
  playResumeSignal();
  clearTimeout(resumeBannerTimer);
  dom.pauseBannerTitle.textContent = "MATCHEN ÅTERUPPTAS";
  dom.pauseBannerSub.textContent = "";
  dom.pauseBanner.classList.add("resuming");
  dom.pauseBanner.classList.remove("hidden");
  resumeBannerTimer = setTimeout(() => {
    if (state.currentStatus !== "paused") hidePauseBanner();
  }, RESUME_BANNER_MS);
}

function hidePauseBanner() {
  clearTimeout(resumeBannerTimer);
  dom.pauseBanner.classList.remove("resuming");
  dom.pauseBanner.classList.add("hidden");
  // Clear the title so the next pause is announced, even if it is the same type
  dom.pauseBannerTitle.textContent = "";
  state.pauseType = null;
}

function setStatus(status) {
  if (status === state.currentStatus) return;
  state.currentStatus = status;
  // Leaving a pause hides the banner — except for the short "match is back"
  // notice, which outlives the switch to connecting and live.
  const resuming = dom.pauseBanner.classList.contains("resuming");
  if (status === "offline" || status === "vod" || (status !== "paused" && !resuming)) hidePauseBanner();

  switch (status) {
    case "connecting":
      dom.liveBadge.textContent = "ANSLUTER";
      dom.liveBadge.className = "live-badge connecting";
      showOverlay("Ansluter till s\u00e4ndningen\u2026", true);
      break;
    case "live":
      dom.liveBadge.textContent = "LIVE";
      dom.liveBadge.className = "live-badge live";
      hideOverlay();
      dom.video.classList.remove("video-fade");
      break;
    case "offline":
      dom.liveBadge.textContent = "OFFLINE";
      dom.liveBadge.className = "live-badge offline";
      showOverlay("Ingen s\u00e4ndning just nu", false);
      break;
    case "paused":
      dom.liveBadge.textContent = pauseLabel(state.pauseType);
      dom.liveBadge.className = "live-badge paused";
      showOverlay("Sändningen är pausad — återkommer snart", false);
      showPauseBanner(state.pauseType);
      startHighlightCarousel(); // async, non-blocking — replaces overlay if clips exist
      break;
    case "vod":
      dom.liveBadge.textContent = "REPRIS";
      dom.liveBadge.className = "live-badge vod";
      break;
  }
}

// ============================
// Overlay
// ============================

function hideOverlay() {
  dom.overlay.classList.add("hidden");
}

function showOverlay(msg, showSpinner) {
  dom.overlayText.textContent = msg;
  dom.overlay.classList.remove("hidden");
  if (dom.overlaySpinner) {
    dom.overlaySpinner.style.display = showSpinner ? "block" : "none";
  }
}

// ============================
// HLS
// ============================

function destroyHls() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
}

function tryConnect() {
  if (!state.currentStreamUrl) return;

  if (Hls.isSupported()) {
    startHls();
  } else if (dom.video.canPlayType("application/vnd.apple.mpegurl")) {
    startNative();
  } else {
    showOverlay("Din webbl\u00e4sare st\u00f6der inte HLS-uppspelning", false);
  }
}

function startHls() {
  destroyHls();

  state.hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    maxBufferLength: 15,
    maxMaxBufferLength: 30,
    manifestLoadingTimeOut: 10000,
    manifestLoadingMaxRetry: 6,
    manifestLoadingRetryDelay: 1000,
    levelLoadingTimeOut: 10000,
    levelLoadingMaxRetry: 6,
    fragLoadingTimeOut: 10000,
    fragLoadingMaxRetry: 6,
    liveSyncDurationCount: 3,
    // DVR mode: keep all back-buffer so viewers can seek back up to 2 hours
    liveBackBufferLength: state.isDvrMode ? Infinity : 30,
    // Attach viewer Bearer token on playlist/segment requests to the backend.
    // Segments on MinIO are public and ignore the header; only the backend uses it.
    xhrSetup: (xhr) => {
      const headers = authHeaders();
      if (headers.Authorization) {
        xhr.setRequestHeader("Authorization", headers.Authorization);
      }
    },
  });

  // After sponsor clips the match does not start at live, but from the
  // beginning (#108) or from where it was resumed during the clips (#109)
  const startAt = connectAt;
  connectAt = null;
  if (startAt) {
    state.hls.config.autoStartLoad = false;
    state.hls.once(Hls.Events.LEVEL_LOADED, (_e, data) => {
      state.hls?.startLoad(startPosition(startAt, data.details.totalduration));
    });
  }

  state.hls.loadSource(state.currentStreamUrl);
  state.hls.attachMedia(dom.video);

  state.hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);
  state.hls.on(Hls.Events.ERROR, onHlsError);
  state.hls.on(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);
}

/**
 * Where the match starts when it is not at live. `end` is the newest second
 * in the DVR playlist. Resumed: the playlist has grown by about the time
 * since the resume, and a few seconds before it is better than a few after.
 */
function startPosition(at, end) {
  if (at.fromStart) return 0;
  const since = (Date.now() - at.resumedAt) / 1000;
  return Math.max(0, end - since - 4);
}

function startNative() {
  const startAt = connectAt;
  connectAt = null;
  if (startAt) {
    dom.video.addEventListener("loadedmetadata", () => {
      const r = dom.video.seekable;
      if (!r.length) return;
      dom.video.currentTime = Math.max(r.start(0), startPosition(startAt, r.end(r.length - 1)));
    }, { once: true });
  }
  dom.video.src = state.currentStreamUrl;
  dom.video.addEventListener(
    "loadedmetadata",
    () => {
      setStatus("live");
      buildNativeQualityMenu();
      playWithSound();
    },
    { once: true }
  );
  dom.video.addEventListener(
    "error",
    () => {
      setStatus("offline");
    },
    { once: true }
  );
}

// --- VOD HLS ---

function tryConnectVod() {
  if (!state.currentStreamUrl) return;

  if (Hls.isSupported()) {
    startHlsVod();
  } else if (dom.video.canPlayType("application/vnd.apple.mpegurl")) {
    dom.video.src = state.currentStreamUrl;
    fetchReplayFragments(state.currentStreamUrl);
    dom.video.addEventListener(
      "loadedmetadata",
      () => {
        buildNativeQualityMenu();
        playWithSound();
      },
      { once: true }
    );
    dom.video.addEventListener(
      "error",
      () => {
        showOverlay("Kunde inte spela upp reprisen", false);
      },
      { once: true }
    );
  } else {
    showOverlay("Din webbl\u00e4sare st\u00f6der inte HLS-uppspelning", false);
  }
}

function startHlsVod() {
  destroyHls();

  state.hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    manifestLoadingTimeOut: 15000,
    manifestLoadingMaxRetry: 3,
    manifestLoadingRetryDelay: 2000,
    levelLoadingTimeOut: 15000,
    levelLoadingMaxRetry: 3,
    fragLoadingTimeOut: 15000,
    fragLoadingMaxRetry: 3,
    // Recordings sit behind the viewer PIN now: the playlist and every segment
    // request goes to the backend, which authorises before redirecting.
    xhrSetup: (xhr) => {
      const headers = authHeaders();
      if (headers.Authorization) {
        xhr.setRequestHeader("Authorization", headers.Authorization);
      }
    },
  });

  state.hls.loadSource(state.currentStreamUrl);
  state.hls.attachMedia(dom.video);

  state.hls.on(Hls.Events.MANIFEST_PARSED, () => {
    buildQualityMenu();
    playWithSound();
  });

  state.hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      console.warn("VOD: recovering from media error", data.details);
      state.hls.recoverMediaError();
      return;
    }
    destroyHls();
    showOverlay("Kunde inte spela upp reprisen", false);
  });

  // Period, timeout and highlight markers are placed by fragment (replay-markers.js)
  state.hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
    const frags = data.details.fragments.map((f) => ({
      start: f.start,
      duration: f.duration,
      uri: f.relurl,
      pdt: f.programDateTime,
    }));
    setReplayFragments(frags, data.details.totalduration);
  });

  state.hls.on(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);
}

// ============================
// HLS callbacks
// ============================

function onManifestParsed() {
  // The match went live while the player waited for it: the start clips
  // come first, then the match from the beginning (#107, #108)
  if (startClipsDue()) {
    destroyHls();
    playStartClips();
    return;
  }
  state.hlsReconnectAttempts = 0;
  if (!state.isVodMode && !state.liveStartTime) {
    state.liveStartTime = Date.now();
  }
  setStatus("live");
  buildQualityMenu();
  // Never muted without saying so: a refused play() shows "Tryck för ljud" (#105)
  playWithSound();
  showControls();
}

function onHlsError(_event, data) {
  if (!data.fatal) return;

  console.warn(`HLS fatal error: type=${data.type}, details=${data.details}`);

  if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
    console.warn("Attempting media error recovery...");
    state.hls.recoverMediaError();
    return;
  }

  // ALL fatal errors (NETWORK_ERROR, MUX_ERROR, OTHER_ERROR) —
  // always try restarting HLS before giving up. A single transient error
  // should never kill a live basketball stream.
  state.hlsReconnectAttempts++;
  if (state.hlsReconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
    setStatus("connecting");
    showOverlay(
      `\u00c5teransluter (${state.hlsReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})\u2026`,
      true
    );
    setTimeout(() => {
      if (state.currentStreamUrl) {
        startHls();
      }
    }, 2000);
    return;
  }

  // Exhausted retries
  destroyHls();
  checkIfStreamStopped();
}

async function checkIfStreamStopped() {
  if (!state.currentStreamId) return;
  try {
    const res = await fetch(
      `${CONFIG.API_URL}/api/streams/${state.currentStreamId}`,
      { headers: authHeaders() }
    );
    if (!res.ok) {
      // API error (500, 502, etc.) — DON'T assume stream is dead.
      // The backend or Restreamer may be temporarily overloaded.
      // Keep trying to reconnect HLS instead of closing the player.
      console.warn(`checkIfStreamStopped: API returned ${res.status}, retrying HLS...`);
      state.hlsReconnectAttempts++;
      if (state.hlsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        showOverlay("S\u00e4ndningen verkar ha avbrutits", false);
        setTimeout(closePlayer, 2500);
      } else {
        setStatus("connecting");
        showOverlay(
          `\u00c5teransluter (${state.hlsReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})\u2026`,
          true
        );
        setTimeout(tryConnect, 3000);
      }
      return;
    }
    const stream = await res.json();
    latestStream = stream;
    if (stream.status === "stopped") {
      endStream(stream);
    } else if (stream.status === "paused") {
      // Stream was paused while we had an HLS error — show pause overlay
      setStatus("paused");
      destroyHls();
    } else if (stream.status === "waiting") {
      // Stream is resuming — wait for it to go live (polling will pick it up)
      noteStreamStatus(stream);
      setStatus("connecting");
      showOverlay("V\u00e4ntar p\u00e5 s\u00e4ndningen\u2026", true);
    } else {
      // Stream still exists — update URL and try reconnecting
      if (stream.hlsUrl) {
        state.currentStreamUrl = mediaUrl(stream.hlsUrl);
      }
      state.hlsReconnectAttempts++;
      if (state.hlsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        showOverlay("S\u00e4ndningen verkar ha avbrutits", false);
        setTimeout(closePlayer, 2500);
      } else {
        setStatus("connecting");
        showOverlay(
          `\u00c5teransluter (${state.hlsReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})\u2026`,
          true
        );
        setTimeout(tryConnect, 3000);
      }
    }
  } catch {
    // Network error — don't close, try reconnecting HLS
    console.warn("checkIfStreamStopped: network error, retrying HLS...");
    state.hlsReconnectAttempts++;
    if (state.hlsReconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      showOverlay("S\u00e4ndningen verkar ha avbrutits", false);
      setTimeout(closePlayer, 2500);
    } else {
      setStatus("connecting");
      setTimeout(tryConnect, 3000);
    }
  }
}

/**
 * "720p" for a level, or null when the playlist gives no height: a stream
 * without RESOLUTION has height 0, which must never show as "0p" (#182).
 */
function levelLabel(level) {
  return level && level.height > 0 ? `${level.height}p` : null;
}

function onLevelSwitched(_event, data) {
  if (state.hls && state.hls.autoLevelEnabled) {
    const label = levelLabel(state.hls.levels[data.level]);
    dom.qualityLabel.textContent = label ? `Auto (${label})` : "Auto";
  }
  updateActiveQuality();
}

// ============================
// Quality menu
// ============================

function buildQualityMenu() {
  dom.qualityMenu.innerHTML = "";

  const autoBtn = document.createElement("button");
  autoBtn.className = "quality-option active";
  autoBtn.textContent = "Auto";
  autoBtn.dataset.level = "-1";
  autoBtn.addEventListener("click", () => selectQuality(-1));
  dom.qualityMenu.appendChild(autoBtn);

  // Only levels with a known height can be picked. With fewer than two there
  // is nothing to choose between, so the button is hidden (#182).
  const choices = state.hls.levels
    .map((level, i) => ({ i, label: levelLabel(level) }))
    .filter((c) => c.label);
  dom.qualityBtn.classList.toggle("hidden", choices.length < 2);
  dom.qualityLabel.textContent = "Auto";

  choices.forEach(({ i, label }) => {
    const btn = document.createElement("button");
    btn.className = "quality-option";
    btn.textContent = label;
    btn.dataset.level = i;
    btn.addEventListener("click", () => selectQuality(i));
    dom.qualityMenu.appendChild(btn);
  });
}

function buildNativeQualityMenu() {
  dom.qualityMenu.innerHTML = "";
  dom.qualityBtn.classList.remove("hidden");
  dom.qualityLabel.textContent = "Auto";
  const btn = document.createElement("button");
  btn.className = "quality-option active";
  btn.textContent = "Auto";
  dom.qualityMenu.appendChild(btn);
}

function selectQuality(levelIndex) {
  state.hls.currentLevel = levelIndex;
  if (levelIndex === -1) {
    state.hls.currentLevel = -1;
    dom.qualityLabel.textContent = "Auto";
  } else {
    dom.qualityLabel.textContent = levelLabel(state.hls.levels[levelIndex]) ?? "Auto";
  }
  updateActiveQuality();
  dom.qualityMenu.classList.remove("open");
}

function updateActiveQuality() {
  if (!state.hls) return;
  const currentLevel = state.hls.autoLevelEnabled ? -1 : state.hls.currentLevel;
  dom.qualityMenu.querySelectorAll(".quality-option").forEach((btn) => {
    btn.classList.toggle(
      "active",
      parseInt(btn.dataset.level) === currentLevel
    );
  });
}

// ============================
// Progress bar
// ============================

function updateProgress() {
  if (state.isSeeking) return;

  if (state.isVodMode) {
    const current = dom.video.currentTime || 0;
    const duration = dom.video.duration || 0;

    dom.timeElapsed.textContent = formatTime(current);
    dom.timeDuration.textContent = formatTime(duration);

    if (duration > 0 && isFinite(duration)) {
      const pct = (current / duration) * 100;
      dom.progressFilled.style.width = pct + "%";
      dom.progressHandle.style.left = pct + "%";
    }

    updateBufferBar(duration);
  } else if (state.isDvrMode) {
    // DVR: seekable timeline with live at the right end
    const current = dom.video.currentTime || 0;
    const end = dvrEnd();

    if (end > 0) {
      const behind = isBehindLive();
      // At live the bar is full, though the picture is a few segments behind the end
      const pct = behind ? (current / end) * 100 : 100;
      dom.progressFilled.style.width = pct + "%";
      dom.progressHandle.style.left = pct + "%";
      dom.timeElapsed.textContent = formatTime(current);
      dom.timeDuration.textContent = "LIVE";
      updateBackToLive(behind);
    }

    updateBufferBar(end);
  } else {
    // Live (no DVR): show elapsed wall-clock time
    if (state.liveStartTime) {
      const elapsed = (Date.now() - state.liveStartTime) / 1000;
      dom.timeElapsed.textContent = formatTime(elapsed);
      dom.progressFilled.style.width = "100%";
    }
    dom.timeDuration.textContent = "";
  }
}

function updateBufferBar(duration) {
  if (!duration || !isFinite(duration) || duration <= 0) {
    dom.progressBuffered.style.width = "0%";
    return;
  }
  if (dom.video.buffered.length > 0) {
    const bufferedEnd = dom.video.buffered.end(dom.video.buffered.length - 1);
    dom.progressBuffered.style.width = (bufferedEnd / duration) * 100 + "%";
  }
}

function setupProgressForLive() {
  // DVR mode uses seekable progress bar (like VOD but with growing duration)
  dom.progressContainer.className = state.isDvrMode
    ? "progress-bar-container vod dvr"
    : "progress-bar-container live";
  dom.progressFilled.style.width = "0%";
  dom.progressBuffered.style.width = "0%";
  dom.progressHandle.style.left = "0%";
  dom.timeElapsed.textContent = "0:00";
  dom.timeDuration.textContent = state.isDvrMode ? "LIVE" : "";
  state.liveStartTime = null;
}

function setupProgressForVod() {
  dom.progressContainer.className = "progress-bar-container vod";
  dom.progressFilled.style.width = "0%";
  dom.progressBuffered.style.width = "0%";
  dom.progressHandle.style.left = "0%";
  dom.timeElapsed.textContent = "0:00";
  dom.timeDuration.textContent = "0:00";
  state.liveStartTime = null;
}

function resetProgress() {
  state.liveStartTime = null;
  state.isSeeking = false;
  dom.progressFilled.style.width = "0%";
  dom.progressBuffered.style.width = "0%";
  dom.progressHandle.style.left = "0%";
  dom.timeElapsed.textContent = "0:00";
  dom.timeDuration.textContent = "0:00";
  dom.progressContainer.classList.remove("seeking");
  updateBackToLive(false);
}

// ============================
// Seek (VOD only)
// ============================

function getSeekPosition(e) {
  const rect = dom.progressBar.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}

/** The end of the seek bar: the recording's length, or in a live match the newest second there is. */
function timelineEnd() {
  return state.isDvrMode ? dvrEnd() : dom.video.duration;
}

function seekTo(ratio) {
  const end = timelineEnd();
  if (!end || !isFinite(end)) return;
  dom.video.currentTime = ratio * end;
}

/** A drag let go this close to the right end of a live match goes to live (#103). */
const LIVE_SNAP_PX = 16;

function atLiveEnd(clientX) {
  if (!state.isDvrMode) return false;
  return dom.progressBar.getBoundingClientRect().right - clientX <= LIVE_SNAP_PX;
}

function canSeek() {
  // Sponsor clips are not the match: no seeking in them (#106)
  if (isSponsorReelPlaying()) return false;
  return state.isVodMode || state.isDvrMode;
}

// Safari sometimes stays frozen after a seek even though playback should continue:
// the video reports that it is playing but currentTime never moves until the viewer
// presses pause and play. Do that for them once the new position has data.
let resumeAfterSeek = false;
let seekStallTimer = null;

function onVideoSeeking() {
  if (!canSeek()) return;
  if (!dom.video.paused) resumeAfterSeek = true;
  clearTimeout(seekStallTimer);
}

function onVideoSeeked() {
  if (!canSeek() || !resumeAfterSeek) return;
  clearTimeout(seekStallTimer);
  const video = dom.video;
  const seekedAt = video.currentTime;
  let checks = 0;

  const check = () => {
    if (video.seeking) return; // a new seek takes over
    if (video.paused) {
      resumeAfterSeek = false; // the viewer paused meanwhile
      return;
    }
    if (Math.abs(video.currentTime - seekedAt) > 0.1) {
      resumeAfterSeek = false; // playing again
      return;
    }
    // Still loading the new position: wait a while before intervening
    if (video.readyState < 3 && ++checks < 16) {
      seekStallTimer = setTimeout(check, 500);
      return;
    }
    resumeAfterSeek = false;
    video.pause();
    video.play().catch(() => {});
  };

  seekStallTimer = setTimeout(check, 800);
}

function onSeekStart(e) {
  if (!canSeek()) return;
  e.stopPropagation();
  state.isSeeking = true;
  dom.progressContainer.classList.add("seeking");

  showSeekPosition(e);

  document.addEventListener("mousemove", onSeekMove);
  document.addEventListener("mouseup", onSeekEnd);
  document.addEventListener("touchmove", onSeekMove, { passive: false });
  document.addEventListener("touchend", onSeekEnd);
}

function onSeekMove(e) {
  if (!state.isSeeking) return;
  e.preventDefault();
  showSeekPosition(e);
}

/** Move the handle with the pointer. At the right end of a live match it says LIVE. */
function showSeekPosition(e) {
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const live = atLiveEnd(clientX);
  const ratio = live ? 1 : getSeekPosition(e);
  dom.progressFilled.style.width = ratio * 100 + "%";
  dom.progressHandle.style.left = ratio * 100 + "%";
  dom.timeElapsed.textContent = live ? "LIVE" : formatTime(ratio * timelineEnd());
}

function onSeekEnd(e) {
  if (!state.isSeeking) return;
  const touch = e.changedTouches ? e.changedTouches[0] : e;
  const rect = dom.progressBar.getBoundingClientRect();
  const clientX = touch.clientX;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  if (atLiveEnd(clientX)) jumpToLive();
  else seekTo(ratio);
  state.isSeeking = false;
  dom.progressContainer.classList.remove("seeking");

  document.removeEventListener("mousemove", onSeekMove);
  document.removeEventListener("mouseup", onSeekEnd);
  document.removeEventListener("touchmove", onSeekMove);
  document.removeEventListener("touchend", onSeekEnd);
}

// ============================
// Controls
// ============================

function togglePlay() {
  // Sponsor clips: pausing is allowed with the video's own controls, but a
  // tap on the picture is not meant to do anything (#106)
  if (isSponsorReelPlaying()) return;
  if (dom.video.paused) {
    dom.video.play();
  } else {
    dom.video.pause();
  }
}

// --- Back to live (DVR, #102) ---

/**
 * Where live is, as hls.js plays it: three segments before the newest one
 * (liveSyncDurationCount). The DVR playlist has 4 s segments, so a viewer at
 * live is about 12 s from the end, and "behind" is counted from here.
 */
const LIVE_OFFSET_S = 12;
/** "Hoppa till live" shows when the viewer is more than this behind live. */
const BEHIND_LIVE_S = 10;

/**
 * The newest second that can be played. hls.js gives the video a duration;
 * Safari's own player says Infinity for a live playlist and has only the
 * seekable range.
 */
function dvrEnd() {
  const d = dom.video.duration;
  if (d && isFinite(d)) return d;
  const r = dom.video.seekable;
  return r && r.length ? r.end(r.length - 1) : 0;
}

function livePosition() {
  const sync = state.hls?.liveSyncPosition;
  if (sync && isFinite(sync)) return sync;
  return Math.max(0, dvrEnd() - LIVE_OFFSET_S);
}

function isBehindLive() {
  if (!state.isDvrMode || dvrEnd() <= 0) return false;
  return livePosition() - (dom.video.currentTime || 0) > BEHIND_LIVE_S;
}

/** The button, and the LIVE badge greyed out while the viewer is behind. */
function updateBackToLive(show) {
  if (!dom.backToLiveBtn) return;
  dom.backToLiveBtn.classList.toggle("hidden", !show);
  dom.liveBadge.classList.toggle("behind", show && state.currentStatus === "live");
}

function jumpToLive() {
  if (!state.isDvrMode) return;
  const target = livePosition();
  if (target > 0) {
    dom.video.currentTime = target;
    dom.video.play().catch(() => {});
    updateBackToLive(false);
  }
}

function updatePlayButton() {
  const playing = !dom.video.paused;
  dom.iconPlay.style.display = playing ? "none" : "block";
  dom.iconPause.style.display = playing ? "block" : "none";
}

function toggleMute() {
  dom.video.muted = !dom.video.muted;
  if (!dom.video.muted && dom.video.volume === 0) dom.video.volume = 1;
  dom.volumeSlider.value = dom.video.muted ? 0 : dom.video.volume;
  updateMuteButton();
  onMuteChangedByViewer();
}

function updateMuteButton() {
  const muted = dom.video.muted || dom.video.volume === 0;
  dom.iconVol.style.display = muted ? "none" : "block";
  dom.iconMuted.style.display = muted ? "block" : "none";
}

function onVolumeChange() {
  dom.video.volume = parseFloat(dom.volumeSlider.value);
  dom.video.muted = dom.video.volume === 0;
  updateMuteButton();
  onMuteChangedByViewer();
}

function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    return;
  }
  if (dom.video.webkitDisplayingFullscreen) {
    dom.video.webkitExitFullscreen();
    return;
  }
  const requestFs =
    dom.wrapper.requestFullscreen || dom.wrapper.webkitRequestFullscreen;
  if (requestFs) {
    const p = requestFs.call(dom.wrapper);
    if (p && p.catch) p.catch(enterNativeVideoFullscreen);
  } else {
    // iPhone Safari has no element fullscreen — only the <video> element itself
    // can go fullscreen, via the native player.
    enterNativeVideoFullscreen();
  }
}

function enterNativeVideoFullscreen() {
  if (dom.video.webkitEnterFullscreen) {
    try { dom.video.webkitEnterFullscreen(); } catch (_) {}
  }
}

function updateFullscreenButton() {
  const isFs = !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    dom.video.webkitDisplayingFullscreen
  );
  dom.iconFsEnter.style.display = isFs ? "none" : "block";
  dom.iconFsExit.style.display = isFs ? "block" : "none";
}

function togglePip() {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  } else if (document.pictureInPictureEnabled) {
    dom.video.requestPictureInPicture().catch(() => {});
  }
}

function showControls() {
  dom.wrapper.classList.add("show-controls");
  clearTimeout(state.controlsTimeout);
  state.controlsTimeout = setTimeout(() => {
    if (!dom.video.paused) {
      dom.wrapper.classList.remove("show-controls");
    }
  }, 3000);
}

// ============================
// Highlight carousel (during pause)
// ============================

let consecutiveClipFailures = 0;

/** Retry startHighlightCarousel after a delay if still paused and carousel not running. */
function scheduleCarouselRetry(delayMs) {
  setTimeout(() => {
    if (state.currentStatus === "paused" && !state.isPlayingHighlights) {
      console.info(`[carousel] Retrying clip fetch after ${delayMs / 1000}s`);
      startHighlightCarousel();
    }
  }, delayMs);
}

async function startHighlightCarousel() {
  const streamId = state.currentStreamId;
  if (!streamId) return;
  // Sponsor clips first; the carousel starts when they are over (#109)
  if (reelPending || isSponsorReelPlaying()) return;

  console.info(`[carousel] Fetching clips for stream ${streamId}…`);
  const clips = await fetchClipsForStream(streamId);

  // Guard: status may have changed while fetching (e.g. broadcaster already resumed),
  // or the viewer switched to another match that is paused too (ABL-051)
  if (state.currentStatus !== "paused" || state.currentStreamId !== streamId) {
    console.info("[carousel] Status or stream changed during fetch — aborting");
    return;
  }

  if (clips.length === 0) {
    // No clips yet — schedule a retry so the carousel starts as soon as clips appear
    console.info("[carousel] No clips found yet — will retry in 30s");
    scheduleCarouselRetry(30_000);
    return;
  }

  console.info(`[carousel] Starting with ${clips.length} clip(s)`);

  state.highlightClips = clips;
  state.highlightIndex = -1;
  state.isPlayingHighlights = true;
  consecutiveClipFailures = 0;

  // Update UI — the pause banner says which pause it is, the badge what is playing
  dom.liveBadge.textContent = "HÖJDPUNKTER";
  dom.liveBadge.className = "live-badge highlights";
  dom.pauseBannerSub.textContent = PAUSE_SUB_HIGHLIGHTS;
  dom.streamDesc.textContent =
    `${clips.length} höjdpunkt${clips.length > 1 ? "er" : ""} från matchen`;

  // Fade out video before first clip (hidden behind overlay)
  dom.video.classList.add("video-fade");

  // Start first clip (no fade-out delay for the first one)
  playNextHighlight(true);
}

function playNextHighlight(isFirst = false) {
  if (!state.isPlayingHighlights) return;

  const loadClip = () => {
    if (!state.isPlayingHighlights) return;

    // Advance index (wrap around)
    state.highlightIndex =
      (state.highlightIndex + 1) % state.highlightClips.length;
    const clip = state.highlightClips[state.highlightIndex];

    // Update description
    dom.streamDesc.textContent =
      `Höjdpunkt ${state.highlightIndex + 1} av ${state.highlightClips.length}`;

    // Destroy previous highlight HLS
    if (state.highlightHls) {
      state.highlightHls.destroy();
      state.highlightHls = null;
    }

    // Remove previous ended listener
    dom.video.removeEventListener("ended", onHighlightEnded);

    if (Hls.isSupported()) {
      state.highlightHls = new Hls({
        maxBufferLength: 10,
        maxMaxBufferLength: 20,
      });
      state.highlightHls.loadSource(mediaUrl(clip.hlsUrl));
      state.highlightHls.attachMedia(dom.video);
      state.highlightHls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!state.isPlayingHighlights) return;
        consecutiveClipFailures = 0;
        hideOverlay();
        // Fade in
        dom.video.classList.remove("video-fade");
        playWithSound();
      });
      state.highlightHls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          // Destroy immediately to prevent this handler from firing again
          // (HLS.js can emit multiple fatal errors for the same instance)
          const errDetails = data.details || "unknown";
          console.warn(`[carousel] Fatal HLS error on clip ${state.highlightIndex}: ${errDetails}`);
          state.highlightHls?.destroy();
          state.highlightHls = null;
          consecutiveClipFailures++;
          if (consecutiveClipFailures >= state.highlightClips.length) {
            // All clips failed — fall back to pause overlay and retry after a while
            console.warn(`[carousel] All ${state.highlightClips.length} clip(s) failed — retrying in 15s`);
            stopHighlightCarousel();
            dom.liveBadge.textContent = pauseLabel(state.pauseType);
            dom.liveBadge.className = "live-badge paused";
            dom.pauseBannerSub.textContent = PAUSE_SUB;
            showOverlay("Sändningen är pausad — återkommer snart", false);
            scheduleCarouselRetry(15_000);
            return;
          }
          playNextHighlight();
        }
      });
    } else if (dom.video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      dom.video.src = mediaUrl(clip.hlsUrl);
      dom.video.addEventListener(
        "loadedmetadata",
        () => {
          if (!state.isPlayingHighlights) return;
          consecutiveClipFailures = 0;
          hideOverlay();
          dom.video.classList.remove("video-fade");
          playWithSound();
        },
        { once: true }
      );
      // Skip to next clip on load error (broken URL, MinIO unavailable, etc.)
      dom.video.addEventListener(
        "error",
        () => {
          if (!state.isPlayingHighlights) return;
          console.warn(`[carousel] Safari: error loading clip ${state.highlightIndex}`);
          consecutiveClipFailures++;
          if (consecutiveClipFailures >= state.highlightClips.length) {
            console.warn(`[carousel] All ${state.highlightClips.length} clip(s) failed (Safari) — retrying in 15s`);
            stopHighlightCarousel();
            dom.liveBadge.textContent = pauseLabel(state.pauseType);
            dom.liveBadge.className = "live-badge paused";
            dom.pauseBannerSub.textContent = PAUSE_SUB;
            showOverlay("Sändningen är pausad — återkommer snart", false);
            scheduleCarouselRetry(15_000);
            return;
          }
          playNextHighlight();
        },
        { once: true }
      );
    }

    // When clip ends, play the next one
    dom.video.addEventListener("ended", onHighlightEnded, { once: true });
  };

  if (isFirst) {
    // First clip: no fade-out delay needed (overlay is already visible)
    loadClip();
  } else {
    // Subsequent clips: fade out, wait, then load next
    dom.video.classList.add("video-fade");
    setTimeout(loadClip, 400);
  }
}

function onHighlightEnded() {
  if (!state.isPlayingHighlights) return;
  playNextHighlight();
}

function stopHighlightCarousel() {
  if (!state.isPlayingHighlights) return;

  state.isPlayingHighlights = false;

  if (state.highlightHls) {
    state.highlightHls.destroy();
    state.highlightHls = null;
  }

  dom.video.removeEventListener("ended", onHighlightEnded);
  dom.video.pause();
  dom.video.removeAttribute("src");
  dom.video.load();
  dom.video.classList.remove("video-fade");

  state.highlightClips = [];
  state.highlightIndex = -1;
  consecutiveClipFailures = 0;

  // Reset description so it doesn't linger as "Höjdpunkt X av Y" during reconnect
  dom.streamDesc.textContent = "Följ matchen live.";
}

// ============================
// Stream polling (when player is open but offline)
// ============================

function startStreamPolling() {
  clearInterval(state.streamPollTimer);
  state.streamPollTimer = setInterval(pollCurrentStream, 5000);
}

function stopStreamPolling() {
  clearInterval(state.streamPollTimer);
}

async function pollCurrentStream() {
  if (!state.currentStreamId || state.isVodMode) return;
  try {
    const res = await fetch(
      `${CONFIG.API_URL}/api/streams/${state.currentStreamId}`,
      { headers: authHeaders() }
    );
    if (!res.ok) {
      // API error — DON'T close immediately. The backend may be temporarily
      // unreachable or the Restreamer may be slow. Only close after multiple
      // consecutive failures to avoid killing live streams.
      pollFailCount++;
      console.warn(`Stream poll failed (${pollFailCount}/${MAX_POLL_FAILURES}): HTTP ${res.status}`);
      if (pollFailCount >= MAX_POLL_FAILURES) {
        showOverlay("Tappade kontakten med servern", false);
        setTimeout(closePlayer, 2500);
      }
      return;
    }
    // Reset failure counter on any successful response
    pollFailCount = 0;

    const stream = await res.json();
    latestStream = stream;
    noteStreamStatus(stream);
    // While sponsor clips play, only note what happens; when they are over,
    // afterReel() acts on the stream as it is then (#109)
    if (reelPending || isSponsorReelPlaying()) {
      if (stream.status === "live" && !resumedDuringReelAt) resumedDuringReelAt = Date.now();
      return;
    }
    const wasPaused = state.currentStatus === "paused";
    if (stream.status === "stopped") {
      endStream(stream);
    } else if (stream.status === "paused") {
      if (state.currentStatus !== "paused") {
        state.pauseType = stream.pauseType || null;
        // A period break shows its sponsor clips before the highlights (#109)
        const surface = stream.sponsorSurface;
        const reel = surface && wasWatching() && claimTransition(`${stream.id}:${surface}:${stream.period ?? 0}`);
        if (reel) reelPending = true;
        setStatus("paused");
        // Destroy current HLS to free resources while paused
        destroyHls();
        if (reel) playSurface(surface, stream.id);
      } else if ((stream.pauseType || null) !== state.pauseType) {
        // A new pause began between two polls (resume and pause again)
        showPauseBanner(stream.pauseType);
      }
    } else if (stream.status === "waiting") {
      // Stream is resuming (new Restreamer process, waiting for RTMP input).
      // Show "connecting" so the viewer knows something is happening.
      if (state.currentStatus !== "connecting") {
        stopHighlightCarousel();
        setStatus("connecting");
        // "waiting" after a pause is the camera on its way back — the earliest
        // safe moment to tell the viewer, and it gives them a few seconds.
        if (wasPaused) announceResume();
      }
    } else if (stream.status === "live") {
      // Backend confirms stream is live — always reset reconnect budget
      state.hlsReconnectAttempts = 0;
      if (state.currentStatus !== "live") {
        stopHighlightCarousel();
        // Prefer the DVR playlist, for catch-up
        useStreamUrl(stream);
        if (startClipsDue()) {
          destroyHls();
          playStartClips();
          return;
        }
        setStatus("connecting");
        tryConnect();
        if (wasPaused) announceResume();
      }
    }
  } catch {
    // Network error — increment failure counter but keep polling
    pollFailCount++;
    console.warn(`Stream poll network error (${pollFailCount}/${MAX_POLL_FAILURES})`);
    if (pollFailCount >= MAX_POLL_FAILURES) {
      showOverlay("Tappade kontakten med servern", false);
      setTimeout(closePlayer, 2500);
    }
  }
}

// ============================
// Viewer heartbeat
// ============================

// The server counts viewers by an id per tab (viewer-id.js), not by IP address.
/** The live stream this tab is counted as watching, so it can leave it. */
let countedStreamId = null;

function viewUrl(streamId, action = "") {
  return `${CONFIG.API_URL}/api/streams/${encodeURIComponent(streamId)}/view${action}?v=${getViewerId()}`;
}

function startViewerHeartbeat() {
  if (state.isVodMode) {
    leaveViewerCount(); // No heartbeat for VOD
    return;
  }
  stopViewerHeartbeat();
  sendViewerHeartbeat();
  state.viewerHeartbeatTimer = setInterval(sendViewerHeartbeat, 30_000);
}

function stopViewerHeartbeat() {
  clearInterval(state.viewerHeartbeatTimer);
}

/**
 * Stop being counted at once, rather than after the server's one-minute TTL.
 * Sent as a beacon so it gets out even while the page is closing; when it
 * doesn't (a locked phone, a killed app), the TTL still takes the viewer off.
 */
export function leaveViewerCount() {
  if (!countedStreamId) return;
  const url = viewUrl(countedStreamId, "/leave");
  countedStreamId = null;
  try {
    if (navigator.sendBeacon && navigator.sendBeacon(url)) return;
  } catch {
    // Fall through to fetch
  }
  fetch(url, { method: "POST", keepalive: true }).catch(() => {});
}

function sendViewerHeartbeat() {
  if (!state.currentStreamId || state.isVodMode) return;
  // Switched straight to another stream: leave the old one first
  if (countedStreamId && countedStreamId !== state.currentStreamId) leaveViewerCount();
  countedStreamId = state.currentStreamId;
  fetch(viewUrl(state.currentStreamId), {
    method: "POST",
  }).catch(() => {});
}

// ============================
// Open / Close player
// ============================

/**
 * Open the live-stream player.
 * Called from the streams module when a stream card is clicked.
 * @param {string} hlsUrl - Direct memfs HLS URL (fallback)
 * @param {string} name - Stream display name
 * @param {string} streamId - Stream ID
 * @param {string} [dvrUrl] - Relative DVR playlist path (e.g. /api/streams/:id/dvr.m3u8)
 */
export function openPlayer(hlsUrl, name, streamId, dvrUrl) {
  // Guard: don't re-open the same stream
  if (state.currentStreamId === streamId && !dom.playerView.classList.contains("hidden")) return;

  // Opening the player is usually a click: the chance to allow the resume
  // chime, and sound in the video on iOS (#104)
  unlockResumeSignal();
  unlockVideoSound();

  state.isVodMode = false;
  clearReplayMarkers();
  // A new match: its sponsors are asked for again (#146)
  forgetSponsorSurfaces();
  // Use DVR playlist for catch-up capability; fall back to memfs live URL
  state.currentStreamUrl = dvrUrl ? `${CONFIG.API_URL}${dvrUrl}` : mediaUrl(hlsUrl);
  state.currentStreamId = streamId;
  state.isDvrMode = !!dvrUrl;
  state.hlsReconnectAttempts = 0;
  pollFailCount = 0;
  stopListPolling();
  stopVodPolling();

  dom.streamListView.classList.add("hidden");
  dom.vodListView.classList.add("hidden");
  dom.tabNav.classList.add("hidden");
  dom.playerView.classList.remove("hidden");

  dom.backBtnText.textContent = "Alla s\u00e4ndningar";
  dom.streamTitle.textContent = name;
  dom.streamDesc.textContent = "F\u00f6lj matchen live.";

  setupProgressForLive();
  setStatus("connecting");
  latestStream = null;
  resumedDuringReelAt = 0;
  ending = false;
  startWatching(streamId);
  startStreamPolling();
  startViewerHeartbeat();
}

/**
 * Ask once how the match stands before connecting. Live, and the viewer was
 * here before it started: the start clips first (#108). In the middle of a
 * pause: show the pause now, not at the first poll. Otherwise connect.
 */
async function startWatching(streamId) {
  let stream = null;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/streams/${streamId}`, { headers: authHeaders() });
    if (res.ok) stream = await res.json();
  } catch {
    // The regular poll picks it up
  }
  if (state.currentStreamId !== streamId) return;
  if (stream) latestStream = stream;
  noteStreamStatus(stream);
  if (stream?.status === "live") useStreamUrl(stream);
  if (stream?.status === "live" && startClipsDue()) return playStartClips();
  if (stream?.status === "paused") {
    state.pauseType = stream.pauseType || null;
    setStatus("paused");
    return;
  }
  tryConnect();
}

// ============================
// Sponsor clips (#107–#110)
// ============================

/** The stream as the last poll saw it. */
let latestStream = null;
/** Set when the match was resumed while sponsor clips played. */
let resumedDuringReelAt = 0;
/** Sponsor clips are being fetched; the carousel and the poll wait. */
let reelPending = false;
/** The match has ended and is on its way out. */
let ending = false;
/** Where the next connect starts, when not at live. */
let connectAt = null;

function useStreamUrl(stream) {
  if (stream.dvrUrl) {
    state.currentStreamUrl = `${CONFIG.API_URL}${stream.dvrUrl}`;
    state.isDvrMode = true;
  } else if (stream.hlsUrl) {
    state.currentStreamUrl = mediaUrl(stream.hlsUrl);
  }
}

/** Whether the viewer has been watching this match, not just opened it at the end. */
function wasWatching() {
  return ["live", "paused", "connecting"].includes(state.currentStatus);
}

function startClipsDue() {
  const id = state.currentStreamId;
  return Boolean(id) && sawStreamStart(id) && !transitionClaimed(`${id}:start`);
}

/** Start clips, then the match from its first second (#108). */
function playStartClips() {
  if (!claimTransition(`${state.currentStreamId}:start`)) return tryConnect();
  reelPending = true;
  playSurface("start", state.currentStreamId, { fromStart: true });
}

/**
 * Fetch and play one surface's clips, then carry on from however the match
 * stands by then. No clips, or none that play, and it carries on at once.
 */
async function playSurface(surface, streamId, { fromStart = false } = {}) {
  reelPending = true;
  resumedDuringReelAt = 0;
  const reel = await fetchSponsorReel(surface, streamId);
  if (state.currentStreamId !== streamId) {
    reelPending = false;
    return;
  }
  if (reel) {
    stopHighlightCarousel();
    hideOverlay();
    await playSponsorReel(reel.clips, reel.teamName, { surface, streamId });
  }
  reelPending = false;
  if (state.currentStreamId !== streamId) return;
  afterReel(surface, { fromStart, hadClips: Boolean(reel) });
}

function afterReel(surface, { fromStart, hadClips }) {
  const stream = latestStream;
  const status = stream?.status;
  if (surface === "end") return;
  if (status === "stopped") return endStream(stream);

  if (surface === "start") {
    if (status === "paused") {
      state.pauseType = stream.pauseType || null;
      setStatus("paused");
      return;
    }
    // Clips first, then the match from the beginning, behind live (#108)
    if (fromStart && hadClips) connectAt = { fromStart: true };
    setStatus("connecting");
    tryConnect();
    return;
  }

  // A period break (#109)
  if (status === "paused") {
    startHighlightCarousel();
    if (!state.isPlayingHighlights) showOverlay("Sändningen är pausad — återkommer snart", false);
    return;
  }
  // Resumed while the clips played: the match from where it was resumed
  if (resumedDuringReelAt && hadClips) connectAt = { resumedAt: resumedDuringReelAt };
  resumedDuringReelAt = 0;
  if (stream) useStreamUrl(stream);
  setStatus("connecting");
  tryConnect();
  announceResume();
}

/**
 * The match has ended: its end clips, if the viewer was watching, then the
 * end screen as before (#110).
 */
async function endStream(stream) {
  if (ending) return;
  ending = true;
  const id = state.currentStreamId;
  if (id && wasWatching() && claimTransition(`${id}:end`)) {
    stopHighlightCarousel();
    destroyHls();
    reelPending = true;
    const reel = await fetchSponsorReel("end", id);
    if (reel && state.currentStreamId === id) {
      hideOverlay();
      await playSponsorReel(reel.clips, reel.teamName, { surface: "end", streamId: id });
    }
    reelPending = false;
    if (state.currentStreamId !== id) return;
  }
  showOverlay("S\u00e4ndningen har avslutats", false);
  setTimeout(() => {
    if (state.currentStreamId === id) closePlayer();
  }, 2500);
}

/**
 * Open the VOD player.
 * Called from the VOD module when a VOD card is clicked.
 */
export function openVodPlayer(hlsUrl, title, vodId) {
  stopViewerHeartbeat();
  leaveViewerCount();
  forgetSponsorSurfaces();
  state.isVodMode = true;
  state.currentStreamUrl = mediaUrl(hlsUrl);
  state.currentStreamId = vodId;
  stopListPolling();
  stopVodPolling();

  dom.streamListView.classList.add("hidden");
  dom.vodListView.classList.add("hidden");
  dom.tabNav.classList.add("hidden");
  dom.playerView.classList.remove("hidden");

  dom.backBtnText.textContent = "Alla repriser";
  dom.streamTitle.textContent = title || "Repris";
  dom.streamDesc.textContent = "Inspelad match.";

  // Set VOD badge
  dom.liveBadge.textContent = "REPRIS";
  dom.liveBadge.className = "live-badge vod";
  state.currentStatus = "vod";

  setupProgressForVod();
  hideOverlay();
  loadReplayMarkers(vodId);
  tryConnectVod();
}

/**
 * Close the player and return to the list view.
 * Delegates tab-restoration to the orchestrator callback.
 */
export function closePlayer() {
  cancelSponsorReel();
  forgetSponsorSurfaces();
  reelPending = false;
  connectAt = null;
  stopHighlightCarousel();
  hideTapForSound();
  destroyHls();
  clearReplayMarkers();
  stopStreamPolling();
  stopViewerHeartbeat();
  leaveViewerCount();
  resetProgress();
  const wasVod = state.isVodMode;
  state.currentStreamUrl = null;
  state.currentStreamId = null;
  state.isVodMode = false;
  state.isDvrMode = false;

  dom.playerView.classList.add("hidden");
  dom.tabNav.classList.remove("hidden");

  setStatus("offline");

  if (onClosePlayer) onClosePlayer(wasVod);
}

// Exported for the visibilitychange handler in the orchestrator
export { startStreamPolling, stopStreamPolling, startViewerHeartbeat, stopViewerHeartbeat, pollCurrentStream };

// ============================
// Event binding
// ============================

function bindPlayerEvents() {
  dom.backBtn.addEventListener("click", closePlayer);
  bindTapForSound();

  dom.playBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlay();
  });
  dom.muteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMute();
  });
  dom.volumeSlider.addEventListener("input", onVolumeChange);
  dom.volumeSlider.addEventListener("click", (e) => e.stopPropagation());
  dom.fullscreenBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });

  // PiP button
  if (document.pictureInPictureEnabled) {
    dom.pipBtn.style.display = "";
  }
  dom.pipBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePip();
  });

  dom.qualityBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dom.qualityMenu.classList.toggle("open");
  });

  document.addEventListener("click", () => {
    dom.qualityMenu.classList.remove("open");
  });

  // Back to live (DVR)
  dom.backToLiveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    jumpToLive();
  });

  // Progress bar events
  dom.video.addEventListener("timeupdate", updateProgress);
  dom.video.addEventListener("seeking", onVideoSeeking);
  dom.video.addEventListener("seeked", onVideoSeeked);
  dom.video.addEventListener("loadedmetadata", updateProgress);
  // Seeking happens on mousedown/mouseup (onSeekStart/onSeekEnd). Clicks anywhere in the
  // control bar must not reach the wrapper's togglePlay — a click just beside the thin
  // progress bar, or a drag released outside it, would otherwise pause playback.
  dom.progressBar.addEventListener("mousedown", onSeekStart);
  dom.progressBar.addEventListener("touchstart", onSeekStart, { passive: false });
  dom.controls.addEventListener("click", (e) => {
    e.stopPropagation();
    dom.qualityMenu.classList.remove("open");
  });

  dom.video.addEventListener("play", updatePlayButton);
  dom.video.addEventListener("pause", updatePlayButton);
  dom.video.addEventListener("volumechange", updateMuteButton);

  document.addEventListener("fullscreenchange", updateFullscreenButton);
  document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
  dom.video.addEventListener("webkitbeginfullscreen", updateFullscreenButton);
  dom.video.addEventListener("webkitendfullscreen", () => {
    updateFullscreenButton();
    // iOS pauses when leaving native fullscreen; keep the UI in sync.
    updatePlayButton();
  });

  dom.wrapper.addEventListener("click", togglePlay);
  dom.wrapper.addEventListener("click", unlockResumeSignal);
  dom.wrapper.addEventListener("mousemove", showControls);
  dom.wrapper.addEventListener("touchstart", showControls);

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (dom.playerView.classList.contains("hidden")) return;
    // Sponsor clips: sound, fullscreen and leaving work; pausing and seeking do not (#106)
    if (isSponsorReelPlaying() && !["m", "f", "Escape"].includes(e.key)) {
      if (e.key === " " || e.key.startsWith("Arrow")) e.preventDefault();
      return;
    }
    switch (e.key) {
      case " ":
      case "k":
        e.preventDefault();
        togglePlay();
        break;
      case "m":
        toggleMute();
        break;
      case "f":
        toggleFullscreen();
        break;
      case "p":
        togglePip();
        break;
      case "ArrowLeft":
        if (canSeek()) {
          e.preventDefault();
          dom.video.currentTime = Math.max(0, dom.video.currentTime - 10);
        }
        break;
      case "ArrowRight":
        if (canSeek()) {
          e.preventDefault();
          dom.video.currentTime = Math.min(
            dom.video.duration || 0,
            dom.video.currentTime + 10
          );
        }
        break;
      case "Escape":
        closePlayer();
        break;
    }
  });
}

/**
 * Initialise the player module.
 * @param {Object} callbacks
 * @param {Function} callbacks.onClosePlayer - called when player closes; receives (wasVod: boolean)
 */
export function initPlayer(callbacks) {
  onClosePlayer = callbacks.onClosePlayer;
  bindPlayerEvents();
  initReplayMarkers();
}
