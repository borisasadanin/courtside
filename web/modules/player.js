// === Player module ===
// HLS setup, video controls, overlay, progress bar, PiP, quality menu,
// seek, keyboard shortcuts, fullscreen, viewer heartbeat.

import Hls from "hls.js";
import { CONFIG } from "./config.js";
import { state, dom, MAX_RECONNECT_ATTEMPTS } from "./state.js";
import { formatTime } from "./utils.js";
import { authHeaders } from "./auth.js";
import { stopListPolling } from "./streams.js";
import { stopVodPolling } from "./vod.js";
import { fetchClipsForStream } from "./highlights.js";

// Callbacks injected by the orchestrator
let onClosePlayer = null; // called when player is closed (returns to list)

// Consecutive poll failure counter — only close player after multiple failures
let pollFailCount = 0;
const MAX_POLL_FAILURES = 6; // 6 × 5s = 30 seconds of consecutive failures before giving up

// ============================
// Status
// ============================

function setStatus(status) {
  if (status === state.currentStatus) return;
  state.currentStatus = status;

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
      dom.liveBadge.textContent = "PAUS";
      dom.liveBadge.className = "live-badge paused";
      showOverlay("Sändningen är pausad — återkommer snart", false);
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
  dom.progressBar.querySelectorAll(".pause-marker").forEach((el) => el.remove());
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

  state.hls.loadSource(state.currentStreamUrl);
  state.hls.attachMedia(dom.video);

  state.hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);
  state.hls.on(Hls.Events.ERROR, onHlsError);
  state.hls.on(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);
}

