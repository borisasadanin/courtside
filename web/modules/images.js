// === Images module ===
// Covers, live pictures and clip thumbnails (ABL-045).
//
// The pictures sit behind the viewer PIN like the video, and an <img> cannot
// send the Authorization header. So each one is fetched with it, the way a clip
// is downloaded, and shown from a blob URL. They are kept per URL for as long
// as the page is open: the lists are rebuilt on every poll, and a picture that
// is already here is shown at once, without a flicker or a second fetch.

import { mediaUrl } from "./utils.js";
import { authHeaders } from "./auth.js";

/** url → blob URL, or null when it could not be loaded. */
const loaded = new Map();
/** url → Promise of the above, while it loads. */
const loading = new Map();
/** slot → the url it shows. A live card is a slot whose picture changes. */
const slots = new Map();

function load(url) {
  if (!loading.has(url)) {
    loading.set(url, (async () => {
      try {
        const res = await fetch(mediaUrl(url), { headers: authHeaders() });
        if (!res.ok) throw new Error(res.status);
        loaded.set(url, URL.createObjectURL(await res.blob()));
      } catch {
        loaded.set(url, null);
      }
      loading.delete(url);
      return loaded.get(url);
    })());
  }
  return loading.get(url);
}

/**
 * Show the picture at `url` in `img`. `onFail` runs when there is none to show.
 * With a `slot`, the slot's last picture stays up until the new one has loaded,
 * and also when the new one fails; once replaced it is let go.
 */
export function showImage(img, url, { slot, onFail } = {}) {
  img.dataset.src = url;
  const fallback = slot ? loaded.get(slots.get(slot)) : null;
  const show = (blobUrl) => {
    if (img.dataset.src !== url) return;
    if (blobUrl || fallback) img.src = blobUrl || fallback;
    else onFail?.();
  };

  if (loaded.has(url)) {
    show(loaded.get(url));
    return;
  }
  if (fallback) img.src = fallback;

  load(url).then((blobUrl) => {
    const old = slot && slots.get(slot);
    if (slot && blobUrl && old !== url) {
      slots.set(slot, url);
      if (old && loaded.get(old)) {
        URL.revokeObjectURL(loaded.get(old));
        loaded.delete(old);
      }
    }
    show(blobUrl);
  });
}
