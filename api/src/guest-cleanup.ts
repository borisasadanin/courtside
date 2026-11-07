/**
 * Guest space retention (#52).
 *
 * A guest space is deleted whole, clips, files and code, once its deleteAfter()
 * date has passed: GUEST_RETENTION_MS after the match.  It is run at startup and
 * then every hour, so an installation that was down still tidies up when it is
 * back.  Each deleted space gets one entry in the deletion log.
 */
import { deleteAfter, guestPrefix, GUEST_RETENTION_MS, type GuestSpaces, type GuestStorage } from "./guest-spaces.js";
import { logDeletion } from "./erasure.js";

/** How often the cleanup runs after startup. */
export const GUEST_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Spaces being deleted.  Written before a space is touched and cleared once its
 * index entry, files and log entry are all done, so a storage failure or a
 * crash halfway (index entry gone, files left) is finished by the next run
 * instead of leaving files that nothing points to.
 */
export const GUEST_PENDING_KEY = "guest-spaces-deleting.json";

interface PendingSpace {
  id: string;
  match: string;
  clips: number;
}

async function readPending(storage: GuestStorage): Promise<PendingSpace[]> {
  const raw = await storage.readFileIfExists(GUEST_PENDING_KEY);
  return raw ? (JSON.parse(raw) as PendingSpace[]) : [];
}

async function writePending(storage: GuestStorage, pending: PendingSpace[]): Promise<void> {
  await storage.uploadBuffer(GUEST_PENDING_KEY, JSON.stringify(pending, null, 2), "application/json");
}

export interface GuestCleanupResult {
  /** Spaces deleted, with their file and clip counts. */
  removed: { id: string; files: number; clips: number }[];
  /** Spaces that were due but could not be (fully) deleted; tried again next run. */
  failed: { id: string; error: unknown }[];
}

let running: Promise<GuestCleanupResult> | undefined;

/**
 * Delete every guest space whose deleteAfter() is at or before `now`, and log
 * each one.  A space that fails is reported and tried again next run; the
 * others still go.  Overlapping calls share one run.
 */
export function cleanupGuestSpaces(
  spaces: GuestSpaces,
  storage: GuestStorage,
  now: Date = new Date(),
): Promise<GuestCleanupResult> {
  running ??= runCleanup(spaces, storage, now).finally(() => (running = undefined));
  return running;
}

async function runCleanup(spaces: GuestSpaces, storage: GuestStorage, now: Date): Promise<GuestCleanupResult> {
  const result: GuestCleanupResult = { removed: [], failed: [] };
  const targets = await readPending(storage);
  for (const space of await spaces.list()) {
    if (deleteAfter(space).getTime() > now.getTime()) continue;
    if (targets.some((t) => t.id === space.id)) continue;
    targets.push({ id: space.id, match: `${space.homeTeam} – ${space.awayTeam}`, clips: space.clips.length });
  }
  if (targets.length === 0) return result;
  await writePending(storage, targets);

  const left: PendingSpace[] = [];
  for (const t of targets) {
    try {
      // The index entry goes first, so the code and shared links stop working
      // before the files go.  Already gone when a run before failed halfway.
      await spaces.removeEntry(t.id);
      const files = await storage.deletePrefix(guestPrefix(t.id));
      await logDeletion(storage, {
        what: "guest-space",
        id: t.id,
        match: t.match,
        reason: "retention",
        onRequest: false,
        files,
        clips: t.clips,
      });
      result.removed.push({ id: t.id, files, clips: t.clips });
    } catch (error) {
      left.push(t);
      result.failed.push({ id: t.id, error });
    }
  }
  await writePending(storage, left);
  return result;
}

/** Run the cleanup now and then every hour. The timer never keeps the process alive. */
export function startGuestCleanup(
  spaces: GuestSpaces,
  storage: GuestStorage,
  logger: { info: (msg: string) => void; error: (obj: unknown, msg: string) => void },
): NodeJS.Timeout {
  const run = async () => {
    try {
      const { removed, failed } = await cleanupGuestSpaces(spaces, storage);
      if (removed.length > 0) logger.info(`Guest cleanup: removed ${removed.length} guest space(s) after ${GUEST_RETENTION_MS / 86_400_000} days`);
      for (const f of failed) logger.error(f.error, `Guest cleanup: could not remove guest space ${f.id}`);
    } catch (err) {
      logger.error(err, "Guest cleanup failed");
    }
  };
  void run();
  const timer = setInterval(run, GUEST_CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}
