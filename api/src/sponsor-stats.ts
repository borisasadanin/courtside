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
 *
 * The counts are saved (#139), and only the counts:
 *
 *   stats/sponsors/<season>/<matchKey>.json
 *
 * every five minutes, when a stream stops and when the process is told to
 * stop. The season is the year it starts: 2026 runs from 1 August 2026 (or
 * the admin's season start) to the day before that in 2027. After a restart
 * the saved counts are read once and the new ones added to them. The ids are
 * gone by then, so a viewer who watched both before and after a restart is
 * counted twice in that match.
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
/** How often the counts are saved. */
export const SAVE_INTERVAL_MS = 5 * 60 * 1000;
/** A match with nothing new this long after its counts were saved is let go, its ids with it. */
export const IDLE_MS = 3 * 60 * 60 * 1000;

export const STATS_PREFIX = "stats/sponsors/";
/** The season's first day when the admin has set none: 1 August. */
export const DEFAULT_SEASON_START = "08-01";

// --- Seasons ---

/** "MM-DD" of the season start: the month and day of the admin's date, every year. */
function startDay(seasonStart?: string | null): string {
  return seasonStart && /^\d{4}-\d{2}-\d{2}$/.test(seasonStart) ? seasonStart.slice(5) : DEFAULT_SEASON_START;
}

/** The season a date (YYYY-MM-DD) is in: the year it started, "2026" for 2026/27. */
export function seasonOf(date: string, seasonStart?: string | null): string {
  const year = Number(date.slice(0, 4));
  return String(date.slice(5) >= startDay(seasonStart) ? year : year - 1);
}

/** A season's first and last day, both included. */
export function seasonRange(season: string, seasonStart?: string | null): { from: string; to: string } {
  const year = Number(season);
  const [m, d] = startDay(seasonStart).split("-").map(Number);
  const from = new Date(Date.UTC(year, m - 1, d));
  const next = new Date(Date.UTC(year + 1, m - 1, d));
  const last = new Date(next.getTime() - 24 * 60 * 60 * 1000);
  return { from: from.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/** "2026/27". */
export function seasonLabel(season: string): string {
  return `${season}/${String((Number(season) + 1) % 100).padStart(2, "0")}`;
}

export function isSeason(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}$/.test(value);
}

/** Where one match's counts are saved. */
export function statsKey(season: string, matchKey: string): string {
  return `${STATS_PREFIX}${season}/${matchKey}.json`;
}

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
  /** Where its counts are saved, fixed the first time they are. */
  path?: string;
  /** What was saved before this process started, read once (#139). */
  base?: MatchCounts | null;
}

/** The counts of one match: what is saved and what the report reads. No ids. */
export interface MatchCounts {
  sponsors: Record<string, {
    /** Different viewers who saw the sponsor on any surface of the match. */
    viewers: Partial<Record<StatMode, number>>;
    surfaces: Record<string, Partial<Record<StatMode, Counts>>>;
  }>;
}

/** stats/sponsors/<season>/<matchKey>.json: the match and its counts, never an id. */
export interface StatsFile extends MatchCounts {
  version: 1;
  match: MatchInfo;
  updatedAt: string;
}

export interface StatsStorage {
  readFileIfExists(key: string): Promise<string | null>;
  uploadBuffer(key: string, body: Buffer | string, contentType: string): Promise<void>;
}

export interface StatsOptions {
  now?: () => number;
  maxEntriesPerMatch?: number;
  maxMatches?: number;
  /** Where the counts are saved. Without it they are only counted. */
  storage?: StatsStorage;
  /** The admin's season start, YYYY-MM-DD, read when a match is first saved. */
  seasonStart?: () => string | null | undefined;
  log?: { warn(obj: unknown, msg: string): void };
}

/** Two matches' counts added together. */
export function mergeCounts(a: MatchCounts | null | undefined, b: MatchCounts | null | undefined): MatchCounts {
  const out: MatchCounts = { sponsors: {} };
  for (const src of [a, b]) {
    for (const [sponsorId, x] of Object.entries(src?.sponsors ?? {})) {
      const to = (out.sponsors[sponsorId] ??= { viewers: {}, surfaces: {} });
      for (const mode of STAT_MODES) {
        if (x?.viewers?.[mode] !== undefined) to.viewers[mode] = (to.viewers[mode] ?? 0) + num(x.viewers[mode]);
      }
      for (const [surface, modes] of Object.entries(x?.surfaces ?? {})) {
        const s = (to.surfaces[surface] ??= {});
        for (const mode of STAT_MODES) {
          if (modes?.[mode]) s[mode] = addCounts(s[mode] ?? emptyCounts(), modes[mode]);
        }
      }
    }
  }
  return out;
}

/** A saved file read back: null when it is not one. */
export function parseStatsFile(raw: string | null): StatsFile | null {
  if (!raw) return null;
  try {
    const f = JSON.parse(raw) as Partial<StatsFile>;
    if (!f || typeof f !== "object" || !f.match || typeof f.match.key !== "string" || typeof f.match.date !== "string") return null;
    return { version: 1, match: f.match, updatedAt: String(f.updatedAt ?? ""), sponsors: mergeCounts(f as MatchCounts, null).sponsors };
  } catch {
    return null;
  }
}

export class SponsorStats {
  protected readonly matches = new Map<string, MatchTally>();
  protected readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxMatches: number;
  private readonly storage?: StatsStorage;
  private readonly seasonStart: () => string | null | undefined;
  private readonly log?: StatsOptions["log"];
  /** Saves run one at a time, so two never write the same file out of order. */
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: StatsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntriesPerMatch ?? MAX_ENTRIES_PER_MATCH;
    this.maxMatches = options.maxMatches ?? MAX_MATCHES;
    this.storage = options.storage;
    this.seasonStart = options.seasonStart ?? (() => undefined);
    this.log = options.log;
  }

  /** Save every five minutes until stop(). The timer does not keep the process alive. */
  start(intervalMs = SAVE_INTERVAL_MS): void {
    this.stop();
    this.timer = setInterval(() => {
      this.flush().catch((err) => this.log?.warn(err, "Could not save the sponsor counts"));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Save the counts of one match, or of every match with something new.
   * A match whose saved counts cannot be read is not written, so they are
   * never overwritten with fewer; it is tried again next time.
   */
  flush(key?: string): Promise<void> {
    const run = this.queue.then(async () => {
      if (!this.storage) return;
      const due = key ? [this.matches.get(key)].filter((m): m is MatchTally => Boolean(m)) : [...this.matches.values()];
      let failed: unknown = null;
      for (const m of due) {
        if (!m.dirty) continue;
        try {
          await this.save(m);
        } catch (err) {
          failed = err;
        }
      }
      this.forgetIdle();
      if (failed) throw failed;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** The stream's match: saved now, as its stream has stopped. */
  streamStopped(matchKey: string): Promise<void> {
    return this.flush(matchKey);
  }

  private async save(m: MatchTally): Promise<void> {
    const storage = this.storage!;
    m.path ??= statsKey(seasonOf(m.info.date, this.seasonStart()), m.info.key);
    if (m.base === undefined) {
      const raw = await storage.readFileIfExists(m.path);
      const saved = parseStatsFile(raw);
      if (raw && !saved) this.log?.warn({ key: m.path }, "Unreadable sponsor counts replaced");
      m.base = saved;
    }
    // Cleared before the write: what comes in meanwhile makes it dirty again.
    m.dirty = false;
    const file: StatsFile = {
      version: 1,
      match: { ...m.info },
      updatedAt: new Date(this.now()).toISOString(),
      ...mergeCounts(m.base, countsOf(m)),
    };
    try {
      await storage.uploadBuffer(m.path, JSON.stringify(file, null, 2), "application/json");
    } catch (err) {
      m.dirty = true;
      throw err;
    }
  }

  /** Let go of matches that are saved and have been quiet for hours, and their ids with them. */
  private forgetIdle(): void {
    const now = this.now();
    for (const m of [...this.matches.values()]) {
      if (!m.dirty && now - m.lastEventAt > IDLE_MS) this.matches.delete(m.info.key);
    }
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

  /** Make room: drop matches whose counts are all saved, the quietest first. */
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
