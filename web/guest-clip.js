// === Shared guest clip (#54) ===
//
// A clip from a guest space, opened from a shared /g/<id> link. Neutral: no
// club logo, colour or name, only the match and a short note that a club can
// start its own installation. The product's name and address come from the
// API (#49), never from this file.

import { CONFIG } from "./modules/config.js";
import { mediaUrl } from "./modules/utils.js";

const $ = (id) => document.getElementById(id);

function showError() {
  $("loading").classList.add("hidden");
  $("error").classList.remove("hidden");
}

function showAd(product) {
  if (!product || !product.url) return;
  $("adText").textContent =
    `Med ${product.name} kan er förening filma och sända sina egna matcher – och dela höjdpunkterna precis så här.`;
  // The landing page greets visitors from a guest page at #gast.
  $("adLink").href = `${product.url}/#gast`;
  $("ad").classList.remove("hidden");
}

(async function init() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  if (!id) return showError();

  let clip;
  try {
    const res = await fetch(`${CONFIG.API_URL}/api/guest/clips/${encodeURIComponent(id)}/public`);
    if (!res.ok) return showError();
    clip = await res.json();
  } catch {
    return showError();
  }

  $("loading").classList.add("hidden");
  $("clip").classList.remove("hidden");

  const match = `${clip.homeTeam} – ${clip.awayTeam}`;
  document.title = `${clip.label || "Höjdpunkt"} — ${match}`;
  $("teams").textContent = match;
  const d = new Date(clip.matchDate);
  const date = isNaN(d) ? "" : d.toLocaleDateString("sv-SE", { day: "numeric", month: "long", year: "numeric" });
  $("meta").textContent = [clip.label, date].filter(Boolean).join(" · ");

  const video = $("video");
  if (clip.thumbnailUrl) video.poster = mediaUrl(clip.thumbnailUrl);
  video.src = mediaUrl(clip.mp4Url);

  // Copying the address bar gives the link with the preview.
  history.replaceState(null, "", `/g/${encodeURIComponent(clip.id)}`);

  showAd(clip.product);
})();
