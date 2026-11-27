/**
 * #167–#170: when a replay plays sponsor clips. The rules live in the
 * website (web/modules/replay-sponsor-rules.js) with no DOM and no requests,
 * so they are run here as they are.
 */
import { describe, it, expect } from "vitest";
import {
  skipShown, replayStartClipsDue, replayEndPosition, pauseSpans, periodBreakSpans, crossedBreak, breakSurface,
  type BreakSpan, type Fragment,
} from "../../../web/modules/replay-sponsor-rules.js";

/**
 * A replay's fragments as the playlist lists them, 2 s each. `plan` is the
 * order of things: a number of match fragments, or a pause with its number.
 */
function replay(plan: (number | { pause: number; frags?: number })[]): Fragment[] {
  const frags: Fragment[] = [];
  let start = 0;
  let seg = 0;
  for (const step of plan) {
    const count = typeof step === "number" ? step : step.frags ?? 3;
    for (let i = 0; i < count; i++) {
      const name = typeof step === "number"
        ? `seg_${String(seg++).padStart(5, "0")}.ts`
        : `pause${step.pause}_${String(i).padStart(3, "0")}.ts`;
      frags.push({ start, duration: 2, uri: `/api/vod/v1/${name}?t=1` });
      start += 2;
    }
  }
  return frags;
}

/**
 * Play the replay as the player does: a timeupdate every `step` seconds,
 * seeks in between. Returns the surfaces whose clips played, in order. After
 * a break's clips the match goes on after the pause, as in the player.
 */
function watch(breaks: BreakSpan[], actions: ({ play: [number, number] } | { seek: number })[], step = 0.25) {
  const played = new Set<string>();
  const surfaces: string[] = [];
  let last: number | null = null;
  for (const action of actions) {
    if ("seek" in action) {
      last = null;
      continue;
    }
    let [t, end] = action.play;
    while (t <= end) {
      const brk = last === null ? null : crossedBreak(breaks, last, t, { played });
      last = t;
      if (brk) {
        played.add(brk.key);
        surfaces.push(brk.surface);
        t = brk.end;
        last = null;
        continue;
      }
      t += step;
    }
  }
  return surfaces;
}

// Three periods' breaks (pause 1, 3, 5) and two timeouts (pause 2, 4).
const pauses = [
  { n: 1, type: "period" },
  { n: 2, type: "timeout" },
  { n: 3, type: "period" },
  { n: 4, type: "timeout" },
  { n: 5, type: "period" },
];
const frags = replay([10, { pause: 1 }, 5, { pause: 2 }, 5, { pause: 3 }, 10, { pause: 4 }, 5, { pause: 5 }, 10]);

describe("\"Hoppa över\" (#167)", () => {
  it("shows in a replay only once the clip has played 3 s", () => {
    expect(skipShown({ skippable: true, started: true, currentTime: 0 })).toBe(false);
    expect(skipShown({ skippable: true, started: true, currentTime: 2.9 })).toBe(false);
    expect(skipShown({ skippable: true, started: true, currentTime: 3 })).toBe(true);
    expect(skipShown({ skippable: true, started: true, currentTime: 12 })).toBe(true);
    // A clip that has not started yet, whatever its time says
    expect(skipShown({ skippable: true, started: false, currentTime: 5 })).toBe(false);
  });

  it("never shows live", () => {
    expect(skipShown({ skippable: false, started: true, currentTime: 30 })).toBe(false);
    expect(skipShown({ started: true, currentTime: 30 })).toBe(false);
  });
});

describe("start clips in a replay (#168)", () => {
  it("play when the replay is played from the beginning", () => {
    expect(replayStartClipsDue(undefined)).toBe(true);
    expect(replayStartClipsDue(0)).toBe(true);
    expect(replayStartClipsDue(0.2)).toBe(true);
  });

  it("do not play when it is opened somewhere in the match, as on a highlight", () => {
    expect(replayStartClipsDue(42)).toBe(false);
    expect(replayStartClipsDue(1)).toBe(false);
  });
});

