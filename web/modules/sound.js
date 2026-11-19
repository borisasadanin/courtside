// === Sound in the player (#104, #105) ===
//
// Browsers only play a video with sound when the viewer has interacted with
// the page, and Safari on iOS only when this very <video> was started by a tap.
// When play() with sound is refused, the video plays muted and a large
// "Tryck för ljud" button says so, instead of the sound just being gone.
//
// The viewer's latest choice, sound or not, is kept for the whole visit: the
// match, the highlights in a pause, the match again, the sponsor clips. A
// refusal by the browser is not a choice, so it does not change it.

import { dom } from "./state.js";

const KEY = "courtside-sound";

/** "on", "off", or null when the viewer has not chosen. */
let choice = read();

function read() {
  try {
    const v = sessionStorage.getItem(KEY);
    return v === "on" || v === "off" ? v : null;
  } catch {
    return null;
  }
}

/** Remember the viewer's choice for the rest of the visit, a reload included. */
export function setSoundChoice(on) {
  choice = on ? "on" : "off";
  try { sessionStorage.setItem(KEY, choice); } catch { /* private mode: kept in memory */ }
}

/** Sound unless the viewer turned it off. */
export function wantsSound() {
  return choice !== "off";
}

/** Whether the viewer has said they want sound, by a tap. */
export function choseSound() {
  return choice === "on";
}

/**
 * Call inside a tap or click. Starts and stops the player's video element
 * with sound, which is what lets later play() calls have sound, on iOS too.
 * Harmless when the element has nothing to play yet.
 */
export function unlockVideoSound() {
  const video = dom.video;
  if (!video) return;
  video.muted = !wantsSound();
  // A video that is already loaded is handled by playWithSound and "Tryck för ljud".
  if (video.currentSrc) return;
  try {
    // load() and play() inside the gesture are what Safari on iOS remembers.
    // play() with nothing to play is refused, which is expected here.
    video.load();
    video.play()?.catch(() => {});
  } catch { /* the gesture still counts */ }
}

/**
 * Play the video with the viewer's sound choice. If the browser refuses sound,
 * play muted and show "Tryck för ljud". Never throws.
 */
export async function playWithSound() {
  const video = dom.video;
  video.muted = !wantsSound();
  syncMuteButton();
  try {
    await video.play();
    if (!video.muted) hideTapForSound();
  } catch (err) {
    // NotAllowedError is the autoplay policy; anything else (an aborted load)
    // is not about sound and is left to the code that loads the video.
    if (err?.name !== "NotAllowedError" || video.muted) return;
    video.muted = true;
    syncMuteButton();
    try {
      await video.play();
      showTapForSound();
    } catch { /* not even muted: the overlay or the play button takes over */ }
  }
}

/** The viewer turned the sound on or off with the player's own controls. */
export function onMuteChangedByViewer() {
  const on = !dom.video.muted && dom.video.volume > 0;
  setSoundChoice(on);
  if (on) hideTapForSound();
}

export function showTapForSound() {
  dom.tapForSoundBtn?.classList.remove("hidden");
}

export function hideTapForSound() {
  dom.tapForSoundBtn?.classList.add("hidden");
}

/** Bind the "Tryck för ljud" button once. */
export function bindTapForSound() {
  const btn = dom.tapForSoundBtn;
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    dom.video.muted = false;
    if (dom.video.volume === 0) dom.video.volume = 1;
    setSoundChoice(true);
    syncMuteButton();
    hideTapForSound();
    dom.video.play().catch(() => {});
  });
}

function syncMuteButton() {
  const muted = dom.video.muted || dom.video.volume === 0;
  if (dom.iconVol) dom.iconVol.style.display = muted ? "none" : "block";
  if (dom.iconMuted) dom.iconMuted.style.display = muted ? "block" : "none";
  if (dom.volumeSlider) dom.volumeSlider.value = muted ? 0 : dom.video.volume;
}
