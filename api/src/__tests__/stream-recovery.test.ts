/**
 * Surviving a restart.
 *
 * The segments of a match are in object storage as soon as they are collected.
 * What used to live only in the process was the knowledge of how to put them
 * back together — which part is current, which are finished, and in what order
 * the segments go. A redeploy during a match lost that, and the recording with
 * it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { streamMeta } from "../state.js";
import { saveStreamMeta, restoreStreamMeta } from "../stream-meta-store.js";
import { SegmentCollector } from "../segment-collector.js";

function storageStub() {
  let index: Record<string, unknown> = {};
  const files = new Map<string, string>();
  return {
    readStreamMetaIndex: vi.fn(async () => index),
    writeStreamMetaIndex: vi.fn(async (next: Record<string, unknown>) => {
      index = JSON.parse(JSON.stringify(next));
    }),
    readFile: vi.fn(async (key: string) => files.get(key) ?? null),
    uploadBuffer: vi.fn(async (key: string, body: string) => {
      files.set(key, String(body));
    }),
    get files() {
      return files;
    },
  };
}

const logger = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  streamMeta.clear();
  vi.clearAllMocks();
});

describe("stream metadata", () => {
  it("brings an unfinished match back after a restart", async () => {
    const storage = storageStub();
    streamMeta.set("abc123", {
      name: "Kamera 1",
      createdAt: "2026-10-01T18:00:00.000Z",
      partNumber: 3,
      completedParts: [1, 2],
    });

    await saveStreamMeta(storage as never, logger);
    streamMeta.clear(); // the restart

    const restored = await restoreStreamMeta(storage as never, logger);

    expect(restored).toEqual(["abc123"]);
    const meta = streamMeta.get("abc123");
    expect(meta?.partNumber).toBe(3);
    expect(meta?.completedParts).toEqual([1, 2]);
  });

  it("does not resurrect a match that already finished", async () => {
    const storage = storageStub();
    streamMeta.set("done", {
      name: "Kamera 1",
      createdAt: "2026-10-01T18:00:00.000Z",
      stoppedAt: "2026-10-01T19:30:00.000Z",
      partNumber: 1,
      completedParts: [],
    });

    await saveStreamMeta(storage as never, logger);
    streamMeta.clear();

    expect(await restoreStreamMeta(storage as never, logger)).toEqual([]);
    expect(streamMeta.size).toBe(0);
  });

  it("remembers that a match was paused, so resume still works", async () => {
    const storage = storageStub();
    streamMeta.set("paused1", {
      name: "Kamera 1",
      createdAt: "2026-10-01T18:00:00.000Z",
      pausedAt: "2026-10-01T18:20:00.000Z",
      partNumber: 2,
      completedParts: [1],
    });

    await saveStreamMeta(storage as never, logger);
    streamMeta.clear();
    await restoreStreamMeta(storage as never, logger);

    expect(streamMeta.get("paused1")?.pausedAt).toBe("2026-10-01T18:20:00.000Z");
  });

  it("starts empty rather than crashing when storage is unreadable", async () => {
    const storage = {
      readStreamMetaIndex: vi.fn().mockRejectedValue(new Error("unreachable")),
    };
    expect(await restoreStreamMeta(storage as never, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("never fails a broadcast because metadata could not be written", async () => {
    const storage = {
      writeStreamMetaIndex: vi.fn().mockRejectedValue(new Error("storage down")),
    };
    streamMeta.set("abc", {
      name: "K",
      createdAt: "2026-10-01T18:00:00.000Z",
      partNumber: 1,
      completedParts: [],
    });

    await expect(saveStreamMeta(storage as never, logger)).resolves.toBeUndefined();
  });

  it("tolerates a corrupt index instead of refusing to start", async () => {
    const storage = {
      readStreamMetaIndex: vi.fn(async () => ({
        broken: null,
        partial: { name: "K", createdAt: "2026-10-01T18:00:00.000Z" },
      })),
    };

    const restored = await restoreStreamMeta(storage as never, logger);

    expect(restored).toEqual(["partial"]);
    // Missing fields get sane values rather than undefined arithmetic later.
    expect(streamMeta.get("partial")?.partNumber).toBe(1);
    expect(streamMeta.get("partial")?.completedParts).toEqual([]);
  });
});

describe("segment timeline", () => {
  it("is checkpointed and read back, so stitching survives a restart", async () => {
    const storage = storageStub();
    const collector = new SegmentCollector(
      "abc123",
      "https://restreamer.example.com",
      storage as never,
      logger as never,
      2
    );

    // Pretend a poll saved two segments, then checkpoint.
    (collector as unknown as { segmentOrder: unknown[] }).segmentOrder = [
      { filename: "seg01.ts", duration: 2, savedAt: 1_700_000_000_000 },
      { filename: "seg02.ts", duration: 2, savedAt: 1_700_000_002_000 },
    ];
    (collector as unknown as { dirty: boolean }).dirty = true;
    await (collector as unknown as { checkpoint: () => Promise<void> }).checkpoint();

    const recovered = await SegmentCollector.readCheckpoint(storage as never, "abc123", 2);
    expect(recovered).toHaveLength(2);
    expect(recovered[0].filename).toBe("seg01.ts");
  });

  it("seeds a recovered collector so segments are not uploaded twice", async () => {
    const storage = storageStub();
    const collector = new SegmentCollector(
      "abc123",
      "https://restreamer.example.com",
      storage as never,
      logger as never,
      1,
      [{ filename: "seg01.ts", duration: 2, savedAt: 1_700_000_000_000 }]
    );

    const timeline = collector.getSegmentTimeline();
    expect(timeline).toHaveLength(1);
    expect(timeline[0].key).toBe("abc123/p1_seg01.ts");
  });

  it("returns an empty timeline when there is no checkpoint to read", async () => {
    const storage = storageStub();
    expect(await SegmentCollector.readCheckpoint(storage as never, "nope", 1)).toEqual([]);
  });

  it("ignores a corrupt checkpoint rather than losing the stream", async () => {
    const storage = storageStub();
    await storage.uploadBuffer("abc/p1.timeline.json", "{not json");
    expect(await SegmentCollector.readCheckpoint(storage as never, "abc", 1)).toEqual([]);
  });
});
