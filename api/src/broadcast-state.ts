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
 * Matches are keyed by stream and announcements by the camera that made them.
 * ABL-048 re-keys both on a match id.
 */

export type BroadcastStatus = "idle" | "upcoming" | "live" | "paused" | "ended";

/** One match's status. A match is never "idle"; it just stops being listed. */
export interface MatchState {
  status: Exclude<BroadcastStatus, "idle">;
  message?: string;
  updatedAt: string;
}

export interface BroadcastState {
  status: BroadcastStatus;
  message?: string;
  updatedAt: string;
  /** Announced matches that have not started yet, oldest first */
  upcoming: { message?: string; updatedAt: string }[];
}

/** The part of a stream's metadata its status is derived from. */
export interface StreamStatusSource {
  createdAt: string;
  pausedAt?: string;
  stoppedAt?: string;
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
  if (meta.stoppedAt) {
    const ended: MatchState = { status: "ended", updatedAt: meta.stoppedAt };
    return isExpired(ended, Date.now()) ? null : ended;
  }
  if (meta.pausedAt) return { status: "paused", updatedAt: meta.pausedAt };
  // Created but not sending yet counts as live, as it always has.
  return { status: "live", updatedAt: meta.createdAt };
}

/** Every match with a status right now: the streams, then announcements. */
export function matchStates(streams: Iterable<StreamStatusSource>): MatchState[] {
  const now = Date.now();
  for (const [caller, state] of announcements) {
    if (isExpired(state, now)) announcements.delete(caller);
  }
  const fromStreams = [...streams].map(streamMatchState).filter((s): s is MatchState => s !== null);
  return [...fromStreams, ...announcements.values()];
}

/** The installation's status, derived from every match. */
export function getBroadcastState(streams: Iterable<StreamStatusSource>): BroadcastState {
  const matches = matchStates(streams);
  const upcoming = matches
    .filter((m) => m.status === "upcoming")
    .map(({ message, updatedAt }) => ({ message, updatedAt }));

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
 */
export function reportStatus(caller: string, status: BroadcastStatus, message?: string): void {
  const now = new Date().toISOString();
  lastChange = now;
  announcements.delete(caller);

  if (status === "upcoming" || status === "ended") {
    announcements.set(caller, { status, ...(message ? { message } : {}), updatedAt: now });
  } else if (status === "idle" && caller === API_KEY_CALLER) {
    announcements.clear();
    dismissedBefore = Date.now();
  }
}

/** The caller started its stream: its announcement has become that match. */
export function streamStartedBy(caller: string): void {
  if (announcements.delete(caller)) lastChange = new Date().toISOString();
}

/** Forget every announcement and dismissal (tests). */
export function resetBroadcastState(): void {
  announcements.clear();
  dismissedBefore = 0;
  lastChange = new Date().toISOString();
}

/** Valid broadcast statuses for input validation */
export const VALID_STATUSES: BroadcastStatus[] = ["idle", "upcoming", "live", "paused", "ended"];
