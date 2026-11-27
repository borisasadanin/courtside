// === The main sponsor's logo in the player's corner (#147, #148) ===
//
// The sponsor that has the surface "corner" for the match's team, or the
// club's when the team has none: top right on the picture, small and a
// little see-through, live and in replays. It is drawn under the controls
// and the overlays, so it never covers a button or the LIVE badge, and it is
// hidden while sponsor clips play (style.css, .sponsor-reel).
//
// iPhone Safari's own fullscreen shows only the <video>: nothing can be laid
// over it there, so the logo is not shown and not counted.
//
// For the sponsor's report the logo is counted as seen once it has been in
// view for 10 seconds in a row (#148): the page visible, the player on
// screen, the picture showing (no overlay over it) and no sponsor clip
// playing. Once per opened player; the server counts each viewer once.

import { CONFIG } from "./config.js";
import { dom, state } from "./state.js";
import { authHeaders } from "./auth.js";
import { mediaUrl } from "./utils.js";
import { getViewerId } from "./viewer-id.js";
import { fetchSponsorSurfaces, isSponsorReelPlaying } from "./sponsors.js";

/** In view this long in a row counts as seen. */
export const SEEN_AFTER_MS = 10_000;
const TICK_MS = 1000;

/** The logo on screen now: { el, img, sponsor, context, … }, or null. */
let current = null;
/** Each showCornerLogo() call; an answer for an older one is thrown away. */
let generation = 0;

/**
 * Show the corner logo for the stream ({ stream }) or replay ({ vod }) that
 * the player just opened. Nothing when the surface is off, no sponsor has
 * it, it has no logo, or the sponsors could not be fetched.
 */
export async function showCornerLogo(context) {
  hideCornerLogo();
  const mine = ++generation;
  const { surfaces } = await fetchSponsorSurfaces(context);
  if (mine !== generation || !dom.wrapper) return;
  const sponsor = Array.isArray(surfaces.corner) ? surfaces.corner[0] : null;
  if (!sponsor?.logoUrl) return;

  const el = document.createElement(sponsor.url ? "a" : "span");
  el.className = "sponsor-corner";
  const img = document.createElement("img");
  img.alt = `Huvudsponsor: ${sponsor.name}`;
  img.decoding = "async";
  if (sponsor.url) {
    el.href = sponsor.url;
    el.target = "_blank";
    el.rel = "noopener sponsored";
    // A tap on the logo opens the sponsor, not play or pause.
    el.addEventListener("click", (e) => e.stopPropagation());
  } else {
    el.setAttribute("aria-hidden", "true");
  }
  // A logo that will not load is no logo, never a broken image.
  img.addEventListener("error", () => hideCornerLogo(), { once: true });
  img.src = mediaUrl(sponsor.logoUrl);
  el.append(img);
  // Right after the video: under the controls, the banners and the overlay.
  dom.video.after(el);

  current = { el, img, sponsor, context, since: null, seen: false, inView: true, observer: null, timer: null };
  startMeasuring(current);
}

/** Take the logo away, as when the player closes or opens another match. */
export function hideCornerLogo() {
  generation++;
  if (!current) return;
  stopMeasuring(current);
  current.el.remove();
  current = null;
}

// ============================
// Seen for 10 s (#148)
// ============================

function startMeasuring(c) {
  if (typeof IntersectionObserver === "function") {
    c.observer = new IntersectionObserver((entries) => {
      for (const e of entries) c.inView = e.isIntersecting && e.intersectionRatio >= 0.5;
      if (!c.inView) c.since = null;
    }, { threshold: [0, 0.5, 1] });
    c.observer.observe(c.el);
  }
  // Hidden and back: the time before counts for nothing, however the timers were throttled.
  c.onVisibility = () => { c.since = null; };
  document.addEventListener("visibilitychange", c.onVisibility);
  c.timer = setInterval(() => tick(c), TICK_MS);
}

function stopMeasuring(c) {
  clearInterval(c.timer);
  c.observer?.disconnect();
  if (c.onVisibility) document.removeEventListener("visibilitychange", c.onVisibility);
}

/** Whether a viewer can see the logo right now. */
function visible(c) {
  if (document.hidden || !c.inView || !c.el.isConnected) return false;
  // iPhone's own fullscreen shows the video alone.
  if (dom.video.webkitDisplayingFullscreen) return false;
  if (isSponsorReelPlaying()) return false;
  // The overlay (connecting, paused, ended) darkens the picture and the logo with it.
  if (dom.overlay && !dom.overlay.classList.contains("hidden")) return false;
  // Hidden by the stylesheet (during clips, behind a pause banner on a phone).
  if (c.el.getClientRects().length === 0) return false;
  return c.img.complete && c.img.naturalWidth > 0;
}

function tick(c) {
  if (c.seen) return;
  if (!visible(c)) {
    c.since = null;
    return;
  }
  const now = Date.now();
  c.since ??= now;
  if (now - c.since < SEEN_AFTER_MS) return;
  c.seen = true;
  stopMeasuring(c);
  sendSeen(c);
}

/** One "seen" for the report. Fire and forget: a lost count never costs the match. */
function sendSeen(c) {
  const where = c.context.stream ? { stream: c.context.stream } : c.context.vod ? { vod: c.context.vod } : null;
  if (!where) return;
  try {
    fetch(`${CONFIG.API_URL}/api/sponsors/events`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        viewerId: getViewerId(),
        ...where,
        sponsorId: c.sponsor.id,
        surface: "corner",
        kind: "seen",
        mode: state.isVodMode ? "replay" : "live",
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // The count is lost, the match plays on
  }
}
