/**
 * Persistence for live stream metadata.
 *
 * `streamMeta` drives how a recording is stitched together: which part is
 * current, which parts are complete, whether the stream is paused.  It lived
 * only in the process, so a redeploy or crash during a match left the segments
 * in storage with nothing that knew how to assemble them — and the orphan
 * cleanup an hour later could only guess.
 *
 * Writes are fire-and-forget on purpose.  Failing to record metadata must never
 * fail the broadcast that is happening right now.
 */
import type { MinioClient } from "./minio.js";
import type { StreamMeta } from "./state.js";
import { streamMeta } from "./state.js";

type Logger = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

/** Persist the current set of unfinished streams. */
export async function saveStreamMeta(minio: MinioClient, logger?: Logger): Promise<void> {
  const index: Record<string, StreamMeta> = {};
  for (const [id, meta] of streamMeta) {
    // Finished streams are already captured by the VOD index.
    if (meta.stoppedAt) continue;
    index[id] = meta;
  }

  try {
    await minio.writeStreamMetaIndex(index as unknown as Record<string, unknown>);
  } catch (err) {
    logger?.warn(err, "Could not persist stream metadata");
  }
}

/** Fire-and-forget variant for request paths. */
export function saveStreamMetaSoon(minio: MinioClient, logger?: Logger): void {
  void saveStreamMeta(minio, logger);
}

/**
 * Restore unfinished streams into memory at startup.
 * Returns the ids that were restored.
 */
export async function restoreStreamMeta(minio: MinioClient, logger?: Logger): Promise<string[]> {
  let index: Record<string, StreamMeta>;
  try {
    index = (await minio.readStreamMetaIndex()) as unknown as Record<string, StreamMeta>;
  } catch (err) {
    logger?.warn(err, "Could not read stream metadata — starting with none");
    return [];
  }

  const restored: string[] = [];
  for (const [id, meta] of Object.entries(index)) {
    if (!meta || typeof meta !== "object" || meta.stoppedAt) continue;
    streamMeta.set(id, {
      ...meta,
      partNumber: meta.partNumber ?? 1,
      // Before pause types every pause started a new period, so the part is the period.
      periodNumber: meta.periodNumber ?? meta.partNumber ?? 1,
      completedParts: Array.isArray(meta.completedParts) ? meta.completedParts : [],
    });
    restored.push(id);
  }

  if (restored.length > 0) {
    logger?.info(`Restored ${restored.length} unfinished stream(s): ${restored.join(", ")}`);
  }
  return restored;
}
