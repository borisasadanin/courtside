// === Resume signal (ABL-004) ===
// A short chime when the match comes back after a pause, for a viewer who has
// the player open but is looking elsewhere. It is made with Web Audio rather
// than played from a file: nothing to bundle, and it is heard even when the
// video element is muted by the browser's autoplay policy.

let ctx = null;
let lastPlayedAt = 0;

/** Do not chime twice if the status flaps paused → waiting → paused within this window. */
const DEBOUNCE_MS = 30_000;

/**
 * Call from a user gesture (opening the player). Browsers — Safari on iOS in
 * particular — only allow audio that was started by one. If this fails, the
 * chime is simply not heard; the banner still says the match is back.
 */
export function unlockResumeSignal() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!ctx) ctx = new AudioCtx();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    // A silent buffer played inside the gesture is what unlocks iOS for good.
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    ctx = null;
  }
}

/** Play the chime, at most once per pause. Never throws. */
export function playResumeSignal() {
  const now = Date.now();
  if (now - lastPlayedAt < DEBOUNCE_MS) return;
  lastPlayedAt = now;
  if (!ctx || ctx.state !== "running") return;

  try {
    // Two rising notes, about 1.5 s in all — noticeable over a quiet room,
    // soft enough not to startle next to the match sound.
    const start = ctx.currentTime + 0.05;
    note(659.25, start, 0.6); // E5
    note(987.77, start + 0.35, 1.1); // B5
  } catch {
    // Audio is a bonus; the banner carries the message.
  }
}

function note(freq, at, duration) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + duration + 0.05);
}
