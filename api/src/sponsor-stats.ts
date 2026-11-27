/**
 * What viewers saw of the sponsors (#121, #138): counted in memory, per match.
 *
 * The player reports what happened to each sponsor clip it plays: it started,
 * it was watched to the end, it played with sound. Phase 1's logos will report
 * that they were seen. Each report names the match, the sponsor, the surface
 * and whether it was live or a replay.
 *
 * The viewer's id is the same random id the player's heartbeat uses
 * (viewer-tracking.ts). It is kept here, in memory only, so a viewer is
 * counted once per match however many clips they see. It is never stored,
 * logged or sent back: what leaves this module is counts.
 *
 * Every match has a cap on the ids it holds, and there is a cap on the
 * matches held, so made-up viewers cannot fill memory.
 */

export const STAT_KINDS = ["start", "complete", "sound", "seen"] as const;
export type StatKind = (typeof STAT_KINDS)[number];

export const STAT_MODES = ["live", "replay"] as const;
export type StatMode = (typeof STAT_MODES)[number];

/** Most viewer ids held for one match, over all its sponsors and surfaces. */
export const MAX_ENTRIES_PER_MATCH = 20_000;
/** Most matches held at once. A finished match is let go once its counts are saved. */
export const MAX_MATCHES = 200;
/** A viewer's starts of the same clips that count: a page reloaded over and over is not a crowd. */
export const MAX_STARTS_PER_VIEWER = 10;

/** What is counted per sponsor, surface and mode. */
export interface Counts {
  /** Different viewers, in this match. Not comparable between matches. */
  viewers: number;
  starts: number;
  /** Watched to the end. Never more than the starts. */
  completes: number;
  /** Played with sound at some point. Never more than the starts. */
  sounds: number;
  /** A logo seen (phase 1). Once per viewer. */
  seen: number;
}

export function emptyCounts(): Counts {
  return { viewers: 0, starts: 0, completes: 0, sounds: 0, seen: 0 };
}

export function addCounts(a: Counts, b: Partial<Counts> | undefined): Counts {
  return {
    viewers: a.viewers + num(b?.viewers),
    starts: a.starts + num(b?.starts),
    completes: a.completes + num(b?.completes),
    sounds: a.sounds + num(b?.sounds),
    seen: a.seen + num(b?.seen),
  };
}

