/**
 * Viewer counting: each open player sends a heartbeat with its own random id,
 * and a stream's viewers are the ids heard from within the TTL.
 *
 * Not by IP address: behind the platform's proxies the server sees the
 * proxy's address, and one viewer's requests alternate between proxies — one
 * person counted as two, and a crowd capped at the number of proxies.
 */

const VIEWER_TTL_MS = 60_000; // 60s without heartbeat = viewer gone

/** Most viewers counted per stream: the heartbeat needs no login, so a cap keeps memory bounded. */
export const MAX_VIEWERS_PER_STREAM = 5_000;

/** A player's id: what the web player makes, and nothing that could fill memory. */
const VIEWER_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** streamId -> Map<viewerId, lastSeenTimestamp> */
export const viewers = new Map<string, Map<string, number>>();

export function isValidViewerId(viewerId: unknown): viewerId is string {
  return typeof viewerId === "string" && VIEWER_ID.test(viewerId);
}

function prune(map: Map<string, number>, now: number): void {
  for (const [viewerId, ts] of map) {
    if (now - ts > VIEWER_TTL_MS) map.delete(viewerId);
  }
}

export function registerViewer(streamId: string, viewerId: string): void {
  let map = viewers.get(streamId);
  if (!map) {
    map = new Map();
    viewers.set(streamId, map);
  }
  const now = Date.now();
  if (!map.has(viewerId) && map.size >= MAX_VIEWERS_PER_STREAM) {
    prune(map, now);
    if (map.size >= MAX_VIEWERS_PER_STREAM) return;
  }
  map.set(viewerId, now);
}

/** A player that closed: gone at once instead of after the TTL. */
export function removeViewer(streamId: string, viewerId: string): void {
  viewers.get(streamId)?.delete(viewerId);
}

export function getViewerCount(streamId: string): number {
  const map = viewers.get(streamId);
  if (!map) return 0;
  prune(map, Date.now());
  return map.size;
}
