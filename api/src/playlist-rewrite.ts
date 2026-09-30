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
