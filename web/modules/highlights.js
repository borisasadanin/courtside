// === Highlights module ===
// Clip player for highlight clips. Fetching/rendering is handled by vod.js.

import Hls from "hls.js";
import { CONFIG } from "./config.js";
import { state, dom } from "./state.js";
import { authHeaders } from "./auth.js";
import { clearHash } from "./deeplink.js";

let clipHls = null; // separate HLS.js instance for clip playback

// ============================
// Fetch clips from API
// ============================

/** Fetch all persistent clips from GET /api/clips */
export async function fetchAllClips() {
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/clips`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      console.warn(`[highlights] GET /api/clips returned ${res.status}`);
      return [];
    }
    return await res.json();
  } catch (err) {
    console.warn("[highlights] GET /api/clips failed:", err);
    return [];
  }
}

/**
 * Fetch clips for the carousel during pause.
 * Merges persistent index (GET /api/clips) with in-memory live clips
 * (GET /api/streams/:id/clips) and deduplicates by clip ID.
 * Falls back gracefully if either endpoint fails.
 */
export async function fetchClipsForStream(streamId) {
  const headers = authHeaders();

  const [persistent, live] = await Promise.allSettled([
    fetch(`${CONFIG.API_URL}/api/clips`, { headers })
      .then((r) => {
        if (!r.ok) {
          console.warn(`[highlights] GET /api/clips → ${r.status}`);
          return [];
        }
        return r.json();
      })
      .catch((err) => {
        console.warn("[highlights] GET /api/clips failed:", err);
        return [];
      }),

    fetch(`${CONFIG.API_URL}/api/streams/${streamId}/clips`, { headers })
      .then((r) => {
        if (!r.ok) {
          console.warn(`[highlights] GET /api/streams/${streamId}/clips → ${r.status}`);
          return [];
        }
        return r.json();
      })
      .catch((err) => {
        console.warn(`[highlights] GET /api/streams/${streamId}/clips failed:`, err);
        return [];
      }),
  ]);

  const persistentClips = persistent.status === "fulfilled" ? persistent.value : [];
  const liveClips = live.status === "fulfilled" ? live.value : [];

  // Merge and deduplicate by clip ID, filter to this stream
  const seen = new Set();
  const merged = [...persistentClips, ...liveClips]
    .filter((c) => {
      if (c.streamId !== streamId) return false;
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    // Sort newest first
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  console.info(
    `[highlights] fetchClipsForStream(${streamId}): ` +
    `${persistentClips.length} persistent + ${liveClips.length} live → ${merged.length} unique`
  );

  return merged;
}

// ============================
// Clip Player (mini-player)
// ============================

export function playClip(hlsUrl) {
  const container = dom.clipPlayer;
  const video = dom.clipVideo;
  if (!container || !video || !hlsUrl) return;

  destroyClipPlayer();

  container.classList.remove("hidden");

  if (Hls.isSupported()) {
    clipHls = new Hls({
      maxBufferLength: 10,
      maxMaxBufferLength: 20,
    });
    clipHls.loadSource(hlsUrl);
    clipHls.attachMedia(video);
    clipHls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    clipHls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        destroyClipPlayer();
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Safari native HLS
    video.src = hlsUrl;
    video.addEventListener("loadedmetadata", () => {
      video.play().catch(() => {});
    }, { once: true });
    video.addEventListener("error", () => {
      destroyClipPlayer();
    }, { once: true });
  }

  // Auto-close when clip finishes
  video.addEventListener("ended", () => {
    const inWebkitFs = video.webkitDisplayingFullscreen;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    const inFs = inWebkitFs || (fsEl && container.contains(fsEl));

    if (!inFs) {
      // Not in fullscreen — close immediately
      destroyClipPlayer();
      return;
    }

    // In fullscreen — exit first, then close once the exit actually completes.
    // (hiding the element before fullscreen exits causes the browser to stay
    // in fullscreen showing a black screen)
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      document.removeEventListener("fullscreenchange", finish);
      document.removeEventListener("webkitfullscreenchange", finish);
      video.removeEventListener("webkitendfullscreen", finish);
      destroyClipPlayer();
    };
    document.addEventListener("fullscreenchange", finish);
    document.addEventListener("webkitfullscreenchange", finish);
    video.addEventListener("webkitendfullscreen", finish, { once: true });
    setTimeout(finish, 1500); // safety fallback if events never fire

    if (inWebkitFs) {
      video.webkitExitFullscreen();
    } else {
      try {
        const p = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        if (p && p.catch) p.catch(finish);
      } catch (_) { finish(); }
    }
  }, { once: true });
}

export function destroyClipPlayer() {
  clearHash();
  if (clipHls) {
    clipHls.destroy();
    clipHls = null;
  }
  // Exit fullscreen if close button / error triggers destroy while in fullscreen
  if (dom.clipVideo && dom.clipVideo.webkitDisplayingFullscreen) {
    dom.clipVideo.webkitExitFullscreen();
  }
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl && dom.clipPlayer && dom.clipPlayer.contains(fsEl)) {
    try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (_) {}
  }
  if (dom.clipVideo) {
    dom.clipVideo.pause();
    dom.clipVideo.removeAttribute("src");
  }
  if (dom.clipPlayer) {
    dom.clipPlayer.classList.add("hidden");
  }
}

// ============================
// Init
// ============================

export function initHighlights() {
  // Close button for clip player
  const closeBtn = document.getElementById("clipPlayerClose");
  if (closeBtn) {
    closeBtn.addEventListener("click", destroyClipPlayer);
  }
}
