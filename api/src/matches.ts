/**
 * Match schedule — the club's matches, entered by hand in Hantera → Matcher,
 * or made after the fact for a recording that came without one (ABL-048).
 *
 * A match names its two teams from the registry (teams.ts) and keeps their
 * names too, so it still shows the right team after a merge, and a name even
 * if the team was removed. Its recordings are the VOD entries carrying its
 * matchId, plus any stream of it still in progress, so deleting a recording
 * under Inspelningar needs nothing here. The result stays on the recording
 * (ABL-038): a match shows the newest one reported.
 *
 * Kept in the club's own storage like the team registry: config/matches.json.
 */
import crypto from "node:crypto";
import type { Team, TeamRegistry } from "./teams.js";
import { deriveColor, deriveShortName, normalizeName, teamKey } from "./teams.js";
import { clubManifest } from "./club-config.js";
import type { VodEntry } from "./types.js";

export const MATCHES_KEY = "config/matches.json";

/** A team as a match stores it: the registry id, when it has one, and the name. */
export interface TeamRef {
  id?: string;
  name: string;
}

/** A match as stored. */
export interface MatchRecord {
  id: string;
  /** YYYY-MM-DD, in the club's time zone. */
  date: string;
  /** HH:MM, or absent when the time is not known: the match is then all day. */
  time?: string;
  venue?: string;
  /** The club's side; recordings call it homeTeam wherever the match is played. */
  ownTeam: TeamRef;
  opponent: TeamRef;
  /** "admin" when entered in Hantera, "camera" when made for a recording that came without one. */
  source: "admin" | "camera";
  createdAt: string;
  updatedAt: string;
}

export type MatchStatus = "planned" | "live" | "ended";

/** A team as a match shows it. id is "" for a name the registry no longer has. */
export type MatchTeam = Pick<Team, "id" | "name" | "shortName" | "color" | "own" | "logoUrl">;

/** A match as the API shows it. */
export interface Match {
  id: string;
  date: string;
  time?: string;
  venue?: string;
  ownTeam: MatchTeam;
  opponent: MatchTeam;
  status: MatchStatus;
  /** Its recordings, oldest first (camera 1 before camera 2). */
  recordingIds: string[];
  /** From the newest recording that has one; own team first. */
  result?: { home: number; away: number };
  source: MatchRecord["source"];
  createdAt: string;
  updatedAt: string;
}

/** A match without what its recordings tell: enough to start a stream for it. */
export type MatchSummary = Omit<Match, "status" | "recordingIds" | "result">;

export interface MatchInput {
  date?: unknown;
  /** Empty string or null: no time. */
  time?: unknown;
  /** Empty string or null: no venue. Left out on a new match: the club's own venue. */
  venue?: unknown;
  /** A team from the registry, by id … */
  ownTeamId?: unknown;
  opponentId?: unknown;
  /** … or by name, added to the registry when it is not there yet. */
  ownTeamName?: unknown;
  opponentName?: unknown;
}

/** What the schedule needs to know about a stream that is (or was just) on. */
export interface LiveStream {
  matchId?: string;
  createdAt: string;
  stoppedAt?: string;
}

interface MatchStorage {
  readFileIfExists(key: string): Promise<string | null>;
  uploadBuffer(key: string, body: Buffer | string, contentType: string): Promise<void>;
  readVodIndex(): Promise<VodEntry[]>;
  updateVodEntry(id: string, update: Partial<VodEntry>): Promise<boolean>;
}

type Teams = Pick<TeamRegistry, "get" | "findByName" | "ensure">;

/** A refused change, with the message for the admin and the HTTP status to send. */
export class MatchError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_VENUE = 80;

/**
 * The club's time zone, for what "today" is. Matches are entered as local
 * dates, and a server in UTC would otherwise move a late match to the wrong day.
 */
const TIME_ZONE = process.env.CLUB_TIMEZONE || "Europe/Stockholm";

