// === The main sponsor's logo in the player's corner (#147, #148) ===
//
// The sponsor that has the surface "corner" for the match's team, or the
// club's when the team has none: top right on the picture, small and a
// little see-through, live and in replays. It is drawn under the controls
// and the overlays, so it never covers a button or the LIVE badge, and it is
// hidden while sponsor clips play (style.css, .sponsor-reel).
//
// iPhone Safari's own fullscreen shows only the <video>: nothing can be laid
// over it there, so the logo is not shown.

import { dom } from "./state.js";
import { mediaUrl } from "./utils.js";
import { fetchSponsorSurfaces } from "./sponsors.js";

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

  current = { el, img, sponsor, context };
}

/** Take the logo away, as when the player closes or opens another match. */
export function hideCornerLogo() {
  generation++;
  if (!current) return;
  current.el.remove();
  current = null;
}
