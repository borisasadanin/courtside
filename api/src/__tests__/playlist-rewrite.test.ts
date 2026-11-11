import { describe, it, expect } from "vitest";
import { feedOf, markFeedRestarts } from "../playlist-rewrite.js";

describe("feedOf", () => {
  it("names the part and the restart run", () => {
    expect(feedOf("p2_ab12cd34_p2_17.ts")).toBe("p2/r0");
    expect(feedOf("p2_r1_ab12cd34_p2_3.ts")).toBe("p2/r1");
    expect(feedOf("pause1_seg_00000.ts")).toBe("pause1/r0");
    expect(feedOf("something.ts")).toBeNull();
  });
});

describe("markFeedRestarts", () => {
  const header = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0";

  it("marks a restart within a part", () => {
    const manifest = [
      header,
      "#EXTINF:2.0,", "p1_ab12cd34_1.ts",
      "#EXTINF:2.0,", "p1_ab12cd34_2.ts",
      "#EXTINF:2.0,", "p1_r1_ab12cd34_0.ts",
      "#EXTINF:2.0,", "p1_r1_ab12cd34_1.ts",
      "#EXT-X-ENDLIST", "",
    ].join("\n");
    const out = markFeedRestarts(manifest).split("\n");
    expect(out.filter((l) => l === "#EXT-X-DISCONTINUITY")).toHaveLength(1);
    const i = out.indexOf("#EXT-X-DISCONTINUITY");
    expect(out.slice(i, i + 3)).toEqual(["#EXT-X-DISCONTINUITY", "#EXTINF:2.0,", "p1_r1_ab12cd34_0.ts"]);
  });

  it("puts the tag before every tag of the segment, as in the DVR playlist", () => {
    const manifest = [
      header,
      "#EXT-X-PROGRAM-DATE-TIME:2026-11-08T10:00:00.000Z", "#EXTINF:2.0,", "/api/media/s/p1_ab_1.ts",
      "#EXT-X-PROGRAM-DATE-TIME:2026-11-08T10:00:02.000Z", "#EXTINF:2.0,", "/api/media/s/p1_r1_ab_0.ts",
    ].join("\n");
    const out = markFeedRestarts(manifest).split("\n");
    const i = out.indexOf("#EXT-X-DISCONTINUITY");
    expect(out[i + 1]).toBe("#EXT-X-PROGRAM-DATE-TIME:2026-11-08T10:00:02.000Z");
  });

  it("leaves boundaries that are already marked, and is idempotent", () => {
    const manifest = [
      header,
      "#EXTINF:2.0,", "p1_ab_1.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:4.0,", "pause1_seg_00000.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:2.0,", "p2_ab_p2_0.ts",
      "#EXTINF:2.0,", "p2_r1_ab_p2_0.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const once = markFeedRestarts(manifest);
    expect(once.split("\n").filter((l) => l === "#EXT-X-DISCONTINUITY")).toHaveLength(3);
    expect(markFeedRestarts(once)).toBe(once);
  });

  it("changes nothing in a playlist without restarts", () => {
    const manifest = [header, "#EXTINF:2.0,", "p1_ab_1.ts", "#EXTINF:2.0,", "p1_ab_2.ts", "#EXT-X-ENDLIST", ""].join("\n");
    expect(markFeedRestarts(manifest)).toBe(manifest);
  });
});