describe("period breaks of a replay (#169)", () => {
  it("are the pauses that were not timeouts, in order: p1, p2, p3", () => {
    const breaks = periodBreakSpans(frags, pauses);
    expect(breaks.map((b) => [b.n, b.surface, b.start, b.end])).toEqual([
      [1, "p1", 20, 26],
      [3, "p2", 52, 58],
      [5, "p3", 94, 100],
    ]);
    // The timeouts are still pauses: the markers show them.
    expect(pauseSpans(frags, pauses).filter((s) => s.type === "timeout").map((s) => s.n)).toEqual([2, 4]);
  });

  it("count the fourth break and later as overtime, each on its own", () => {
    const ot = replay([5, { pause: 1 }, 5, { pause: 2 }, 5, { pause: 3 }, 5, { pause: 4 }, 5, { pause: 5 }, 5]);
    const breaks = periodBreakSpans(ot, [1, 2, 3, 4, 5].map((n) => ({ n, type: "period" })));
    expect(breaks.map((b) => b.surface)).toEqual(["p1", "p2", "p3", "ot", "ot"]);
    expect(new Set(breaks.map((b) => b.key)).size).toBe(5);
    expect([0, 1, 2, 3, 7].map(breakSurface)).toEqual(["p1", "p2", "p3", "ot", "ot"]);
  });

  it("count every pause of a recording without pause types, as the API does", () => {
    expect(periodBreakSpans(frags, []).map((b) => b.surface)).toEqual(["p1", "p2", "p3", "ot", "ot"]);
    expect(periodBreakSpans(frags, undefined)).toHaveLength(5);
  });

  it("are none in a recording without pauses", () => {
    expect(periodBreakSpans(replay([30]), [])).toEqual([]);
  });
});

describe("reaching a break (#169)", () => {
  const breaks = periodBreakSpans(frags, pauses);
  const end = frags.length * 2;

  it("gives p1, p2 and p3 when the whole replay is played, and nothing at the timeouts", () => {
    expect(watch(breaks, [{ play: [0, end] }])).toEqual(["p1", "p2", "p3"]);
  });

  it("gives overtime its clips", () => {
    const ot = replay([5, { pause: 1 }, 5, { pause: 2 }, 5, { pause: 3 }, 5, { pause: 4 }, 5]);
    const otBreaks = periodBreakSpans(ot, [1, 2, 3, 4].map((n) => ({ n, type: "period" })));
    expect(watch(otBreaks, [{ play: [0, ot.length * 2] }])).toEqual(["p1", "p2", "p3", "ot"]);
  });

  it("gives nothing when the viewer seeks past a break", () => {
    // Seek from 10 s to 30 s, past p1 at 20 s, and play on to before p2
    expect(watch(breaks, [{ play: [0, 10] }, { seek: 30 }, { play: [30, 44] }])).toEqual([]);
    // The seeking flag alone stops it too
    expect(crossedBreak(breaks, 19.9, 20.1, { seeking: true })).toBeNull();
  });

  it("gives nothing for a jump of more than 2 s, even without a seek event", () => {
    expect(crossedBreak(breaks, 18, 20.5)).toBeNull();
    expect(crossedBreak(breaks, 19, 20.5)?.surface).toBe("p1");
    // Nor backwards
    expect(crossedBreak(breaks, 21, 19)).toBeNull();
  });

  it("does not give a break again after seeking back before it", () => {
    expect(watch(breaks, [{ play: [0, 30] }, { seek: 5 }, { play: [5, 30] }])).toEqual(["p1"]);
  });

  it("does give a break that was seeked past once playback reaches it", () => {
    expect(watch(breaks, [{ play: [0, 5] }, { seek: 30 }, { seek: 10 }, { play: [10, 30] }])).toEqual(["p1"]);
  });

  it("gives nothing when playback starts after the break, as from a period marker", () => {
    // P2's marker is the end of the first break's pause card
    expect(watch(breaks, [{ seek: 26 }, { play: [26, 44] }])).toEqual([]);
  });
});

describe("end clips in a replay (#170)", () => {
  it("leave the player standing at the replay's end, short of another \"ended\"", () => {
    expect(replayEndPosition(3600)).toBeCloseTo(3599.75);
    expect(replayEndPosition(3600)).toBeLessThan(3600);
    expect(replayEndPosition(0.1)).toBe(0);
    expect(replayEndPosition(NaN)).toBe(0);
    expect(replayEndPosition(Infinity)).toBe(0);
  });
});
