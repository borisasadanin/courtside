/**
 * Broadcast state — what viewers see about matches beyond the live picture:
 * one coming up, one just finished, every one paused.
 *
 * Several teams may broadcast at the same time (ABL-051), so there is no single
 * status for the installation. Each match has its own: a stream's follows the
 * stream (live, paused, ended), and a camera can announce its match before the
 * stream exists. The installation's status, which the page and older apps
 * read, is derived from them, so one match ending or pausing never hides or
 * relabels another that is live.
 *
 * Streams of the same match in the schedule (ABL-048) are one match: two
 * cameras on it give one status. An announcement belongs to the camera that
 * made it, and names its match when it can; two cameras announcing the same
 * match show as one, and the match starting from any camera ends both.
 * Streams and announcements from older apps without a match id keep their
 * own key, as before.
 */

export type BroadcastStatus = "idle" | "upcoming" | "live" | "paused" | "ended";

/** One match's status. A match is never "idle"; it just stops being listed. */
export interface MatchState {
  status: Exclude<BroadcastStatus, "idle">;
  message?: string;
  updatedAt: string;
  /** The match in the schedule, when known (ABL-048). */
  matchId?: string;
}

export interface BroadcastState {
  status: BroadcastStatus;
  message?: string;
  updatedAt: string;
  /** Announced matches that have not started yet, oldest first; one per match in the schedule */
  upcoming: { message?: string; updatedAt: string; matchId?: string }[];
}

/** The part of a stream's metadata its status is derived from. */
export interface StreamStatusSource {
  createdAt: string;
  pausedAt?: string;
  stoppedAt?: string;
  matchId?: string;
}

const ENDED_TTL_MS = 5 * 60 * 1000; // 5 minutes before "ended" expires to "idle"
const UPCOMING_TTL_MS = 3 * 60 * 60 * 1000; // an announcement nobody followed up on

/** Installation-wide status: the first of these that any match has. */
const PRECEDENCE: MatchState["status"][] = ["live", "paused", "upcoming", "ended"];

/** What each caller last said about its own match, until its stream starts. */
const announcements = new Map<string, MatchState>();

/** Matches that ended before this no longer show as ended (the API key reset to idle). */
let dismissedBefore = 0;
let lastChange = new Date().toISOString();

/** Who an announcement belongs to when it came with the API key rather than a camera. */
export const API_KEY_CALLER = "api-key";

function isExpired(state: MatchState, now: number): boolean {
  const at = new Date(state.updatedAt).getTime();
  if (state.status === "ended") return now - at > ENDED_TTL_MS || at < dismissedBefore;
  if (state.status === "upcoming") return now - at > UPCOMING_TTL_MS;
  return false;
}

/** A stream's own match status, or null once it ended long enough ago. */
export function streamMatchState(meta: StreamStatusSource): MatchState | null {
  const ofMatch = meta.matchId ? { matchId: meta.matchId } : {};
  if (meta.stoppedAt) {
    const ended: MatchState = { status: "ended", updatedAt: meta.stoppedAt, ...ofMatch };
    return isExpired(ended, Date.now()) ? null : ended;
  }
  if (meta.pausedAt) return { status: "paused", updatedAt: meta.pausedAt, ...ofMatch };
  // Created but not sending yet counts as live, as it always has.
  return { status: "live", updatedAt: meta.createdAt, ...ofMatch };
}

/**
 * Every match with a status right now: the streams, then announcements.
 * Streams of one match give that match one status: live if any camera is
 * live, else paused if any is paused, else ended.
 */
export function matchStates(streams: Iterable<StreamStatusSource>): MatchState[] {
  const now = Date.now();
  for (const [caller, state] of announcements) {
    if (isExpired(state, now)) announcements.delete(caller);
  }
  const fromStreams: MatchState[] = [];
  const byMatch = new Map<string, MatchState>();
  for (const state of [...streams].map(streamMatchState)) {
    if (!state) continue;
    if (!state.matchId) {
      fromStreams.push(state);
      continue;
    }
    const other = byMatch.get(state.matchId);
    if (!other || PRECEDENCE.indexOf(state.status) < PRECEDENCE.indexOf(other.status)) byMatch.set(state.matchId, state);
  }
  return [...fromStreams, ...byMatch.values(), ...announcements.values()];
}

/** The installation's status, derived from every match. */
export function getBroadcastState(streams: Iterable<StreamStatusSource>): BroadcastState {
  const matches = matchStates(streams);
  // Two cameras announcing the same match show it once, as the first one did.
  const announced = new Set<string>();
  const upcoming = matches
    .filter((m) => m.status === "upcoming")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .filter((m) => !m.matchId || (!announced.has(m.matchId) && !!announced.add(m.matchId)))
    .map(({ message, updatedAt, matchId }) => ({ message, updatedAt, ...(matchId && { matchId }) }));

  for (const status of PRECEDENCE) {
    const same = matches.filter((m) => m.status === status);
    if (same.length === 0) continue;
    const messages = same.map((m) => m.message).filter((m): m is string => !!m);
    const updatedAt = same.map((m) => m.updatedAt).reduce((a, b) => (b > a ? b : a));
    return {
      status,
      ...(messages.length ? { message: messages.join(" · ") } : {}),
      updatedAt,
      upcoming,
    };
  }
  return { status: "idle", updatedAt: lastChange, upcoming };
}

/**
 * A status sent to PATCH /api/broadcast. Older apps send it as if the
 * installation had one status; it applies to the caller's own match:
 * - "upcoming" announces the caller's next match, until it starts a stream
 * - "ended" says the caller's match is over; it shows once nothing else is on
 * - "live" and "paused" follow the streams themselves, so they only withdraw
 *   the caller's announcement
 * - "idle" withdraws it too; the API key, for the whole installation, also
 *   clears every other announcement and recent end
 *
 * `matchId` names the match in the schedule the report is about (ABL-048).
 */
export function reportStatus(caller: string, status: BroadcastStatus, message?: string, matchId?: string): void {
  const now = new Date().toISOString();
  lastChange = now;
  announcements.delete(caller);

  if (status === "upcoming" || status === "ended") {
    announcements.set(caller, { status, ...(message ? { message } : {}), updatedAt: now, ...(matchId ? { matchId } : {}) });
  } else if (status === "idle" && caller === API_KEY_CALLER) {
    announcements.clear();
    dismissedBefore = Date.now();
  }
}

/**
 * The caller started its stream: its announcement has become that match.
 * Once a match in the schedule has started, every camera's announcement of it
 * is done with too.
 */
export function streamStartedBy(caller: string, matchId?: string): void {
  let changed = announcements.delete(caller);
  if (matchId) {
    for (const [other, state] of announcements) {
      if (state.status === "upcoming" && state.matchId === matchId) {
        announcements.delete(other);
        changed = true;
      }
    }
  }
  if (changed) lastChange = new Date().toISOString();
}

/** Forget every announcement and dismissal (tests). */
export function resetBroadcastState(): void {
  announcements.clear();
  dismissedBefore = 0;
  lastChange = new Date().toISOString();
}

/** Valid broadcast statuses for input validation */
export const VALID_STATUSES: BroadcastStatus[] = ["idle", "upcoming", "live", "paused", "ended"];
