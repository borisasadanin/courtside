// === Deep-link module ===
// Deep links into the page:
//   #clip/<clip-id>     a highlight clip, played at once
//   /match/<match-id>   a match (ABL-050): the server fills in its link
//                       preview, the page opens where the match is shown

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
  if (!clipId) {
    const matchId = parseMatchPath();
    if (matchId) await openMatch(matchId, switchTab);
    return;
  }

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

/** Whether the page was opened on a clip or a match — it should open that, not Hantera. */
export function hasDeepLink() {
  return !!(parseClipHash() || parseMatchPath());
}

/** Parse clip ID from URL hash. Returns null if not a clip link. */
function parseClipHash() {
  const hash = window.location.hash;
  if (!hash) return null;
  const match = hash.match(/^#clip\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Match id from a /match/<id> path. Returns null for any other page. */
function parseMatchPath() {
  const match = window.location.pathname.match(/^\/match\/([A-Za-z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}

/**
 * Open the tab a match is shown on: Repriser once it has been played, the
 * live page while it is on or still to come (the upcoming list is there).
 * Then bring its card into view.
 */
async function openMatch(matchId, switchTab) {
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/matches/${encodeURIComponent(matchId)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      console.warn(`[deeplink] Match ${matchId} not found (${res.status})`);
      return;
    }
    const match = await res.json();
    switchTab(match.status === "ended" ? "vod" : "live");
    scrollToMatchCard(matchId);
  } catch (err) {
    console.warn("[deeplink] Failed to load match:", err);
  }
}

/** How long to wait for the lists to draw a match's card (ms). */
const CARD_WAIT_MS = 10000;

/**
 * Scroll to the card with data-match-id. The lists draw after their first
 * fetch, so wait for it a while; a match no list shows just leaves the tab open.
 */
function scrollToMatchCard(matchId) {
  const selector = `[data-match-id="${matchId}"]`;
  const show = (el) => el.scrollIntoView({ behavior: "smooth", block: "center" });
  const found = document.querySelector(selector);
  if (found) {
    show(found);
    return;
  }
  const observer = new MutationObserver(() => {
    const el = document.querySelector(selector);
    if (!el) return;
    observer.disconnect();
    clearTimeout(timer);
    show(el);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = setTimeout(() => observer.disconnect(), CARD_WAIT_MS);
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

/**
 * The link to a match: its preview in a chat shows the match's share image
 * (ABL-050), and opening it asks for the viewer code as usual.
 */
export function matchShareUrl(matchId) {
  return `${window.location.origin}/match/${encodeURIComponent(matchId)}`;
}

/**
 * Copy a match's link to the clipboard.
 * Returns true on success, false on failure.
 */
export async function copyMatchLink(matchId) {
  const url = matchShareUrl(matchId);
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}