function startNative() {
  dom.video.src = state.currentStreamUrl;
  dom.video.addEventListener(
    "loadedmetadata",
    () => {
      setStatus("live");
      buildNativeQualityMenu();
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
    dom.video.addEventListener(
      "loadedmetadata",
      () => {
        buildNativeQualityMenu();
        dom.video.play().catch(() => {});
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
  });

  state.hls.loadSource(state.currentStreamUrl);
  state.hls.attachMedia(dom.video);

  state.hls.on(Hls.Events.MANIFEST_PARSED, () => {
    buildQualityMenu();
    dom.video.play().catch(() => {
      dom.video.muted = true;
      dom.video.play().catch(() => {});
      updateMuteButton();
    });
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

  state.hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
    const frags = data.details.fragments;
    const pauseTimes = frags
      .filter((f) => /pause\d+/.test(f.relurl))
      .map((f) => f.start);
    if (pauseTimes.length) {
      renderPauseMarkers(pauseTimes, data.details.totalduration);
    }
  });

  state.hls.on(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);
}

function renderPauseMarkers(times, duration) {
  dom.progressBar.querySelectorAll(".pause-marker").forEach((el) => el.remove());
  if (!duration) return;
  for (const t of times) {
    const marker = document.createElement("div");
    marker.className = "pause-marker";
    marker.style.left = (t / duration) * 100 + "%";
    dom.progressBar.appendChild(marker);
  }
}

// ============================
// HLS callbacks
// ============================

function onManifestParsed() {
  state.hlsReconnectAttempts = 0;
  if (!state.isVodMode && !state.liveStartTime) {
    state.liveStartTime = Date.now();
  }
  setStatus("live");
  buildQualityMenu();
  dom.video.play().catch(() => {
    dom.video.muted = true;
    dom.video.play().catch(() => {});
    updateMuteButton();
  });
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
    if (stream.status === "stopped") {
      showOverlay("S\u00e4ndningen har avslutats", false);
      setTimeout(closePlayer, 2500);
    } else if (stream.status === "paused") {
      // Stream was paused while we had an HLS error — show pause overlay
      setStatus("paused");
      destroyHls();
    } else if (stream.status === "waiting") {
      // Stream is resuming — wait for it to go live (polling will pick it up)
      setStatus("connecting");
      showOverlay("V\u00e4ntar p\u00e5 s\u00e4ndningen\u2026", true);
    } else {
      // Stream still exists — update URL and try reconnecting
      if (stream.hlsUrl) {
        state.currentStreamUrl = stream.hlsUrl;
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

function onLevelSwitched(_event, data) {
  if (state.hls && state.hls.autoLevelEnabled) {
    const level = state.hls.levels[data.level];
    dom.qualityLabel.textContent = `Auto (${level.height}p)`;
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

  state.hls.levels.forEach((level, i) => {
    const btn = document.createElement("button");
    btn.className = "quality-option";
    btn.textContent = `${level.height}p`;
    btn.dataset.level = i;
    btn.addEventListener("click", () => selectQuality(i));
    dom.qualityMenu.appendChild(btn);
  });
}

function buildNativeQualityMenu() {
  dom.qualityMenu.innerHTML = "";
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
    dom.qualityLabel.textContent = `${state.hls.levels[levelIndex].height}p`;
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
    // DVR: seekable timeline with live edge at duration
    const current = dom.video.currentTime || 0;
    const duration = dom.video.duration || 0;

    if (duration > 0 && isFinite(duration)) {
      const pct = (current / duration) * 100;
      dom.progressFilled.style.width = pct + "%";
      dom.progressHandle.style.left = pct + "%";
      dom.timeElapsed.textContent = formatTime(current);
      dom.timeDuration.textContent = "LIVE";

      // Show/hide "back to live" button based on distance from live edge
      const behindLive = duration - current;
      updateBackToLive(behindLive > 10);
    }

    updateBufferBar(duration);
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

function seekTo(ratio) {
  const duration = dom.video.duration;
  if (!duration || !isFinite(duration)) return;
  dom.video.currentTime = ratio * duration;
}

function canSeek() {
  return state.isVodMode || state.isDvrMode;
}

function onProgressClick(e) {
  if (!canSeek()) return;
  e.stopPropagation();
  const ratio = getSeekPosition(e);
  seekTo(ratio);
}

function onSeekStart(e) {
  if (!canSeek()) return;
  e.stopPropagation();
  state.isSeeking = true;
  dom.progressContainer.classList.add("seeking");

  const ratio = getSeekPosition(e);
  dom.progressFilled.style.width = ratio * 100 + "%";
  dom.progressHandle.style.left = ratio * 100 + "%";
  dom.timeElapsed.textContent = formatTime(ratio * dom.video.duration);

  document.addEventListener("mousemove", onSeekMove);
  document.addEventListener("mouseup", onSeekEnd);
  document.addEventListener("touchmove", onSeekMove, { passive: false });
  document.addEventListener("touchend", onSeekEnd);
}

function onSeekMove(e) {
  if (!state.isSeeking) return;
  e.preventDefault();
  const ratio = getSeekPosition(e);
  dom.progressFilled.style.width = ratio * 100 + "%";
  dom.progressHandle.style.left = ratio * 100 + "%";
  dom.timeElapsed.textContent = formatTime(ratio * dom.video.duration);
}

function onSeekEnd(e) {
  if (!state.isSeeking) return;
  const touch = e.changedTouches ? e.changedTouches[0] : e;
  const rect = dom.progressBar.getBoundingClientRect();
  const clientX = touch.clientX;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  seekTo(ratio);
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
  if (dom.video.paused) {
    dom.video.play();
  } else {
    dom.video.pause();
  }
}

// --- Back to live (DVR) ---

function updateBackToLive(show) {
  if (!dom.backToLiveBtn) return;
  dom.backToLiveBtn.classList.toggle("hidden", !show);
}

function jumpToLive() {
  if (!state.isDvrMode) return;
  const duration = dom.video.duration;
  if (duration && isFinite(duration)) {
    dom.video.currentTime = duration;
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
  dom.volumeSlider.value = dom.video.muted ? 0 : dom.video.volume;
  updateMuteButton();
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
}

function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    (dom.wrapper.requestFullscreen || dom.wrapper.webkitRequestFullscreen).call(
      dom.wrapper
    );
  }
}

function updateFullscreenButton() {
  const isFs = !!(
    document.fullscreenElement || document.webkitFullscreenElement
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
  if (!state.currentStreamId) return;

  console.info(`[carousel] Fetching clips for stream ${state.currentStreamId}…`);
  const clips = await fetchClipsForStream(state.currentStreamId);

  // Guard: status may have changed while fetching (e.g. broadcaster already resumed)
  if (state.currentStatus !== "paused") {
    console.info("[carousel] Status changed during fetch — aborting");
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

  // Update UI
  dom.liveBadge.textContent = "HÖJDPUNKTER";
  dom.liveBadge.className = "live-badge highlights";
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
      state.highlightHls.loadSource(clip.hlsUrl);
      state.highlightHls.attachMedia(dom.video);
      state.highlightHls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!state.isPlayingHighlights) return;
        consecutiveClipFailures = 0;
        hideOverlay();
        // Fade in
        dom.video.classList.remove("video-fade");
        dom.video.play().catch(() => {
          dom.video.muted = true;
          dom.video.play().catch(() => {});
        });
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
            dom.liveBadge.textContent = "PAUS";
            dom.liveBadge.className = "live-badge paused";
            showOverlay("Sändningen är pausad — återkommer snart", false);
            scheduleCarouselRetry(15_000);
            return;
          }
          playNextHighlight();
        }
      });
    } else if (dom.video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari native HLS
      dom.video.src = clip.hlsUrl;
      dom.video.addEventListener(
        "loadedmetadata",
        () => {
          if (!state.isPlayingHighlights) return;
          consecutiveClipFailures = 0;
          hideOverlay();
          dom.video.classList.remove("video-fade");
          dom.video.play().catch(() => {});
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
            dom.liveBadge.textContent = "PAUS";
            dom.liveBadge.className = "live-badge paused";
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
    if (stream.status === "stopped") {
      showOverlay("S\u00e4ndningen har avslutats", false);
      setTimeout(closePlayer, 2500);
    } else if (stream.status === "paused") {
      if (state.currentStatus !== "paused") {
        setStatus("paused");
        // Destroy current HLS to free resources while paused
        destroyHls();
      }
    } else if (stream.status === "waiting") {
      // Stream is resuming (new Restreamer process, waiting for RTMP input).
      // Show "connecting" so the viewer knows something is happening.
      if (state.currentStatus !== "connecting") {
        stopHighlightCarousel();
        setStatus("connecting");
      }
    } else if (stream.status === "live") {
      // Backend confirms stream is live — always reset reconnect budget
      state.hlsReconnectAttempts = 0;
      if (state.currentStatus !== "live") {
        stopHighlightCarousel();
        // Update stream URL — prefer DVR playlist for catch-up support
        if (stream.dvrUrl) {
          state.currentStreamUrl = `${CONFIG.API_URL}${stream.dvrUrl}`;
          state.isDvrMode = true;
        } else if (stream.hlsUrl) {
          state.currentStreamUrl = stream.hlsUrl;
        }
        setStatus("connecting");
        tryConnect();
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

function startViewerHeartbeat() {
  if (state.isVodMode) return; // No heartbeat for VOD
  stopViewerHeartbeat();
  sendViewerHeartbeat();
  state.viewerHeartbeatTimer = setInterval(sendViewerHeartbeat, 30_000);
}

function stopViewerHeartbeat() {
  clearInterval(state.viewerHeartbeatTimer);
}

function sendViewerHeartbeat() {
  if (!state.currentStreamId || state.isVodMode) return;
  fetch(`${CONFIG.API_URL}/api/streams/${state.currentStreamId}/view`, {
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

  state.isVodMode = false;
  // Use DVR playlist for catch-up capability; fall back to memfs live URL
  state.currentStreamUrl = dvrUrl ? `${CONFIG.API_URL}${dvrUrl}` : hlsUrl;
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
  tryConnect();
  startStreamPolling();
  startViewerHeartbeat();
}

/**
 * Open the VOD player.
 * Called from the VOD module when a VOD card is clicked.
 */
export function openVodPlayer(hlsUrl, title, vodId) {
  state.isVodMode = true;
  state.currentStreamUrl = hlsUrl;
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
  tryConnectVod();
}

/**
 * Close the player and return to the list view.
 * Delegates tab-restoration to the orchestrator callback.
 */
export function closePlayer() {
  stopHighlightCarousel();
  destroyHls();
  stopStreamPolling();
  stopViewerHeartbeat();
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
  dom.video.addEventListener("loadedmetadata", updateProgress);
  dom.progressBar.addEventListener("click", onProgressClick);
  dom.progressBar.addEventListener("mousedown", onSeekStart);
  dom.progressBar.addEventListener("touchstart", onSeekStart, { passive: false });
  dom.progressContainer.addEventListener("click", (e) => e.stopPropagation());

  dom.video.addEventListener("play", updatePlayButton);
  dom.video.addEventListener("pause", updatePlayButton);
  dom.video.addEventListener("volumechange", updateMuteButton);

  document.addEventListener("fullscreenchange", updateFullscreenButton);
  document.addEventListener("webkitfullscreenchange", updateFullscreenButton);

  dom.wrapper.addEventListener("click", togglePlay);
  dom.wrapper.addEventListener("mousemove", showControls);
  dom.wrapper.addEventListener("touchstart", showControls);

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (dom.playerView.classList.contains("hidden")) return;
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
}
