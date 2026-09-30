// === Runtime configuration ===
//
// Nothing here is baked in at build time.  The same prebuilt bundle has to work
// for any club, so the backend URL is resolved when the page loads:
//
//   1. window.COURTSIDE_CONFIG.apiUrl   — set by runtime-config.js, which the
//                                         installer writes next to index.html
//   2. <meta name="courtside:api-url">  — for hand-edited deployments
//   3. the page's own origin            — when the API is reverse-proxied
//
// runtime-config.js is deliberately NOT bundled, so a club can change the
// backend URL without rebuilding anything.

function metaContent(name) {
  const el = document.querySelector(`meta[name="${name}"]`);
  return el ? el.getAttribute("content") : null;
}

function resolveApiUrl() {
  const runtime = window.COURTSIDE_CONFIG && window.COURTSIDE_CONFIG.apiUrl;
  const candidate = runtime || metaContent("courtside:api-url") || window.location.origin;
  // Tolerate a placeholder left unedited rather than firing requests at it.
  if (!candidate || candidate.includes("<") || candidate.includes("REPLACE")) {
    console.warn("[config] No API URL configured — falling back to page origin");
    return window.location.origin;
  }
  return candidate.replace(/\/$/, "");
}

export const CONFIG = {
  // Backend API URL
  API_URL: resolveApiUrl(),

  // How often to poll for stream list updates (ms)
  LIST_POLL_INTERVAL: 10000,

  // How often to poll HLS availability when offline (ms)
  STREAM_POLL_INTERVAL: 15000,

  // How often to poll for VOD list updates (ms)
  VOD_POLL_INTERVAL: 60000,
};
