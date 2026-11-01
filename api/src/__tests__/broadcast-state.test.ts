import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getBroadcastState,
  reportStatus,
  resetBroadcastState,
  streamStartedBy,
  type StreamStatusSource,
} from "../broadcast-state.js";

const at = () => new Date().toISOString();
const live = (): StreamStatusSource => ({ createdAt: at() });
const paused = (): StreamStatusSource => ({ createdAt: at(), pausedAt: at() });
const ended = (): StreamStatusSource => ({ createdAt: at(), stoppedAt: at() });

describe("broadcast-state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBroadcastState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to idle", () => {
    const state = getBroadcastState([]);
    expect(state.status).toBe("idle");
    expect(state.updatedAt).toBeTruthy();
    expect(state.upcoming).toEqual([]);
  });

  it("shows a camera's announcement with its message", () => {
    const before = getBroadcastState([]).updatedAt;
    vi.advanceTimersByTime(100);
    reportStatus("device:a", "upcoming", "Test IF vs AIK");
    const state = getBroadcastState([]);
    expect(state.status).toBe("upcoming");
    expect(state.message).toBe("Test IF vs AIK");
    expect(state.updatedAt).not.toBe(before);
    expect(state.upcoming).toEqual([{ message: "Test IF vs AIK", updatedAt: state.updatedAt }]);
  });

  it("shows every announced match, one per camera", () => {
    reportStatus("device:a", "upcoming", "P12 vs AIK");
    reportStatus("device:b", "upcoming", "F14 vs Hammarby");
    reportStatus("device:a", "upcoming", "P12 vs Djurgården"); // replaces a's own

    const state = getBroadcastState([]);
    expect(state.message).toBe("F14 vs Hammarby · P12 vs Djurgården");
    expect(state.upcoming).toHaveLength(2);
  });

  it("turns an announcement into the match once that camera's stream starts", () => {
    reportStatus("device:a", "upcoming", "P12 vs AIK");
    reportStatus("device:b", "upcoming", "F14 vs Hammarby");
    streamStartedBy("device:a");

    const state = getBroadcastState([live()]);
    expect(state.status).toBe("live");
    expect(state.upcoming.map((u) => u.message)).toEqual(["F14 vs Hammarby"]);
  });

  it('expires an announced "ended" to idle after 5 minutes', () => {
    reportStatus("device:a", "ended");
    expect(getBroadcastState([]).status).toBe("ended");

    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(getBroadcastState([]).status).toBe("ended");

    vi.advanceTimersByTime(1 * 60 * 1000 + 1);
    expect(getBroadcastState([]).status).toBe("idle");
  });

  it("restarts the 5 minutes on a repeated end, and an announcement replaces the end", () => {
    reportStatus("device:a", "ended");
    vi.advanceTimersByTime(4 * 60 * 1000);
    reportStatus("device:a", "ended");
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(getBroadcastState([]).status).toBe("ended");

    reportStatus("device:a", "upcoming");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(getBroadcastState([]).status).toBe("upcoming");
  });

  it("drops an announcement nobody followed up on after three hours", () => {
    reportStatus("device:a", "upcoming", "P12 vs AIK");
    vi.advanceTimersByTime(3 * 60 * 60 * 1000 + 1);
    expect(getBroadcastState([]).status).toBe("idle");
  });

  it("shows a stream that stopped as ended for 5 minutes", () => {
    const stream = ended();
    expect(getBroadcastState([stream]).status).toBe("ended");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(getBroadcastState([stream]).status).toBe("idle");
  });

  describe("two matches at once", () => {
    it("stays live when one match ends while the other is live", () => {
      expect(getBroadcastState([ended(), live()]).status).toBe("live");
    });

    it("stays live when one match pauses while the other is live", () => {
      expect(getBroadcastState([paused(), live()]).status).toBe("live");
    });

    it("is paused only when every match on is paused", () => {
      expect(getBroadcastState([paused(), paused(), ended()]).status).toBe("paused");
    });

    it("shows the next match once the only live one has ended", () => {
      reportStatus("device:b", "upcoming", "F14 vs Hammarby");
      const state = getBroadcastState([ended()]);
      expect(state.status).toBe("upcoming");
      expect(state.message).toBe("F14 vs Hammarby");
    });

    it("keeps an announcement made during another match", () => {
      reportStatus("device:b", "upcoming", "F14 vs Hammarby");
      const state = getBroadcastState([live()]);
      expect(state.status).toBe("live");
      expect(state.message).toBeUndefined();
      expect(state.upcoming.map((u) => u.message)).toEqual(["F14 vs Hammarby"]);
    });
  });

  describe("an older app's installation-wide calls", () => {
    it('cannot end the installation with "ended" while another match is live', () => {
      reportStatus("device:a", "ended");
      expect(getBroadcastState([live()]).status).toBe("live");
    });

    it('withdraws only its own announcement with "live", "paused" or "idle"', () => {
      reportStatus("device:a", "upcoming", "P12 vs AIK");
      reportStatus("device:b", "upcoming", "F14 vs Hammarby");
      reportStatus("device:a", "live");
      expect(getBroadcastState([]).message).toBe("F14 vs Hammarby");

      reportStatus("device:b", "idle");
      expect(getBroadcastState([]).status).toBe("idle");
    });

    it('cannot pause anything with "paused"', () => {
      reportStatus("device:a", "paused");
      expect(getBroadcastState([live()]).status).toBe("live");
      expect(getBroadcastState([]).status).toBe("idle");
    });

    it('lets the API key reset everything but live matches to idle', () => {
      reportStatus("device:a", "upcoming", "P12 vs AIK");
      const stopped = ended();
      vi.advanceTimersByTime(1000);
      reportStatus("api-key", "idle");
      expect(getBroadcastState([stopped]).status).toBe("idle");
      expect(getBroadcastState([stopped, live()]).status).toBe("live");
    });
  });
});