/** The date (YYYY-MM-DD) in the club's time zone. */
export function clubDate(at: Date = new Date()): string {
  try {
    // sv-SE writes dates as YYYY-MM-DD.
    return new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** A real calendar date written YYYY-MM-DD. */
export function isMatchDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** By date, then time; a match without a time starts the day. */
function byWhen(a: MatchRecord, b: MatchRecord): number {
  return a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "") || a.createdAt.localeCompare(b.createdAt);
}

function publicTeam(team: Team): MatchTeam {
  return {
    id: team.id,
    name: team.name,
    shortName: team.shortName,
    color: team.color,
    own: team.own,
    ...(team.logoUrl && { logoUrl: team.logoUrl }),
  };
}

/** "P12 vs AIK", as the camera app announces a match and titles a recording. */
export function matchTitle(own: string, opponent: string): string {
  return `${own} vs ${opponent}`;
}

export class MatchSchedule {
  private records: MatchRecord[] | null = null;
  private loading: Promise<MatchRecord[]> | null = null;
  /** Changes run one at a time, so two cameras starting the same match make one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: MatchStorage,
    private readonly teams: Teams,
    /** Streams in memory, by stream id: those still on make their match live. */
    private readonly streams: () => Iterable<[string, LiveStream]> = () => [],
  ) {}

  /** Matches between two dates (inclusive, either may be left out), by date and time. */
  async list(range: { from?: string; to?: string } = {}): Promise<Match[]> {
    const records = (await this.load())
      .filter((m) => (!range.from || m.date >= range.from) && (!range.to || m.date <= range.to))
      .sort(byWhen);
    if (records.length === 0) return [];
    const vods = await this.storage.readVodIndex();
    return Promise.all(records.map((r) => this.present(r, vods)));
  }

  async get(id: string): Promise<Match | null> {
    const record = (await this.load()).find((m) => m.id === id);
    return record ? this.present(record, await this.storage.readVodIndex()) : null;
  }

  /** The match without its recordings: the teams as they are now, date and venue. */
  async summary(id: string): Promise<MatchSummary | null> {
    const record = (await this.load()).find((m) => m.id === id);
    return record ? this.summarize(record) : null;
  }

  /** Add a match from Hantera. Throws MatchError when a field is missing or wrong. */
  async create(input: MatchInput): Promise<Match> {
    const date = checkDate(input.date);
    const time = checkTime(input.time);
    const venue = input.venue === undefined ? clubManifest.venue : checkVenue(input.venue);
    // Refused before a typed team is added to the registry
    const ownAsked = await this.teamAsked(input.ownTeamId, input.ownTeamName);
    const opponentAsked = await this.teamAsked(input.opponentId, input.opponentName);
    if (!ownAsked || !opponentAsked) throw new MatchError("Välj eget lag och motståndare.", 400);
    checkTwoTeams(ownAsked, opponentAsked);
    const ownTeam = await this.teamFromInput(input.ownTeamId, input.ownTeamName, true);
    const opponent = await this.teamFromInput(input.opponentId, input.opponentName, false);
    if (!ownTeam || !opponent) throw new MatchError("Välj eget lag och motståndare.", 400);
    checkTwoTeams(ownTeam, opponent);

    const record = await this.exclusive(async (records) => {
      const now = new Date().toISOString();
      const match: MatchRecord = {
        id: crypto.randomUUID().slice(0, 8),
        date,
        ...(time && { time }),
        ...(venue && { venue }),
        ownTeam,
        opponent,
        source: "admin",
        createdAt: now,
        updatedAt: now,
      };
      return { records: [...records, match], result: match };
    });
    return this.present(record, []);
  }

  /**
   * Change a match. Fields left out stay as they are. Its recordings follow:
   * they carry the match's teams, date and venue, so a misspelt team fixed
   * here is fixed on the replay too.
   */
  async update(id: string, input: MatchInput): Promise<Match> {
    const date = input.date === undefined ? undefined : checkDate(input.date);
    const time = input.time === undefined ? undefined : checkTime(input.time);
    const venue = input.venue === undefined ? undefined : checkVenue(input.venue);
    // Refused before a typed team is added to the registry
    const before = (await this.load()).find((m) => m.id === id);
    if (!before) throw new MatchError("Matchen finns inte.", 404);
    checkTwoTeams(
      (await this.teamAsked(input.ownTeamId, input.ownTeamName)) ?? before.ownTeam,
      (await this.teamAsked(input.opponentId, input.opponentName)) ?? before.opponent,
    );
    const ownTeam = await this.teamFromInput(input.ownTeamId, input.ownTeamName, true);
    const opponent = await this.teamFromInput(input.opponentId, input.opponentName, false);

    const record = await this.exclusive(async (records) => {
      const current = records.find((m) => m.id === id);
      if (!current) throw new MatchError("Matchen finns inte.", 404);
      const next: MatchRecord = {
        ...current,
        ...(date && { date }),
        ...(ownTeam && { ownTeam }),
        ...(opponent && { opponent }),
        updatedAt: new Date().toISOString(),
      };
      if (time !== undefined) {
        if (time) next.time = time;
        else delete next.time;
      }
      if (venue !== undefined) {
        if (venue) next.venue = venue;
        else delete next.venue;
      }
      checkTwoTeams(next.ownTeam, next.opponent);
      return { records: records.map((m) => (m.id === id ? next : m)), result: next };
    });

    const vods = await this.storage.readVodIndex();
    await this.updateRecordings(await this.summarize(record), vods);
    return this.present(record, vods);
  }

  /** Remove a match that has no recordings. One that has must keep them: they are removed under Inspelningar. */
  async remove(id: string): Promise<void> {
    const vods = await this.storage.readVodIndex();
    await this.exclusive(async (records) => {
      const record = records.find((m) => m.id === id);
      if (!record) throw new MatchError("Matchen finns inte.", 404);
      if (this.recordingsOf(id, vods).length > 0) {
        throw new MatchError("Matchen har inspelningar. Ta bort dem under Inspelningar först.", 409);
      }
      return { records: records.filter((m) => m.id !== id), result: undefined };
    });
  }

  /**
   * The match a recording without a matchId belongs to: one on the same day
   * between the same two teams, or a new one made now. How an older camera
   * app, or "Annan match", still ends up on a match.
   *
   * A name the camera typed joins the registry (`register`); the placeholders
   * used when it typed nothing do not.
   */
  async forRecording(
    date: string,
    ownName: string,
    opponentName: string,
    register: { own: boolean; opponent: boolean },
  ): Promise<MatchSummary> {
    const own = register.own ? await this.teams.ensure(ownName, { own: true }) : await this.teams.findByName(ownName);
    const opp = register.opponent ? await this.teams.ensure(opponentName, { own: false }) : await this.teams.findByName(opponentName);

    const record = await this.exclusive(async (records) => {
      const found = records
        .filter((m) => m.date === date && sameTeam(m.ownTeam, ownName, own) && sameTeam(m.opponent, opponentName, opp))
        .sort(byWhen)[0];
      if (found) return { records, result: found };

      const now = new Date().toISOString();
      const match: MatchRecord = {
        id: crypto.randomUUID().slice(0, 8),
        date,
        ...(clubManifest.venue && { venue: clubManifest.venue }),
        ownTeam: refOf(ownName, own),
        opponent: refOf(opponentName, opp),
        source: "camera",
        createdAt: now,
        updatedAt: now,
      };
      return { records: [...records, match], result: match };
    });
    return this.summarize(record);
  }

  /**
   * The match an older app's announcement is about, from its message
   * ("P12 vs AIK"), among the matches on that day. Null when none fits.
   */
  async findAnnounced(message: string, date: string): Promise<string | null> {
    const parts = message.split(/\s+vs\.?\s+/i);
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return null;
    const [ownName, opponentName] = parts;
    const own = await this.teams.findByName(ownName);
    const opp = await this.teams.findByName(opponentName);
    const found = (await this.load())
      .filter((m) => m.date === date && sameTeam(m.ownTeam, ownName, own) && sameTeam(m.opponent, opponentName, opp))
      .sort(byWhen)[0];
    return found?.id ?? null;
  }

  // --- Internals ---

  private async load(): Promise<MatchRecord[]> {
    if (this.records) return this.records;
    this.loading ??= this.storage.readFileIfExists(MATCHES_KEY).then((raw) => {
      const parsed = raw ? (JSON.parse(raw) as { matches?: MatchRecord[] }) : null;
      this.records = parsed?.matches ?? [];
      return this.records;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  /** Run one change against the current list and store the list it returns. */
  private exclusive<T>(change: (records: MatchRecord[]) => Promise<{ records: MatchRecord[]; result: T }>): Promise<T> {
    const run = this.queue.then(async () => {
      const before = await this.load();
      const { records, result } = await change(before);
      if (records !== before) {
        await this.storage.uploadBuffer(MATCHES_KEY, JSON.stringify({ matches: records }, null, 2), "application/json");
        this.records = records;
      }
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * The team the input asks for, without adding a named one to the registry:
   * enough to refuse a match against itself first. Null when the input names none.
   */
  private async teamAsked(id: unknown, name: unknown): Promise<TeamRef | null> {
    if (typeof id === "string" && id) {
      const team = await this.teams.get(id);
      if (!team) throw new MatchError("Laget finns inte.", 400);
      return { id: team.id, name: team.name };
    }
    if (typeof name !== "string" || !normalizeName(name)) return null;
    const team = await this.teams.findByName(name);
    return team ? { id: team.id, name: team.name } : { name: normalizeName(name) };
  }

  /** A team picked by id, or named and added to the registry; null when the input names none. */
  private async teamFromInput(id: unknown, name: unknown, own: boolean): Promise<TeamRef | null> {
    if (typeof id === "string" && id) {
      const team = await this.teams.get(id);
      if (!team) throw new MatchError("Laget finns inte.", 400);
      return { id: team.id, name: team.name };
    }
    if (typeof name === "string" && normalizeName(name)) {
      const team = await this.teams.ensure(name, { own });
      if (team) return { id: team.id, name: team.name };
    }
    return null;
  }

  /** The registry's team now: by id, else by name (after a merge), else a stand-in from the name. */
  private async teamOf(ref: TeamRef, own: boolean): Promise<MatchTeam> {
    const team = (ref.id ? await this.teams.get(ref.id) : null) ?? (await this.teams.findByName(ref.name));
    if (team) return publicTeam(team);
    return { id: "", name: ref.name, shortName: deriveShortName(ref.name, own), color: deriveColor(ref.name), own };
  }

  private async summarize(r: MatchRecord): Promise<MatchSummary> {
    const [ownTeam, opponent] = await Promise.all([this.teamOf(r.ownTeam, true), this.teamOf(r.opponent, false)]);
    return {
      id: r.id,
      date: r.date,
      ...(r.time && { time: r.time }),
      ...(r.venue && { venue: r.venue }),
      ownTeam,
      opponent,
      source: r.source,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  /** The match's recordings, oldest first: those in the VOD index and any stream of it still on. */
  private recordingsOf(id: string, vods: VodEntry[]): { id: string; createdAt: string; result?: VodEntry["result"] }[] {
    const out = new Map<string, { id: string; createdAt: string; result?: VodEntry["result"] }>();
    for (const [streamId, s] of this.streams()) {
      if (s.matchId === id) out.set(streamId, { id: streamId, createdAt: s.createdAt });
    }
    for (const v of vods) {
      if (v.matchId === id) out.set(v.id, { id: v.id, createdAt: v.createdAt, result: v.result });
    }
    return [...out.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async present(r: MatchRecord, vods: VodEntry[]): Promise<Match> {
    const recordings = this.recordingsOf(r.id, vods);
    const on = new Set<string>();
    for (const [streamId, s] of this.streams()) {
      if (s.matchId === r.id && !s.stoppedAt) on.add(streamId);
    }
    const status: MatchStatus = recordings.some((rec) => on.has(rec.id)) ? "live" : recordings.length > 0 ? "ended" : "planned";
    const reported = recordings.filter((rec) => rec.result);
    const result = reported.length ? reported[reported.length - 1].result : undefined;
    const { source, createdAt, updatedAt, ...rest } = await this.summarize(r);
    return {
      ...rest,
      status,
      recordingIds: recordings.map((rec) => rec.id),
      ...(result && { result: { home: result.home, away: result.away } }),
      source,
      createdAt,
      updatedAt,
    };
  }

  /** Copy the match's teams, date and venue onto its recordings. */
  private async updateRecordings(match: MatchSummary, vods: VodEntry[]): Promise<void> {
    for (const v of vods) {
      if (v.matchId !== match.id) continue;
      const update: Partial<VodEntry> = {
        homeTeam: match.ownTeam.name,
        awayTeam: match.opponent.name,
        matchDate: match.date,
        location: match.venue ?? "",
      };
      // A title the admin wrote by hand stays; one made from the teams follows them.
      if (v.matchTitle === matchTitle(v.homeTeam, v.awayTeam)) {
        update.matchTitle = matchTitle(match.ownTeam.name, match.opponent.name);
      }
      const changed = (Object.keys(update) as (keyof VodEntry)[]).some((k) => update[k] !== v[k]);
      if (changed) await this.storage.updateVodEntry(v.id, update);
    }
  }
}

function checkDate(value: unknown): string {
  if (!isMatchDate(value)) throw new MatchError("Välj ett datum.", 400);
  return value;
}

/** A time HH:MM, or "" for none. */
function checkTime(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !TIME.test(value)) throw new MatchError("Tiden ska anges som TT:MM.", 400);
  return value;
}

/** A venue, or "" for none. */
function checkVenue(value: unknown): string {
  if (value === null) return "";
  if (typeof value !== "string") throw new MatchError("Platsen ska vara text.", 400);
  const venue = normalizeName(value);
  if (venue.length > MAX_VENUE) throw new MatchError(`Platsen får vara högst ${MAX_VENUE} tecken.`, 400);
  return venue;
}

function checkTwoTeams(own: TeamRef, opponent: TeamRef): void {
  const same = own.id && opponent.id ? own.id === opponent.id : teamKey(own.name) === teamKey(opponent.name);
  if (same) throw new MatchError("Välj två olika lag.", 400);
}

function refOf(name: string, team: Team | null): TeamRef {
  return team ? { id: team.id, name: team.name } : { name: normalizeName(name) };
}

/**
 * Whether a stored team is the one named: the same registry team, or a name
 * that team answers to (its own, or one it had before a rename or merge).
 */
function sameTeam(stored: TeamRef, name: string, team: Team | null): boolean {
  if (stored.id && team && stored.id === team.id) return true;
  const keys = new Set([teamKey(name), ...(team ? [team.name, ...team.aliases].map(teamKey) : [])]);
  return keys.has(teamKey(stored.name));
}
