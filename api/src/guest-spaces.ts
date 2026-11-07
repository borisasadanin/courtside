/**
 * Guest spaces — the opponent's highlights, kept apart from the club's own (#48).
 *
 * The camera can make a highlight for the other team.  Such a clip never joins
 * the club's clips: it goes into the match's guest space, which the opponent's
 * coach opens with a code of its own.  Nothing that lists the club's clips (the
 * highlights page, a match's clips, the pause carousel, covers) ever reads this
 * index, so a guest clip cannot show up there by mistake.
 *
 * One guest space per match.  It is created with its code when the match's
 * first opponent clip is saved; a match without such clips has no guest space.
 * The whole space, clips and code, is deleted GUEST_RETENTION_MS after the
 * match (see deleteAfter), even if the match itself is deleted earlier.  So the
 * space keeps its own copy of what the guest page shows about the match.
 *
 * Guest clips are self-contained: an MP4 and a thumbnail under
 * guest/<spaceId>/, nothing that points into the recording, so deleting the
 * recording never breaks them.
 */
import { randomBytes, randomInt } from "node:crypto";

/** How long a guest space lives after its match. */
export const GUEST_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** The guest space index in storage. */
export const GUEST_INDEX_KEY = "guest-spaces.json";

/** Letters and digits that cannot be mistaken for each other (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export interface GuestClip {
  id: string;
  /** Served to the guest page (behind the guest code) and to admin. */
  mp4Url: string;
  thumbnailUrl?: string;
  durationSeconds: number;
  createdAt: string;
  label?: string;
}

export interface GuestSpace {
  id: string;
  /** The code the opponent logs in with. Shown in admin in plain text, by design. */
  code: string;
  /** The match in the schedule, when the stream had one. */
  matchId?: string;
  /** Every stream of the match that added clips (a restarted match adds a second). */
  streamIds: string[];
  /** The club's own team, as recorded. */
  homeTeam: string;
  /** The opponent, whose clips these are. */
  awayTeam: string;
  venue?: string;
  /** When the match was played (the first stream's start). */
  matchDate: string;
  /** When the match ended (its stream stopped). Missing while it is on. */
  endedAt?: string;
  /** Final score, own team first, copied in when it is set. */
  result?: { home: number; away: number };
  createdAt: string;
  clips: GuestClip[];
}

/** What the guest space needs to know about a match when it is created. */
export interface GuestMatchInfo {
  streamId: string;
  matchId?: string;
  homeTeam: string;
  awayTeam: string;
  venue?: string;
  matchDate: string;
}

