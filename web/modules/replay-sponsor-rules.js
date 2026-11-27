// === When a replay plays sponsor clips (#167–#170) ===
//
// The rules only, with no DOM and no requests, so the API's test suite can
// run them (api/src/__tests__/replay-sponsor-rules.test.ts):
//
//   - "Hoppa över" shows 3 s into a clip, and only in a replay. (#167)
//   - start clips when the replay is played from its beginning. (#168)
//   - which period breaks there are: every pause that was not a timeout.
//     The first gives p1, the second p2, the third p3, the rest ot. (#169)
//   - that playback reached a break: it played across the break's start,
//     not a seek and not a jump. Each break once per opened replay. (#169)
//
// Live has its own rules in sponsors.js and player.js; these are not used there.

/** In a replay, "Hoppa över" shows this far into each clip (#167). */
export const SKIP_AFTER_S = 3;

/** Two timeupdates further apart than this were a jump, not playback (#169). */
export const MAX_PLAY_STEP_S = 2;

/** A replay opened this close to its beginning counts as played from the start (#168). */
const START_SLACK_S = 0.5;

/**
 * Whether "Hoppa över" shows now: only when the reel may be skipped (a
 * replay), once the clip really plays and is 3 s in.
 */
export function skipShown({ skippable, started, currentTime }) {
  return Boolean(skippable) && Boolean(started) && currentTime >= SKIP_AFTER_S;
}

/**
 * Whether opening a replay at `startAt` seconds gives the start clips: from
 * the beginning yes, opened somewhere in the match (a highlight, a link) no.
 */
export function replayStartClipsDue(startAt) {
  return !(startAt > START_SLACK_S);
}

/** The file name of a playlist URI, without its folder or query. */
export function fileName(uri) {
  return String(uri).split("?")[0].split("/").pop();
}

/**
 * The replay's pauses, in seconds into it, in order: [{ n, start, end, type }].
 * Pause segments are named pause{n}_…; the recording's `pauses` say which
 * pause was a timeout. Recordings from before pause types have no type, and
 * every pause counts as a period break, as the API does.
 *
 * @param {{ start: number, duration: number, uri?: string, file?: string }[]} frags
 * @param {{ n: number, type?: string }[]} pauses
 */
export function pauseSpans(frags, pauses) {
  const typeOf = new Map((Array.isArray(pauses) ? pauses : []).map((p) => [Number(p.n), p.type]));
  const spans = new Map();
  for (const f of frags ?? []) {
    const m = /^pause(\d+)_/.exec(f.file ?? fileName(f.uri ?? ""));
    if (!m) continue;
    const n = Number(m[1]);
    const span = spans.get(n) ?? { n, start: f.start, end: f.start, type: typeOf.get(n) ?? "period" };
    span.start = Math.min(span.start, f.start);
    span.end = Math.max(span.end, f.start + f.duration);
    spans.set(n, span);
  }
  return [...spans.values()].sort((a, b) => a.start - b.start);
}

/** The surface of the index-th period break, from 0: p1, p2, p3, then ot. */
export function breakSurface(index) {
  return ["p1", "p2", "p3"][index] ?? "ot";
}

/**
 * The replay's period breaks, timeouts left out: [{ n, start, end, surface, key }].
 * The fourth break and later are overtime, each its own `key`.
 */
export function periodBreakSpans(frags, pauses) {
  return pauseSpans(frags, pauses)
    .filter((s) => s.type !== "timeout")
    .map((s, i) => ({ n: s.n, start: s.start, end: s.end, surface: breakSurface(i), key: `break:${s.n}` }));
}

/**
 * The break that playback from `from` to `to` seconds reached, or null.
 * Only ordinary playback counts: not while seeking, not backwards, not a jump
 * of more than 2 s. A break in `played` has had its clips already. When one
 * step crosses two breaks (it cannot within 2 s, but still), the first wins.
 */
export function crossedBreak(breaks, from, to, { seeking = false, played } = {}) {
  if (seeking) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (to <= from || to - from > MAX_PLAY_STEP_S) return null;
  for (const b of breaks ?? []) {
    if (played?.has(b.key)) continue;
    if (from < b.start && to >= b.start) return b;
  }
  return null;
}
