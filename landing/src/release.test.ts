import { describe, expect, it } from "vitest";
import { newestRelease } from "./release.js";

const sha = "0af247f0000000000000000000000000000000000";

/** What a git server answers on info/refs, roughly. */
function advertise(refs: string[]): string {
  return [
    "001e# service=git-upload-pack",
    `0000${sha} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/master`,
    ...refs.map((r) => `003f${sha} ${r}`),
    "0000",
  ].join("\n");
}

describe("newestRelease", () => {
  it("picks the highest version by number, not by text", () => {
    expect(newestRelease(advertise(["refs/tags/v0.9.0", "refs/tags/v0.10.0", "refs/tags/v0.2.3"]))).toBe("v0.10.0");
  });

  it("ignores branches, peeled tags and tags that are not releases", () => {
    const refs = ["refs/heads/v9.9.9", "refs/tags/v0.1.0", "refs/tags/v0.1.0^{}", "refs/tags/v2.0.0-rc1", "refs/tags/latest"];
    expect(newestRelease(advertise(refs))).toBe("v0.1.0");
  });

  it("finds nothing in a repository without releases", () => {
    expect(newestRelease(advertise(["refs/heads/master"]))).toBeUndefined();
  });
});
