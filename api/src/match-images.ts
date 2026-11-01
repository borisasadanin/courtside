/**
 * Match images (ABL-045): a cover for every recorded match, and a picture of
 * what is happening right now on every live stream.
 *
 * Nobody takes these pictures; the system does.  A match's cover is, in order:
 *
 *   1. the highlight the admin chose in Hantera,
 *   2. the thumbnail of the match's first highlight,
 *   3. a frame from a little into the first period, grabbed when the recording
 *      stops.
 *
 * The frame and the live picture are stored beside the recording, under
 * <streamId>/, so they are served through /api/media/* behind the viewer PIN
 * exactly like the video, and deleting the match takes them with it.  Clip
 * thumbnails stay where they are, reached the way a shared clip is.
 */
import type { FastifyBaseLogger } from "fastify";
import { collectors, minio, streamMeta } from "./state.js";
import { SegmentCollector } from "./segment-collector.js";
import { extractSegmentFrame } from "./mp4-converter.js";
import type { HighlightClip, StreamPublicInfo, VodEntry } from "./types.js";

export function coverKey(streamId: string): string {
  return `${streamId}/cover.jpg`;
}

export function livePictureKey(streamId: string): string {
  return `${streamId}/live.jpg`;
}

// ============================
// Cover
// ============================

export interface MatchCover {
  url: string;
  source: "chosen" | "highlight" | "frame";
}

/** The cover of one recording, or undefined when there is nothing to show. */
export function matchCover(vod: VodEntry, clips: HighlightClip[]): MatchCover | undefined {
  const own = clips
    .filter((c) => c.streamId === vod.id && c.thumbnailUrl)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // A chosen clip that has since been deleted falls through to the rest.
  const chosen = vod.coverClipId && own.find((c) => c.id === vod.coverClipId);
  if (chosen) return { url: chosen.thumbnailUrl!, source: "chosen" };
  if (own.length > 0) return { url: own[0].thumbnailUrl!, source: "highlight" };
  if (vod.frameCover) return { url: `/api/media/${coverKey(vod.id)}`, source: "frame" };
  // ABL-049: a card drawn from the teams' logos or initials goes here.
  return undefined;
}

/** How far into the first period the cover frame is taken: past the tip-off, into play. */
export const COVER_OFFSET_SECONDS = 120;

/**
 * The segment `offsetSeconds` into a part, or its middle when the part is
 * shorter than that.
 */
export function pickCoverSegment<T extends { duration: number }>(
  timeline: T[],
  offsetSeconds = COVER_OFFSET_SECONDS,
): T | undefined {
  const total = timeline.reduce((sum, s) => sum + s.duration, 0);
  const target = Math.min(offsetSeconds, total / 2);
  let start = 0;
  for (const seg of timeline) {
    if (start + seg.duration > target) return seg;
    start += seg.duration;
  }
  return timeline[timeline.length - 1];
}

/**
 * Store a frame from the first period as the match's cover.  Part 1 is always
 * in the first period; a later part is used only when part 1 has no video.
 * Best-effort: a match without a frame simply has no cover of this kind.
 */
export async function saveCoverFrame(
  streamId: string,
  partCount: number,
  log: FastifyBaseLogger,
  grab: (segment: Buffer) => Promise<Buffer> = (s) => extractSegmentFrame(s, 1280),
): Promise<boolean> {
  try {
    for (let part = 1; part <= partCount; part++) {
      const timeline = await SegmentCollector.readCheckpoint(minio, streamId, part);
      const seg = pickCoverSegment(timeline);
      if (!seg) continue;
      const frame = await grab(await minio.downloadBuffer(`${streamId}/p${part}_${seg.filename}`));
      await minio.uploadBuffer(coverKey(streamId), frame, "image/jpeg");
      await minio.updateVodEntry(streamId, { frameCover: true });
      log.info(`Saved cover frame for ${streamId} from part ${part} (${frame.length} bytes)`);
      return true;
    }
  } catch (err) {
    log.warn(err, `Could not save a cover frame for ${streamId}`);
  }
  return false;
}

