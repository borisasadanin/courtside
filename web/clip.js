import Hls from "hls.js";
import { CONFIG } from "./modules/config.js";
import { club, loadClub } from "./modules/club.js";

(async function init() {
  // Theme first — the error state is branded too.
  await loadClub();

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
  document.title = `${label} — ${club.name}`;

  // Replace browser URL with /c/ format so copy-paste from address bar gives the OG-enabled URL
  history.replaceState(null, "", `/c/${encodeURIComponent(clip.id)}`);

  const video = document.getElementById("clipVideo");

  // Share button (always available — copies OG link for WhatsApp preview)
  setupShare(clip.id);

  if (clip.mp4Url) {
    video.src = clip.mp4Url;
    setupDownload(clip.mp4Url, label);
  } else if (clip.hlsUrl) {
    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 10 });
      hls.loadSource(clip.hlsUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = clip.hlsUrl;
    }
  }

  // Show play overlay — user click plays with sound (no autoplay)
  showPlayOverlay(video);
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

function setupDownload(mp4Url, label) {
  const btn = document.getElementById("downloadBtn");
  btn.style.display = "inline-flex";

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Laddar...";
    try {
      const res = await fetch(mp4Url);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${label}.mp4`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      window.open(mp4Url, "_blank");
    }
    btn.disabled = false;
    btn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>' +
      "</svg> Ladda ner";
  });
}
