/**
 * Guest space retention (#52): the whole space goes 14 days after its match.
 */
import { describe, it, expect } from "vitest";
import {
  GuestSpaces,
  GUEST_INDEX_KEY,
  guestMp4Key,
  guestThumbnailKey,
  type GuestClip,
  type GuestMatchInfo,
} from "../guest-spaces.js";
import { cleanupGuestSpaces } from "../guest-cleanup.js";
import { DELETION_LOG_KEY, readDeletionLog } from "../erasure.js";

const DAY = 24 * 60 * 60 * 1000;

function memoryStorage() {
  const files = new Map<string, string>();
  return {
    files,
    async readFileIfExists(key: string) {
      return files.get(key) ?? null;
    },
    async uploadBuffer(key: string, body: Buffer | string) {
      files.set(key, body.toString());
    },
    async deletePrefix(prefix: string) {
      let n = 0;
      for (const key of [...files.keys()]) if (key.startsWith(prefix)) { files.delete(key); n++; }
      return n;
    },
  };
}

function match(streamId: string, awayTeam = "Nacka"): GuestMatchInfo {
  return { streamId, matchId: `m-${streamId}`, homeTeam: "Älta", awayTeam, matchDate: "2026-11-07" };
}

function clip(id: string, createdAt: string): GuestClip {
  return { id, mp4Url: `/api/guest/clips/${id}/media/${id}.mp4`, durationSeconds: 8, createdAt };
}

/** A space with stored files for each clip. */
async function addSpace(
  storage: ReturnType<typeof memoryStorage>,
  spaces: GuestSpaces,
  streamId: string,
  clips: GuestClip[],
  awayTeam?: string,
) {
  const spaceId = await spaces.spaceIdFor(streamId);
  for (const c of clips) {
    storage.files.set(guestMp4Key(spaceId, c.id), "mp4");
    storage.files.set(guestThumbnailKey(spaceId, c.id), "jpg");
    await spaces.addClip(match(streamId, awayTeam), spaceId, c);
  }
  return spaceId;
}

const ENDED = "2026-11-07T20:00:00.000Z";
const at = (days: number) => new Date(new Date(ENDED).getTime() + days * DAY);

