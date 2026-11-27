/**
 * #167–#170: when a replay plays sponsor clips. The rules live in the
 * website (web/modules/replay-sponsor-rules.js) with no DOM and no requests,
 * so they are run here as they are.
 */
import { describe, it, expect } from "vitest";
import { skipShown, replayStartClipsDue } from "../../../web/modules/replay-sponsor-rules.js";

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