export type GuestStorage = {
  readFileIfExists(key: string): Promise<string | null>;
  uploadBuffer(key: string, body: Buffer | string, contentType: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
};

/** A new random code. */
export function newGuestCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** A code as typed: spaces and dashes dropped, upper case. */
export function normaliseGuestCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * When the space is deleted: GUEST_RETENTION_MS after the match ended.  A match
 * that never stopped cleanly counts from its newest clip, or from when the
 * space was created.
 */
export function deleteAfter(space: GuestSpace): Date {
  const newestClip = space.clips.reduce<string | undefined>(
    (latest, c) => (!latest || c.createdAt > latest ? c.createdAt : latest),
    undefined,
  );
  const from = space.endedAt ?? newestClip ?? space.createdAt;
  return new Date(new Date(from).getTime() + GUEST_RETENTION_MS);
}

/** Storage prefix of a space's files. */
export function guestPrefix(spaceId: string): string {
  return `guest/${spaceId}/`;
}

export function guestMp4Key(spaceId: string, clipId: string): string {
  return `${guestPrefix(spaceId)}${clipId}.mp4`;
}

export function guestThumbnailKey(spaceId: string, clipId: string): string {
  return `${guestPrefix(spaceId)}${clipId}.jpg`;
}

export class GuestSpaces {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private storage: GuestStorage) {}

  /** Run read-modify-write steps one at a time, so two clips never make two spaces. */
  private serialised<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn);
    this.lock = next.catch(() => {});
    return next;
  }

  async list(): Promise<GuestSpace[]> {
    const raw = await this.storage.readFileIfExists(GUEST_INDEX_KEY);
    return raw ? (JSON.parse(raw) as GuestSpace[]) : [];
  }

  private async write(spaces: GuestSpace[]): Promise<void> {
    await this.storage.uploadBuffer(GUEST_INDEX_KEY, JSON.stringify(spaces, null, 2), "application/json");
  }

  async get(id: string): Promise<GuestSpace | undefined> {
    return (await this.list()).find((s) => s.id === id);
  }

  async byCode(code: string): Promise<GuestSpace | undefined> {
    const wanted = normaliseGuestCode(code);
    if (!wanted) return undefined;
    return (await this.list()).find((s) => s.code === wanted);
  }

  /** The space a stream's clips go to: same stream, or same match from a restarted stream. */
  async forStream(streamId: string, matchId?: string): Promise<GuestSpace | undefined> {
    return findFor(await this.list(), streamId, matchId);
  }

  /** The space and clip a guest clip id belongs to. */
  async findClip(clipId: string): Promise<{ space: GuestSpace; clip: GuestClip } | undefined> {
    for (const space of await this.list()) {
      const clip = space.clips.find((c) => c.id === clipId);
      if (clip) return { space, clip };
    }
    return undefined;
  }

  /**
   * Add a clip to the match's space, creating the space (and its code) if this
   * is the match's first opponent clip.  `spaceId` comes from spaceIdFor(), so
   * the clip's files can be stored before the index names them.
   */
  async addClip(match: GuestMatchInfo, spaceId: string, clip: GuestClip): Promise<GuestSpace> {
    return this.serialised(async () => {
      const spaces = await this.list();
      let space = findFor(spaces, match.streamId, match.matchId);
      if (!space) {
        space = {
          id: spaceId,
          code: uniqueCode(spaces),
          matchId: match.matchId,
          streamIds: [match.streamId],
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          venue: match.venue,
          matchDate: match.matchDate,
          createdAt: new Date().toISOString(),
          clips: [],
        };
        spaces.push(space);
      } else if (!space.streamIds.includes(match.streamId)) {
        space.streamIds.push(match.streamId);
        // A restarted match is on again until its new stream stops.
        space.endedAt = undefined;
      }
      space.clips.push(clip);
      await this.write(spaces);
      return space;
    });
  }

  /**
   * The id a new clip's files should be stored under: the match's existing
   * space, or a fresh id for the space addClip will create.
   */
  async spaceIdFor(streamId: string, matchId?: string): Promise<string> {
    return (await this.forStream(streamId, matchId))?.id ?? randomBytes(8).toString("hex");
  }

  /** Note that a stream stopped: its space's 14 days start now. */
  async streamEnded(streamId: string, at: string): Promise<void> {
    await this.update((spaces) => {
      let changed = false;
      for (const s of spaces) {
        if (s.streamIds.includes(streamId)) {
          s.endedAt = at;
          changed = true;
        }
      }
      return changed;
    });
  }

  /** Copy a match's result in, so the guest page has it even if the match is deleted. */
  async noteResult(streamId: string, result: { home: number; away: number }): Promise<void> {
    await this.update((spaces) => {
      let changed = false;
      for (const s of spaces) {
        if (s.streamIds.includes(streamId)) {
          s.result = { home: result.home, away: result.away };
          changed = true;
        }
      }
      return changed;
    });
  }

  /** Give a space a new code. The old one stops working at once. */
  async newCode(spaceId: string): Promise<GuestSpace | undefined> {
    let found: GuestSpace | undefined;
    await this.update((spaces) => {
      found = spaces.find((s) => s.id === spaceId);
      if (found) found.code = uniqueCode(spaces);
      return !!found;
    });
    return found;
  }

  /**
   * Remove clips from a space (all of them when clipIds is undefined) and their
   * files.  The space stays until it is deleted after its 14 days.
   */
  async removeClips(
    spaceId: string,
    clipIds?: string[],
  ): Promise<{ space: GuestSpace; removed: GuestClip[]; files: number } | undefined> {
    let space: GuestSpace | undefined;
    let removed: GuestClip[] = [];
    await this.update((spaces) => {
      space = spaces.find((s) => s.id === spaceId);
      if (!space) return false;
      removed = space.clips.filter((c) => !clipIds || clipIds.includes(c.id));
      space.clips = space.clips.filter((c) => !removed.includes(c));
      return removed.length > 0;
    });
    if (!space) return undefined;
    let files = 0;
    for (const clip of removed) {
      files += await this.storage.deletePrefix(`${guestPrefix(spaceId)}${clip.id}.`);
    }
    return { space, removed, files };
  }

  /** Delete a whole space: index entry first, then its files. */
  async removeSpace(spaceId: string): Promise<{ space: GuestSpace; files: number } | undefined> {
    let space: GuestSpace | undefined;
    await this.update((spaces) => {
      const i = spaces.findIndex((s) => s.id === spaceId);
      if (i < 0) return false;
      space = spaces.splice(i, 1)[0];
      return true;
    });
    if (!space) return undefined;
    const files = await this.storage.deletePrefix(guestPrefix(spaceId));
    return { space, files };
  }

  private async update(change: (spaces: GuestSpace[]) => boolean): Promise<void> {
    await this.serialised(async () => {
      const spaces = await this.list();
      if (change(spaces)) await this.write(spaces);
    });
  }
}

function findFor(spaces: GuestSpace[], streamId: string, matchId?: string): GuestSpace | undefined {
  return (
    spaces.find((s) => s.streamIds.includes(streamId)) ??
    (matchId ? spaces.find((s) => s.matchId === matchId) : undefined)
  );
}

function uniqueCode(spaces: GuestSpace[]): string {
  const taken = new Set(spaces.map((s) => s.code));
  for (;;) {
    const code = newGuestCode();
    if (!taken.has(code)) return code;
  }
}
