/**
 * Updating from the admin view.
 *
 * Only ever forward, to a release tag, and never during a broadcast: the site
 * is rebuilt and gone for minutes, which would cut the match off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const own = vi.hoisted(() => ({
  record: {
    id: "abc",
    name: "clubapi",
    gitUrl: "https://github.com/someone/courtside",
    sourceRef: "v0.3.3",
    buildStatus: "running",
  } as Record<string, unknown>,
  call: vi.fn(),
}));

vi.mock("../teardown.js", () => ({
  ownApp: async () => ({ club: "club", record: own.record }),
  call: own.call,
  deployBase: () => "https://deploy.example.com",
}));

const { newestRelease, isNewer, updateInfo, startUpdate, NotNow } = await import("../update.js");

function advertise(tags: string[]): string {
  return tags.map((t, i) => `003f${"0".repeat(40)} refs/tags/${t}${i === 0 ? "\0caps" : ""}`).join("\n");
}

beforeEach(() => {
  own.call.mockReset();
  own.record.sourceRef = "v0.3.3";
  own.record.buildStatus = "running";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(advertise(["v0.3.3", "v0.3.10", "v0.3.4"]))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("releases", () => {
  it("compares numerically, not as text", () => {
    expect(newestRelease(advertise(["v0.9.0", "v0.10.0", "v0.2.3"]))).toBe("v0.10.0");
    expect(isNewer("v0.3.10", "v0.3.9")).toBe(true);
    expect(isNewer("v0.3.3", "v0.3.3")).toBe(false);
  });

  it("puts a branch behind every release", () => {
    expect(isNewer("v0.1.0", "master")).toBe(true);
  });
});

describe("updateInfo", () => {
  it("offers the newest release with where to read about it", async () => {
    const info = await updateInfo();
    expect(info).toMatchObject({
      current: "v0.3.3",
      available: "v0.3.10",
      changelogUrl: "https://github.com/someone/courtside/blob/master/CHANGELOG.md",
    });
  });

  it("offers nothing on the newest release", async () => {
    own.record.sourceRef = "v0.3.10";
    expect((await updateInfo()).available).toBeUndefined();
  });
});

describe("startUpdate", () => {
  it("points the app at the newest release", async () => {
    expect(await startUpdate(0)).toBe("v0.3.10");
    expect(own.call).toHaveBeenCalledWith("PATCH", "https://deploy.example.com/myapps/abc/source-ref", { sourceRef: "v0.3.10" });
  });

  it("refuses during a broadcast", async () => {
    await expect(startUpdate(1)).rejects.toBeInstanceOf(NotNow);
    expect(own.call).not.toHaveBeenCalled();
  });

  it("refuses while a build is already running", async () => {
    own.record.buildStatus = "building";
    await expect(startUpdate(0)).rejects.toBeInstanceOf(NotNow);
  });

  it("never goes back", async () => {
    own.record.sourceRef = "v0.4.0";
    await expect(startUpdate(0)).rejects.toThrow(/senaste/);
    expect(own.call).not.toHaveBeenCalled();
  });
});
