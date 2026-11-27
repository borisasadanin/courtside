import Hls from "hls.js";
import { CONFIG } from "./modules/config.js";
import { club, loadClub } from "./modules/club.js";
import { mediaUrl } from "./modules/utils.js";
import { initPrivacy } from "./modules/privacy.js";
import { getViewerId } from "./modules/viewer-id.js";

/** Played this long, the sponsor's logo counts as seen (#160). */
const SEEN_AFTER_SECONDS = 3;

(async function init() {
  // Theme first — the error state is branded too.
  await loadClub();
  initPrivacy();

  const clipId = parseHash();
  if (!clipId) return showError();

  try {
    const res = await fetch(`${CONFIG.API_URL}/api/clips/${encodeURIComponent(clipId)}/public`);
    if (!res.ok) return showError();
    const clip = await res.json();
    showClip(clip);
  } catch {
    showError();
  }
})();

function parseHash() {
  const h = window.location.hash;
  if (!h) return null;
  return decodeURIComponent(h.slice(1));
}

function showError() {
  document.getElementById("loading").style.display = "none";
  document.getElementById("error").style.display = "block";
}

function showClip(clip) {
  document.getElementById("loading").style.display = "none";
  document.getElementById("clipCard").style.display = "block";

  const label = clip.label || "Höjdpunkt";
  document.getElementById("clipLabel").textContent = label;
  document.getElementById("clipDur").textContent = `${Math.round(clip.durationSeconds)}s`;
  // The sponsor of shared clips (#159): only when the club has one, and only
  // on the page. No sponsor clip plays before the clip.
  if (clip.sponsor) showSponsor(clip.sponsor);
  // The match's MVP when this is its clip (#164): a number, never a name.
  if (clip.mvp) showMvp(clip.mvp);
  document.title = `${label} — ${club.name}`;

  // Replace browser URL with /c/ format so copy-paste from address bar gives the OG-enabled URL
  history.replaceState(null, "", `/c/${encodeURIComponent(clip.id)}`);

  const video = document.getElementById("clipVideo");

  // Share button (always available — copies OG link for WhatsApp preview)
  setupShare(clip.id);

  // A shared clip plays from its segments. Downloading is for viewers on the
  // site, behind the PIN, so this page offers no download.
  if (clip.hlsUrl) {
    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 10 });
      hls.loadSource(mediaUrl(clip.hlsUrl));
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = mediaUrl(clip.hlsUrl);
    }
  }

  // Show play overlay — user click plays with sound (no autoplay)
  showPlayOverlay(video);

  if (clip.sponsor) measureSeen(video, clip.id);
}

/** "Klippet presenteras av …" under the title, and the logo in the corner of the picture. */
function showSponsor(sponsor) {
  const line = document.createElement("div");
  line.className = "clip-page-sponsor";
  line.append("Klippet presenteras av ", sponsorName(sponsor));
  document.getElementById("clipLabel").after(line);

  if (!sponsor.logoUrl) return;
  const video = document.getElementById("clipVideo");
  const corner = document.createElement(sponsor.url ? "a" : "span");
  corner.className = "clip-page-sponsor-logo";
  if (sponsor.url) {
    corner.href = sponsor.url;
    corner.target = "_blank";
    corner.rel = "noopener sponsored";
    corner.setAttribute("aria-label", `${sponsor.name} (öppnas i ny flik)`);
  } else {
    corner.setAttribute("aria-hidden", "true");
  }
  const img = document.createElement("img");
  img.alt = sponsor.url ? "" : sponsor.name;
  img.decoding = "async";
  // A logo that will not load is no logo: the line still names the sponsor.
  img.addEventListener("error", () => corner.remove(), { once: true });
  img.src = mediaUrl(sponsor.logoUrl);
  corner.append(img);
  video.parentElement.style.position = "relative";
  video.after(corner);
}

/** "Matchens MVP: #12, presenteras av …", or just the number without a sponsor. */
function showMvp(mvp) {
  const line = document.createElement("div");
  line.className = "clip-page-sponsor clip-page-mvp";
  const num = document.createElement("strong");
  num.textContent = `#${mvp.jersey}`;
  line.append("Matchens MVP: ", num);
  if (mvp.sponsor) line.append(", presenteras av ", sponsorName(mvp.sponsor));
  const after = document.querySelector(".clip-page-info .clip-page-sponsor") || document.getElementById("clipLabel");
  after.after(line);
}

/** The sponsor's name, linked to its site when it has one. */
function sponsorName(sponsor) {
  if (!sponsor.url) return sponsor.name;
  const a = document.createElement("a");
  a.href = sponsor.url;
  a.target = "_blank";
  a.rel = "noopener sponsored";
  a.textContent = sponsor.name;
  return a;
}

/**
 * Count the sponsor as seen once the clip has played 3 s (#160): time
 * actually played, not a jump ahead. Once per page; the server counts each
 * viewer once and the id stays in this tab (sessionStorage).
 */
function measureSeen(video, clipId) {
  let played = 0;
  let last = null;
  const onTime = () => {
    const now = video.currentTime;
    if (last !== null && !video.paused && !video.seeking) {
      const step = now - last;
      if (step > 0 && step < 1.5) played += step;
    }
    last = now;
    if (played < SEEN_AFTER_SECONDS) return;
    video.removeEventListener("timeupdate", onTime);
    sendSeen(clipId);
  };
  video.addEventListener("timeupdate", onTime);
  video.addEventListener("seeking", () => { last = null; });
}

/** Fire and forget: a lost count never costs the viewer anything. */
function sendSeen(clipId) {
  try {
    fetch(`${CONFIG.API_URL}/api/clips/${encodeURIComponent(clipId)}/sponsor-seen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewerId: getViewerId() }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Not counted, nothing else
  }
}

function showPlayOverlay(video) {
  const overlay = document.createElement("button");
  overlay.className = "clip-play-overlay";
  overlay.setAttribute("aria-label", "Spela klipp");
  overlay.innerHTML =
    '<svg width="64" height="64" viewBox="0 0 24 24" fill="white" aria-hidden="true">' +
    '<polygon points="5 3 19 12 5 21 5 3"/>' +
    '</svg>';

  overlay.addEventListener("click", () => {
    video.play();
    overlay.remove();
  });

  // Also hide overlay if user clicks the native video controls
  video.addEventListener("play", () => overlay.remove(), { once: true });

  video.parentElement.style.position = "relative";
  video.parentElement.insertBefore(overlay, video.nextSibling);
}

function setupShare(clipId) {
  const btn = document.getElementById("shareBtn");
  btn.style.display = "inline-flex";

  const ogUrl = `${window.location.origin}/c/${encodeURIComponent(clipId)}`;

  btn.addEventListener("click", async () => {
    // Use Web Share API if available (native share sheet on mobile)
    if (navigator.share) {
      try {
        await navigator.share({ url: ogUrl });
        return;
      } catch {
        // User cancelled or share failed — fall through to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(ogUrl);
      btn.textContent = "Kopierad!";
      setTimeout(() => {
        btn.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>' +
          '<line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>' +
          "</svg> Dela";
      }, 1500);
    } catch {
      // Fallback: open in new tab
      window.open(ogUrl, "_blank");
    }
  });
}