function num(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The match an event belongs to, as the route has worked it out. */
export interface MatchInfo {
  /** matchId ?? streamId: one match is one key, whichever camera or replay it came from. */
  key: string;
  matchId?: string;
  /** YYYY-MM-DD, in the club's time zone: which season the counts belong to. */
  date: string;
  homeTeam?: string;
  awayTeam?: string;
}

export interface StatEvent {
  viewerId: string;
  sponsorId: string;
  surface: string;
  kind: StatKind;
  mode: StatMode;
}

/** "counted", "ignored" (nothing to add, like a second "seen") or "full" (a cap was reached). */
export type RecordResult = "counted" | "ignored" | "full";

/** One viewer's events on one sponsor's surface, so the counts can be checked against each other. */
interface ViewerTally {
  starts: number;
  completes: number;
  sounds: number;
  seen: boolean;
}

interface Bucket {
  viewers: Map<string, ViewerTally>;
  counts: Counts;
}

/** Everything held for one match. */
export interface MatchTally {
  info: MatchInfo;
  /** `${sponsorId}|${surface}|${mode}` → its viewers and counts. */
  buckets: Map<string, Bucket>;
  /** `${sponsorId}|${mode}` → the viewers who saw the sponsor anywhere in the match. */
  reach: Map<string, Set<string>>;
  /** Viewer ids held, over buckets and reach, against MAX_ENTRIES_PER_MATCH. */
  entries: number;
  /** Something was counted since the counts were last saved. */
  dirty: boolean;
  lastEventAt: number;
}

/** The counts of one match: what is saved and what the report reads. No ids. */
export interface MatchCounts {
  sponsors: Record<string, {
    /** Different viewers who saw the sponsor on any surface of the match. */
    viewers: Partial<Record<StatMode, number>>;
    surfaces: Record<string, Partial<Record<StatMode, Counts>>>;
  }>;
}

export interface StatsOptions {
  now?: () => number;
  maxEntriesPerMatch?: number;
  maxMatches?: number;
}

export class SponsorStats {
  protected readonly matches = new Map<string, MatchTally>();
  protected readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxMatches: number;

  constructor(options: StatsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntriesPerMatch ?? MAX_ENTRIES_PER_MATCH;
    this.maxMatches = options.maxMatches ?? MAX_MATCHES;
  }

  /** Count one event. The caller has checked that the sponsor is on that surface for that match. */
  record(info: MatchInfo, ev: StatEvent): RecordResult {
    const m = this.tally(info);
    if (!m) return "full";

    const bucketKey = `${ev.sponsorId}|${ev.surface}|${ev.mode}`;
    let bucket = m.buckets.get(bucketKey);
    let viewer = bucket?.viewers.get(ev.viewerId);

    // A complete or a sound needs a start before it, from the same viewer.
    if (ev.kind === "complete" || ev.kind === "sound") {
      if (!viewer) return "ignored";
      if (ev.kind === "complete") {
        if (viewer.completes >= viewer.starts) return "ignored";
        viewer.completes++;
        bucket!.counts.completes++;
      } else {
        if (viewer.sounds >= viewer.starts) return "ignored";
        viewer.sounds++;
        bucket!.counts.sounds++;
      }
      return this.touched(m);
    }

    if (viewer && ev.kind === "start" && viewer.starts >= MAX_STARTS_PER_VIEWER) return "ignored";
    if (viewer && ev.kind === "seen" && viewer.seen) return "ignored";

    if (!viewer) {
      const reachKey = `${ev.sponsorId}|${ev.mode}`;
      const reach = m.reach.get(reachKey);
      const newReach = !reach?.has(ev.viewerId);
      const needed = 1 + (newReach ? 1 : 0);
      if (m.entries + needed > this.maxEntries) return "full";

      if (!bucket) {
        bucket = { viewers: new Map(), counts: emptyCounts() };
        m.buckets.set(bucketKey, bucket);
      }
      viewer = { starts: 0, completes: 0, sounds: 0, seen: false };
      bucket.viewers.set(ev.viewerId, viewer);
      bucket.counts.viewers++;
      if (newReach) {
        if (reach) reach.add(ev.viewerId);
        else m.reach.set(reachKey, new Set([ev.viewerId]));
      }
      m.entries += needed;
    }

    if (ev.kind === "start") {
      viewer.starts++;
      bucket!.counts.starts++;
    } else {
      viewer.seen = true;
      bucket!.counts.seen++;
    }
    return this.touched(m);
  }

  /** The counts of one match since this process started, without any id. Null when none. */
  counts(key: string): MatchCounts | null {
    const m = this.matches.get(key);
    return m ? countsOf(m) : null;
  }

  /** How many viewer ids one match holds: for the tests of the cap. */
  entries(key: string): number {
    return this.matches.get(key)?.entries ?? 0;
  }

  /** How many matches are held. */
  get size(): number {
    return this.matches.size;
  }

  private tally(info: MatchInfo): MatchTally | null {
    let m = this.matches.get(info.key);
    if (m) return m;
    if (this.matches.size >= this.maxMatches) {
      this.letGo();
      if (this.matches.size >= this.maxMatches) return null;
    }
    m = { info: { ...info }, buckets: new Map(), reach: new Map(), entries: 0, dirty: false, lastEventAt: this.now() };
    this.matches.set(info.key, m);
    return m;
  }

  private touched(m: MatchTally): RecordResult {
    m.dirty = true;
    m.lastEventAt = this.now();
    return "counted";
  }

  /**
   * Make room: drop matches whose counts are all saved, the quietest first.
   * Without saving (#139 adds it) nothing is ever saved, so nothing goes.
   */
  protected letGo(): void {
    const saved = [...this.matches.values()].filter((m) => !m.dirty).sort((a, b) => a.lastEventAt - b.lastEventAt);
    for (const m of saved) {
      if (this.matches.size < this.maxMatches) break;
      this.matches.delete(m.info.key);
    }
  }
}

/** A match's counts, with the ids left behind. */
export function countsOf(m: MatchTally): MatchCounts {
  const out: MatchCounts = { sponsors: {} };
  const entry = (sponsorId: string) => (out.sponsors[sponsorId] ??= { viewers: {}, surfaces: {} });
  for (const [key, bucket] of m.buckets) {
    const [sponsorId, surface, mode] = key.split("|") as [string, string, StatMode];
    (entry(sponsorId).surfaces[surface] ??= {})[mode] = { ...bucket.counts };
  }
  for (const [key, ids] of m.reach) {
    const [sponsorId, mode] = key.split("|") as [string, StatMode];
    entry(sponsorId).viewers[mode] = ids.size;
  }
  return out;
}
