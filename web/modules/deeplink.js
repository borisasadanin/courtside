// === Deep-link module ===
// Hash-based deep-linking for highlight clips.
// URL format: #clip/<clip-id>

import { CONFIG } from "./config.js";
import { authHeaders } from "./auth.js";

/**
 * Check URL hash on page load and play the referenced clip.
 * Should be called after auth is complete (viewer token available).
 * @param {Object} callbacks
 * @param {Function} callbacks.switchTab - switch to a tab (e.g. "vod")
 * @param {Function} callbacks.playClip - play a clip by HLS URL
 */
export async function checkDeepLink({ switchTab, playClip }) {
  const clipId = parseClipHash();
  if (!clipId) return;

  try {
    const res = await fetch(`${CONFIG.API_URL}/api/clips/${encodeURIComponent(clipId)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      console.warn(`[deeplink] Clip ${clipId} not found (${res.status})`);
      clearHash();
      return;
    }
    const clip = await res.json();
    switchTab("vod");
    playClip(clip.hlsUrl);
  } catch (err) {
    console.warn("[deeplink] Failed to load clip:", err);
    clearHash();
  }
}

/** Parse clip ID from URL hash. Returns null if not a clip link. */
function parseClipHash() {
  const hash = window.location.hash;
  if (!hash) return null;
  const match = hash.match(/^#clip\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Build a shareable URL for a clip (via Cloudflare Worker, for a clean URL on the club's own domain). */
export function getShareUrl(clipId) {
  return `${window.location.origin}/c/${encodeURIComponent(clipId)}`;
}

/** Set URL hash to point to a clip (without triggering navigation). */
export function setClipHash(clipId) {
  history.replaceState(null, "", `#clip/${encodeURIComponent(clipId)}`);
}

/** Remove clip hash from URL. */
export function clearHash() {
  if (!window.location.hash) return;
  history.replaceState(null, "", window.location.pathname + window.location.search);
}

/**
 * Copy a clip's share URL to clipboard.
 * Returns true on success, false on failure.
 */
export async function copyClipLink(clipId) {
  const url = getShareUrl(clipId);
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}
