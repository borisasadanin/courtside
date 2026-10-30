/**
 * Removing recordings for good: a whole match, or one highlight clip.
 *
 * A match's clips live apart from it, under clips/<streamId>/ and in the clips
 * index, and a shared clip opens without the PIN.  So deleting a match deletes
 * its clips too, or a clip of it would stay watchable after the match was
 * removed.  Deleting a clip ends its shared link at once.
 *
 * The index entry goes first: once it is gone, nothing serves the clip, even if
 * removing its files then fails.  Deleting again finishes the job.
 */
import { clipsByStream } from "./state.js";
import type { MinioClient } from "./minio.js";
import type { HighlightClip } from "./types.js";

export interface Erased {
  /** False when there was nothing by that id to delete. */
  found: boolean;
  clips: HighlightClip[];
  files: number;
}

/** Delete a match, its files and every clip made from it. */
export async function deleteMatch(minio: MinioClient, streamId: string): Promise<Erased> {
  const clips = await minio.removeClipEntries((c) => c.streamId === streamId);
  clipsByStream.delete(streamId);

  let files = await minio.deletePrefix(`clips/${streamId}/`);
  files += await minio.deleteVodFiles(streamId);

  const removed = await minio.removeVodEntry(streamId);
  return { found: removed || clips.length > 0 || files > 0, clips, files };
}

/** Delete one clip. Its match, and the segments the match plays from, stay. */
export async function deleteClip(minio: MinioClient, clipId: string): Promise<Erased> {
  const clips = await minio.removeClipEntries((c) => c.id === clipId);
  if (clips.length === 0) return { found: false, clips, files: 0 };

  let files = 0;
  for (const clip of clips) {
    const live = clipsByStream.get(clip.streamId);
    if (live) clipsByStream.set(clip.streamId, live.filter((c) => c.id !== clip.id));
    // The manifest, MP4 and thumbnail: clips/<streamId>/<clipId>.{m3u8,mp4,jpg}
    files += await minio.deletePrefix(`clips/${clip.streamId}/${clip.id}.`);
  }
  return { found: true, clips, files };
}

/**
 * Clips whose match is gone.  Earlier versions deleted a match without its
 * clips; those clips are still listed and still open from a shared link, so
 * the admin view offers them for deletion.
 */
export function orphanClips(clips: HighlightClip[], matchIds: Set<string>, live: Set<string>): HighlightClip[] {
  return clips.filter((c) => !matchIds.has(c.streamId) && !live.has(c.streamId));
}
