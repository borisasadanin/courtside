/**
 * Updating this installation to a newer Courtside release, from the admin view.
 *
 * The same move as the Uppdatera button on courtside.apps.osaas.io: the app's
 * source ref in OSC is pointed at the newest release tag, and OSC rebuilds it
 * from that.  The site is down for a few minutes meanwhile, so it is refused
 * while a match is being broadcast.  Recordings and settings live in the
 * club's storage and parameter store and are not touched.
 *
 * Only forward: going back is for when a release goes wrong, and is done in
 * OSC by hand (see CHANGELOG.md).
 */
import { call, deployBase, ownApp } from "./teardown.js";
import type { Text } from "./i18n.js";

export interface UpdateInfo {
  /** The release OSC builds this installation from: a tag, or a branch for one not on a release. */
  current?: string;
  /** The newest release, when it is newer than current. */
  available?: string;
  /** Where to read what changed. */
  changelogUrl?: string;
  /** Why updating from here is not possible, when it is not. */
  reason?: Text;
}

/** Something the admin can fix by waiting, as opposed to a failure. */
export class NotNow extends Error {
  constructor(readonly text: Text) {
    super(text.sv);
  }
}

// --- Releases: same rules as landing/src/release.ts ---

const RELEASE = /^refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/;

/** The newest vX.Y.Z among the refs a git server advertises, or undefined if there is none. */
export function newestRelease(advertisement: string): string | undefined {
  let best: number[] | undefined;
  for (const line of advertisement.split("\n")) {
    const ref = line.split(" ")[1]?.split("\0")[0];
    const m = ref?.match(RELEASE);
    if (!m) continue;
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || newer(v, best)) best = v;
  }
  return best && `v${best.join(".")}`;
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** Whether release a is newer than what the app runs.  A branch, or no ref at all, is behind every release. */
export function isNewer(a: string, current: string | undefined): boolean {
  const parse = (v: string | undefined) => v?.match(/^v(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const x = parse(a);
  if (!x) return false;
  const y = parse(current);
  return !y || newer(x, y);
}

const CACHE_MS = 5 * 60_000;
let cached: { gitUrl: string; at: number; ref: string | undefined } | undefined;

async function latestRelease(gitUrl: string): Promise<string | undefined> {
  if (cached && cached.gitUrl === gitUrl && Date.now() - cached.at < CACHE_MS) return cached.ref;
  const url = `${gitUrl.replace(/\/$/, "").replace(/(\.git)?$/, ".git")}/info/refs?service=git-upload-pack`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Reading the releases of ${gitUrl} → ${res.status}`);
  const ref = newestRelease(await res.text());
  cached = { gitUrl, at: Date.now(), ref };
  return ref;
}

// --- This installation ---

interface Self {
  id: string;
  gitUrl: string;
  sourceRef?: string;
  building: boolean;
}

async function self(): Promise<Self | Text> {
  const own = await ownApp({ sv: "Uppdatera den i Open Source Cloud.", en: "Update it in Open Source Cloud." });
  if ("sv" in own) return own;
  const a = own.record;
  const [gitUrl, fromUrl] = String(a.gitUrl || a.gitHubUrl || "").split("#");
  return {
    id: String(a.id ?? a.name),
    gitUrl,
    sourceRef: (a.sourceRef as string | undefined) || fromUrl || undefined,
    building: a.buildStatus === "building",
  };
}

/** GitHub shows the changelog at this address; other hosts get none. */
function changelogUrl(gitUrl: string): string | undefined {
  const repo = gitUrl.replace(/\.git$/, "").replace(/\/$/, "");
  return /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo) ? `${repo}/blob/master/CHANGELOG.md` : undefined;
}

export async function updateInfo(): Promise<UpdateInfo> {
  let app: Self | Text;
  try {
    app = await self();
  } catch {
    return { reason: { sv: "Kunde inte nå Open Source Cloud. Försök igen om en stund.", en: "Could not reach Open Source Cloud. Try again in a while." } };
  }
  if ("sv" in app) return { reason: app };

  const info: UpdateInfo = { current: app.sourceRef, changelogUrl: changelogUrl(app.gitUrl) };
  try {
    const latest = await latestRelease(app.gitUrl);
    if (latest && latest !== app.sourceRef && isNewer(latest, app.sourceRef)) info.available = latest;
  } catch {
    info.reason = {
      sv: "Kunde inte läsa vilka versioner av Courtside som finns. Försök igen om en stund.",
      en: "Could not read which versions of Courtside exist. Try again in a while.",
    };
  }
  return info;
}

/**
 * Points the app at the newest release.  Returns that release, or throws
 * NotNow when the admin should try again later.
 */
export async function startUpdate(activeStreams: number): Promise<string> {
  if (activeStreams > 0) throw new NotNow({ sv: "Det pågår en sändning just nu. Uppdatera när matchen är slut.", en: "A broadcast is running right now. Update when the game is over." });
  const app = await self();
  if ("sv" in app) throw new NotNow(app);
  if (app.building) throw new NotNow({ sv: "Plattformen byggs redan. Vänta tills den är igång och försök igen.", en: "The platform is already being built. Wait until it is up and try again." });
  const latest = await latestRelease(app.gitUrl);
  if (!latest || latest === app.sourceRef || !isNewer(latest, app.sourceRef)) {
    throw new NotNow({ sv: "Plattformen har redan den senaste versionen.", en: "The platform already has the newest version." });
  }
  await call("PATCH", `${deployBase()}/myapps/${encodeURIComponent(app.id)}/source-ref`, { sourceRef: latest });
  return latest;
}
