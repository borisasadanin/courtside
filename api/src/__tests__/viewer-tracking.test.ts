import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  viewers,
  registerViewer,
  removeViewer,
  getViewerCount,
  isValidViewerId,
  MAX_VIEWERS_PER_STREAM,
} from "../viewer-tracking.js";

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";

describe("viewer tracking", () => {
  beforeEach(() => viewers.clear());
  afterEach(() => vi.useRealTimers());

  it("counts one player once, however often it sends", () => {
    registerViewer("s1", A);
    registerViewer("s1", A);
    registerViewer("s1", A);
    expect(getViewerCount("s1")).toBe(1);
  });

  it("counts two players as two, and keeps streams apart", () => {
    registerViewer("s1", A);
    registerViewer("s1", B);
    registerViewer("s2", A);
    expect(getViewerCount("s1")).toBe(2);
    expect(getViewerCount("s2")).toBe(1);
  });

  it("drops a player that leaves at once", () => {
    registerViewer("s1", A);
    registerViewer("s1", B);
    removeViewer("s1", A);
    expect(getViewerCount("s1")).toBe(1);
  });

  it("drops a player not heard from in a minute", () => {
    vi.useFakeTimers();
    registerViewer("s1", A);
    vi.advanceTimersByTime(30_000);
    registerViewer("s1", B);
    vi.advanceTimersByTime(31_000);
    expect(getViewerCount("s1")).toBe(1);
  });

  it("stops at the cap but makes room once old players are gone", () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAX_VIEWERS_PER_STREAM; i++) registerViewer("s1", `viewer-${String(i).padStart(8, "0")}`);
    registerViewer("s1", A);
    expect(getViewerCount("s1")).toBe(MAX_VIEWERS_PER_STREAM);
    vi.advanceTimersByTime(61_000);
    registerViewer("s1", A);
    expect(getViewerCount("s1")).toBe(1);
  });

  it("only accepts ids like the player makes", () => {
    expect(isValidViewerId("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isValidViewerId(undefined)).toBe(false);
    expect(isValidViewerId("short")).toBe(false);
    expect(isValidViewerId("x".repeat(65))).toBe(false);
    expect(isValidViewerId("has spaces in it")).toBe(false);
  });
});