describe("guest space cleanup", () => {
  it("deletes the space, its clips and files 14 days after the match, and logs it", async () => {
    const storage = memoryStorage();
    const spaces = new GuestSpaces(storage);
    const id = await addSpace(storage, spaces, "s1", [clip("c1", "2026-11-07T19:00:00.000Z"), clip("c2", "2026-11-07T19:30:00.000Z")]);
    await spaces.streamEnded("s1", ENDED);

    const result = await cleanupGuestSpaces(spaces, storage, at(14));

    expect(result.removed).toEqual([{ id, files: 4, clips: 2 }]);
    expect(result.failed).toEqual([]);
    expect(await spaces.list()).toEqual([]);
    expect(JSON.parse(storage.files.get(GUEST_INDEX_KEY)!)).toEqual([]);
    expect([...storage.files.keys()].filter((k) => k.startsWith("guest/"))).toEqual([]);
    const log = await readDeletionLog(storage);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      what: "guest-space",
      id,
      match: "Älta – Nacka",
      reason: "retention",
      onRequest: false,
      files: 4,
      clips: 2,
    });
  });

  it("keeps everything on day 13", async () => {
    const storage = memoryStorage();
    const spaces = new GuestSpaces(storage);
    const id = await addSpace(storage, spaces, "s1", [clip("c1", "2026-11-07T19:00:00.000Z")]);
    await spaces.streamEnded("s1", ENDED);

    const result = await cleanupGuestSpaces(spaces, storage, new Date(at(14).getTime() - 1));

    expect(result.removed).toEqual([]);
    expect((await spaces.list()).map((s) => s.id)).toEqual([id]);
    expect(storage.files.has(guestMp4Key(id, "c1"))).toBe(true);
    expect(storage.files.has(guestThumbnailKey(id, "c1"))).toBe(true);
    expect(storage.files.has(DELETION_LOG_KEY)).toBe(false);

    // Day 13 exactly, too.
    expect((await cleanupGuestSpaces(spaces, storage, at(13))).removed).toEqual([]);
  });

  it("counts from the newest clip when the match never ended", async () => {
    const storage = memoryStorage();
    const spaces = new GuestSpaces(storage);
    const newest = "2026-11-07T21:00:00.000Z";
    const id = await addSpace(storage, spaces, "s1", [clip("c1", "2026-11-07T19:00:00.000Z"), clip("c2", newest)]);
    const fromNewest = (days: number) => new Date(new Date(newest).getTime() + days * DAY);

    expect((await cleanupGuestSpaces(spaces, storage, new Date(fromNewest(14).getTime() - 1))).removed).toEqual([]);
    expect((await spaces.list()).map((s) => s.id)).toEqual([id]);

    const result = await cleanupGuestSpaces(spaces, storage, fromNewest(14));
    expect(result.removed.map((r) => r.id)).toEqual([id]);
    expect(await spaces.list()).toEqual([]);
  });

  it("only deletes spaces that are due", async () => {
    const storage = memoryStorage();
    const spaces = new GuestSpaces(storage);
    const old = await addSpace(storage, spaces, "s1", [clip("c1", "2026-11-07T19:00:00.000Z")]);
    await spaces.streamEnded("s1", ENDED);
    const recent = await addSpace(storage, spaces, "s2", [clip("c2", "2026-11-14T19:00:00.000Z")], "Tyresö");
    await spaces.streamEnded("s2", "2026-11-14T20:00:00.000Z");

    const result = await cleanupGuestSpaces(spaces, storage, at(14));

    expect(result.removed.map((r) => r.id)).toEqual([old]);
    expect((await spaces.list()).map((s) => s.id)).toEqual([recent]);
    expect(storage.files.has(guestMp4Key(recent, "c2"))).toBe(true);
  });

  it("does not let one failing space stop the others", async () => {
    const storage = memoryStorage();
    const spaces = new GuestSpaces(storage);
    const broken = await addSpace(storage, spaces, "s1", [clip("c1", "2026-11-07T19:00:00.000Z")]);
    const fine = await addSpace(storage, spaces, "s2", [clip("c2", "2026-11-07T19:00:00.000Z")], "Tyresö");
    await spaces.streamEnded("s1", ENDED);
    await spaces.streamEnded("s2", ENDED);

    const deletePrefix = storage.deletePrefix.bind(storage);
    storage.deletePrefix = async (prefix: string) => {
      if (prefix.includes(broken)) throw new Error("storage down");
      return deletePrefix(prefix);
    };

    const result = await cleanupGuestSpaces(spaces, storage, at(14));

    expect(result.failed.map((f) => f.id)).toEqual([broken]);
    expect(result.removed.map((r) => r.id)).toEqual([fine]);
    expect(storage.files.has(guestMp4Key(fine, "c2"))).toBe(false);
    // The broken space's index entry went first, so its code no longer works...
    expect(await spaces.list()).toEqual([]);
    expect(storage.files.has(guestMp4Key(broken, "c1"))).toBe(true);
    expect((await readDeletionLog(storage)).map((e) => e.id)).toEqual([fine]);

    // ...and its files go on the next run, once storage is back, and it is logged then.
    storage.deletePrefix = deletePrefix;
    const retry = await cleanupGuestSpaces(spaces, storage, at(14));
    expect(retry.removed).toEqual([{ id: broken, files: 2, clips: 1 }]);
    expect(retry.failed).toEqual([]);
    expect([...storage.files.keys()].filter((k) => k.startsWith("guest/"))).toEqual([]);
    const log = await readDeletionLog(storage);
    expect(log.map((e) => e.id)).toEqual([fine, broken]);
    expect(log[1]).toMatchObject({ what: "guest-space", match: "Älta – Nacka", reason: "retention", clips: 1 });
  });
});
