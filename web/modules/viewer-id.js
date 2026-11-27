// === The viewer's id ===
//
// A random id per tab, kept over a reload so the same person is not counted
// twice. The server counts viewers by it, not by IP address: behind the
// platform's proxies every request looks like it comes from a proxy.
//
// The heartbeat (player.js) and the sponsor events (sponsors.js, #140) use
// the same id, so a viewer is one viewer to both. The server keeps it in
// memory only and never stores it.

const VIEWER_ID_KEY = "courtside-viewer-id";
let viewerId = null;

export function getViewerId() {
  if (viewerId) return viewerId;
  try {
    viewerId = sessionStorage.getItem(VIEWER_ID_KEY);
  } catch {
    // Storage blocked: an id for this page load only
  }
  if (!viewerId || !/^[A-Za-z0-9_-]{8,64}$/.test(viewerId)) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    viewerId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    try {
      sessionStorage.setItem(VIEWER_ID_KEY, viewerId);
    } catch {
      // Fine: counted as a new viewer after a reload, gone from the old count within a minute
    }
  }
  return viewerId;
}
