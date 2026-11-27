// === When a replay plays sponsor clips (#167–#170) ===
//
// The rules only, with no DOM and no requests, so the API's test suite can
// run them (api/src/__tests__/replay-sponsor-rules.test.ts):
//
//   - "Hoppa över" shows 3 s into a clip, and only in a replay. (#167)
//   - start clips when the replay is played from its beginning. (#168)
//
// Live has its own rules in sponsors.js and player.js; these are not used there.

/** In a replay, "Hoppa över" shows this far into each clip (#167). */
export const SKIP_AFTER_S = 3;

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

