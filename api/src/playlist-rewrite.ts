/**
 * Rewrites the segment URIs in an HLS manifest.
 *
 * Manifests are stored with bare segment filenames.  They are never served
 * from storage — the API serves them and points each segment at a media route,
 * so access is checked per request and the underlying storage stays private.
 */

/**
 * Replace every segment URI, leaving tags and structure untouched.
 *
 * `mapUri` receives the bare filename (query string stripped, any leading path
 * or host removed) and returns the URI to put in its place.
 */
export function rewriteSegmentUris(
  manifest: string,
  mapUri: (filename: string) => string
): string {
  return manifest
    .split("\n")
    .map((raw) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return raw;
      const filename = line.split("?")[0].split("/").pop();
      return filename ? mapUri(filename) : raw;
    })
    .join("\n");
}

/**
 * The continuous feed a stored segment belongs to: its part (`p2`, `pause1`)
 * and, within a part, the restart run (`r1`, see SegmentCollector). Null for a
 * name that does not follow the stored layout.
 */
export function feedOf(filename: string): string | null {
  const m = filename.match(/^(p\d+|pause\d+)_(?:(r\d+)_)?/);
  return m ? `${m[1]}/${m[2] ?? "r0"}` : null;
}

/**
 * Mark every place where the feed starts over with #EXT-X-DISCONTINUITY.
 *
 * When the camera reconnects mid-period, Restreamer's ffmpeg starts again and
 * its timestamps restart from zero, while the collector keeps filling the same
 * part. Without the tag, a player treats the jump as one continuous timeline and
 * puts the new segments in the wrong place in its buffer: seeking past such a
 * point can stall for good. Parts are already separated by the stitcher; this
 * covers restarts within a part, including recordings stored before this fix,
 * since it is applied when a playlist is served. Idempotent.
 */
export function markFeedRestarts(manifest: string): string {
  const out: string[] = [];
  let previousFeed: string | null = null;
  let segmentStart = 0; // where the current segment's tags begin in `out`
  let marked = false;

  for (const raw of manifest.split("\n")) {
    const line = raw.trim();
    if (line === "#EXT-X-DISCONTINUITY") marked = true;

    if (line && !line.startsWith("#")) {
      const feed = feedOf(line.split("?")[0].split("/").pop() ?? "");
      if (feed && previousFeed && feed !== previousFeed && !marked) {
        out.splice(segmentStart, 0, "#EXT-X-DISCONTINUITY");
      }
      if (feed) previousFeed = feed;
      out.push(raw);
      segmentStart = out.length;
      marked = false;
      continue;
    }
    out.push(raw);
  }
  return out.join("\n");
}