// ============================
// Live picture
// ============================

/** A new live picture at most this often per stream. */
export const LIVE_PICTURE_EVERY_MS = 60_000;
/** How often to look for streams that are due, so a new stream gets its first picture soon. */
const LIVE_PICTURE_TICK_MS = 10_000;

interface LivePicture {
  /** When the stored picture was taken; also the URL's version, so browsers fetch the new one. */
  takenAt: number;
  /** When the last run started, successful or not. */
  startedAt: number;
  /** The segment it was taken from, so a stalled stream is not grabbed again. */
  segment: string;
}

const livePictures = new Map<string, LivePicture>();
/** Runs in progress, one per stream at most. */
const running = new Map<string, Promise<void>>();

/**
 * One round: a picture from the newest segment of every stream that is due.
 * A stream whose previous run has not finished is skipped, so there is never
 * more than one FFmpeg run per stream, and at most one a minute.
 */
export async function takeLivePictures(
  log: FastifyBaseLogger,
  grab: (segment: Buffer) => Promise<Buffer> = (s) => extractSegmentFrame(s, 640),
): Promise<void> {
  const runs: Promise<void>[] = [];
  const now = Date.now();
  for (const [streamId, collector] of collectors) {
    if (running.has(streamId) || streamMeta.get(streamId)?.stoppedAt) continue;
    const last = livePictures.get(streamId);
    if (last && now - last.startedAt < LIVE_PICTURE_EVERY_MS) continue;
    const newest = collector.getSegmentTimeline().at(-1);
    if (!newest || newest.key === last?.segment) continue;

    const run = (async () => {
      const startedAt = Date.now();
      try {
        const frame = await grab(await minio.downloadBuffer(newest.key));
        await minio.uploadBuffer(livePictureKey(streamId), frame, "image/jpeg");
        livePictures.set(streamId, { takenAt: Date.now(), startedAt, segment: newest.key });
      } catch (err) {
        // Wait the full minute before trying again; the card keeps the last picture.
        livePictures.set(streamId, { takenAt: last?.takenAt ?? 0, startedAt, segment: last?.segment ?? "" });
        log.warn(err, `Could not take a live picture for ${streamId}`);
      } finally {
        running.delete(streamId);
      }
    })();
    running.set(streamId, run);
    runs.push(run);
  }
  await Promise.all(runs);
}

export function startLivePictures(log: FastifyBaseLogger): void {
  setInterval(() => void takeLivePictures(log), LIVE_PICTURE_TICK_MS).unref();
}

/** The live picture's URL, when the stream has one. */
export function livePictureUrl(streamId: string): string | undefined {
  const picture = livePictures.get(streamId);
  if (!picture?.takenAt) return undefined;
  return `/api/media/${livePictureKey(streamId)}?t=${picture.takenAt}`;
}

/** The public stream list with each stream's live picture. A stopped stream has none. */
export function withLivePictures(streams: StreamPublicInfo[]): StreamPublicInfo[] {
  return streams.map((s) => {
    const posterUrl = s.status === "stopped" ? undefined : livePictureUrl(s.id);
    return posterUrl ? { ...s, posterUrl } : s;
  });
}

/** Forget a stream's live picture. Its file goes with the match's other files. */
export function forgetLivePicture(streamId: string): void {
  livePictures.delete(streamId);
}

/**
 * The recording has stopped: the live picture has done its job and goes, and
 * a frame from the first period is kept as a cover.  Never throws.
 */
export async function recordingStopped(
  streamId: string,
  partCount: number,
  log: FastifyBaseLogger,
): Promise<void> {
  // A run still in progress would put the picture back after it was removed.
  await running.get(streamId);
  forgetLivePicture(streamId);
  try {
    await minio.deleteObject(livePictureKey(streamId));
  } catch (err) {
    log.warn(err, `Could not remove the live picture of ${streamId}`);
  }
  await saveCoverFrame(streamId, partCount, log);
}
