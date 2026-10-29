/**
 * Which version of Courtside a new club gets: the newest release tag
 * (v1.2.3) in the repository, never whatever was pushed last.  A broken
 * commit on the default branch thus reaches no club until it is released.
 *
 * Read with git's own HTTP protocol, so it works for any git host and is not
 * held back by GitHub's API limits.
 */

const RELEASE = /^refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/;

/** The newest vX.Y.Z among the refs a git server advertises, or undefined if there is none. */
export function newestRelease(advertisement: string): string | undefined {
  let best: [number, number, number] | undefined;
  for (const line of advertisement.split("\n")) {
    // Each line: 4 hex digits of length, the commit, a space, the ref, and on
    // the first one a NUL and the server's capabilities.
    const ref = line.split(" ")[1]?.split("\0")[0];
    const m = ref?.match(RELEASE);
    if (!m) continue;
    const v: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || newer(v, best)) best = v;
  }
  return best && `v${best.join(".")}`;
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/**
 * Whether release a is newer than what an app runs.  An app on a branch, or
 * on no ref at all, is behind every release.
 */
export function isNewer(a: string, current: string | undefined): boolean {
  const parse = (v: string | undefined) => v?.match(/^v(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const x = parse(a);
  if (!x) return false;
  const y = parse(current);
  return !y || newer(x, y);
}

const CACHE_MS = 5 * 60_000;
let cached: { gitUrl: string; at: number; ref: string | undefined } | undefined;

/**
 * The newest release of the repository at gitUrl, or undefined if it has
 * none yet (then the default branch is built).  Throws if the repository
 * cannot be read, so a new club is never quietly given the default branch.
 */
export async function latestRelease(gitUrl: string, token?: string): Promise<string | undefined> {
  if (cached && cached.gitUrl === gitUrl && Date.now() - cached.at < CACHE_MS) return cached.ref;
  const url = `${gitUrl.replace(/\/$/, "").replace(/(\.git)?$/, ".git")}/info/refs?service=git-upload-pack`;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Reading the releases of ${gitUrl} → ${res.status}`);
  const ref = newestRelease(await res.text());
  cached = { gitUrl, at: Date.now(), ref };
  return ref;
}
