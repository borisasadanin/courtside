import { describe, expect, it } from "vitest";
import { until, untilGone } from "./osc.js";

const timeout = () => new Error("never came up");

describe("until", () => {
  it("waits until the probe finds something", async () => {
    let lookups = 0;
    expect(await until(async () => (++lookups < 3 ? undefined : "https://x"), timeout, 1000, 1)).toBe("https://x");
    expect(lookups).toBe(3);
  });

  it("rides out a lookup that flickers between found and not found", async () => {
    // What OSC did with alanifconfig on 2026-11-17: there, 404, no address, then there.
    const answers: Array<() => string | undefined> = [
      () => "listed-but-not-running",
      () => { throw new Error("Instance alanifconfig of service eyevinn-app-config-svc not found"); },
      () => undefined,
      () => "https://alanifconfig",
    ];
    let i = 0;
    const url = await until(async () => {
      const r = answers[i++]();
      return r === "listed-but-not-running" ? undefined : r;
    }, timeout, 1000, 1);
    expect(url).toBe("https://alanifconfig");
  });

  it("throws the last lookup error after the deadline", async () => {
    await expect(until(async () => { throw new Error("not found"); }, timeout, 20, 1)).rejects.toThrow(/not found/);
  });

  it("throws the timeout error when the probe never finds anything", async () => {
    await expect(until(async () => undefined, timeout, 20, 1)).rejects.toThrow(/never came up/);
  });
});

describe("untilGone", () => {
  it("removes once when the thing stays gone", async () => {
    let removes = 0;
    await untilGone(async () => { removes++; }, async () => false, "x", 1000, 1, 3);
    expect(removes).toBe(1);
  });

  it("removes again when a store that answered 404 turns up later", async () => {
    let removes = 0;
    let removedSinceSeen = false;
    const seen = [false, true, false, false, false];
    let check = 0;
    await untilGone(
      async () => { removes++; removedSinceSeen = true; },
      async () => {
        const there = seen[Math.min(check++, seen.length - 1)];
        if (there) removedSinceSeen = false;
        return there;
      },
      "Parameter store alanifconfig", 1000, 1, 3,
    );
    expect(removes).toBe(2);
    expect(removedSinceSeen).toBe(true);
  });

  it("counts a failing lookup as still there", async () => {
    let check = 0;
    await untilGone(async () => undefined, async () => {
      if (check++ < 2) throw new Error("502");
      return false;
    }, "x", 1000, 1, 2);
    expect(check).toBe(4);
  });

  it("gives up after the deadline with the removal error", async () => {
    await expect(untilGone(async () => { throw new Error("403"); }, async () => true, "x", 20, 1)).rejects.toThrow(/403/);
  });
});
