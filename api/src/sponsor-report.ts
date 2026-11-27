/**
 * The sponsor's report (#121, #141): what viewers saw of one sponsor in one
 * season, match by match and surface by surface, live and replay apart.
 *
 * Read from the saved counts (sponsor-stats.ts), never from ids. Different
 * viewers are counted per match: someone who watched three matches is in
 * each of them, so the season has no number of different viewers, and the
 * matches' numbers are not to be added up or compared as people.
 */
import { SURFACES, surfaceDef } from "./sponsor-surfaces.js";
import {
  STATS_PREFIX,
  STAT_MODES,
  addCounts,
  emptyCounts,
  mergeCounts,
  parseStatsFile,
  seasonLabel,
  seasonRange,
  type Counts,
  type StatMode,
  type StatsFile,
} from "./sponsor-stats.js";

export interface ReportStorage {
  listKeys(prefix: string): Promise<string[]>;
  readFileIfExists(key: string): Promise<string | null>;
}

/** Counts with the shares worked out: of the starts, how many were watched to the end and with sound. */
export interface ReportRow extends Counts {
  /** 0–1, or null without starts. */
  completeRate: number | null;
  soundRate: number | null;
}

export interface ReportSurface {
  id: string;
  label: string;
  live: ReportRow;
  replay: ReportRow;
}

export interface ReportMatch {
  key: string;
  date: string;
  homeTeam?: string;
  awayTeam?: string;
  /** Different viewers who saw the sponsor anywhere in this match. */
  viewers: Record<StatMode, number>;
  surfaces: ReportSurface[];
}

/** A surface over the season: no viewers, as those are counted per match. */
export interface ReportTotal {
  id: string;
  label: string;
  /** Matches where the sponsor was seen on it. */
  matches: number;
  live: Omit<ReportRow, "viewers">;
  replay: Omit<ReportRow, "viewers">;
}

export interface SponsorReport {
  sponsor: { id: string; name: string };
  season: { id: string; label: string; from: string; to: string };
  matches: ReportMatch[];
  surfaces: ReportTotal[];
}

function row(c: Counts): ReportRow {
  return {
    ...c,
    completeRate: c.starts ? c.completes / c.starts : null,
    soundRate: c.starts ? c.sounds / c.starts : null,
  };
}

function withoutViewers({ viewers: _v, ...rest }: ReportRow): Omit<ReportRow, "viewers"> {
  return rest;
}

/** The surfaces in the admin's order, then any no longer defined. */
function surfaceOrder(ids: Iterable<string>): string[] {
  const known = SURFACES.map((s) => s.id as string);
  const all = new Set(ids);
  return [...known.filter((id) => all.has(id)), ...[...all].filter((id) => !known.includes(id)).sort()];
}

/**
 * The report for one sponsor from the season's files. Matches without the
 * sponsor are left out. Files of the same match are added together: a season
 * start changed after a restart can leave a match in two seasons' folders.
 */
export function buildReport(
  files: StatsFile[],
  sponsor: { id: string; name: string },
  season: string,
  seasonStart?: string | null,
): SponsorReport {
  const range = seasonRange(season, seasonStart);
  const byKey = new Map<string, StatsFile>();
  for (const f of files) {
    if (f.match.date < range.from || f.match.date > range.to) continue;
    const had = byKey.get(f.match.key);
    byKey.set(f.match.key, had ? { ...had, ...mergeCounts(had, f) } : f);
  }

  const matches: ReportMatch[] = [];
  const totals = new Map<string, { matches: number; live: Counts; replay: Counts }>();
  for (const f of byKey.values()) {
    const x = f.sponsors[sponsor.id];
    if (!x) continue;
    const surfaces: ReportSurface[] = [];
    for (const id of surfaceOrder(Object.keys(x.surfaces))) {
      const modes = x.surfaces[id];
      const live = addCounts(emptyCounts(), modes.live);
      const replay = addCounts(emptyCounts(), modes.replay);
      surfaces.push({ id, label: surfaceDef(id)?.label ?? id, live: row(live), replay: row(replay) });
      const t = totals.get(id) ?? { matches: 0, live: emptyCounts(), replay: emptyCounts() };
      totals.set(id, { matches: t.matches + 1, live: addCounts(t.live, live), replay: addCounts(t.replay, replay) });
    }
    matches.push({
      key: f.match.key,
      date: f.match.date,
      ...(f.match.homeTeam && { homeTeam: f.match.homeTeam }),
      ...(f.match.awayTeam && { awayTeam: f.match.awayTeam }),
      viewers: Object.fromEntries(STAT_MODES.map((m) => [m, x.viewers[m] ?? 0])) as Record<StatMode, number>,
      surfaces,
    });
  }
  matches.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));

  return {
    sponsor,
    season: { id: season, label: seasonLabel(season), ...range },
    matches,
    surfaces: surfaceOrder(totals.keys()).map((id) => {
      const t = totals.get(id)!;
      return {
        id,
        label: surfaceDef(id)?.label ?? id,
        matches: t.matches,
        live: withoutViewers(row(t.live)),
        replay: withoutViewers(row(t.replay)),
      };
    }),
  };
}

/**
 * The files that may hold a season's matches: its own folder and the ones
 * either side, as a match is filed by the season start it was saved under.
 * buildReport keeps those whose date is in the season.
 */
export async function readSeasonFiles(storage: ReportStorage, season: string): Promise<StatsFile[]> {
  const year = Number(season);
  const keys = (await Promise.all([year - 1, year, year + 1].map((y) => storage.listKeys(`${STATS_PREFIX}${y}/`)))).flat();
  const files = await Promise.all(keys.filter((k) => k.endsWith(".json")).map((k) => storage.readFileIfExists(k)));
  return files.map(parseStatsFile).filter((f): f is StatsFile => f !== null);
}

/** The seasons that have saved counts, newest first. */
export async function seasonsWithData(storage: ReportStorage): Promise<string[]> {
  const seasons = new Set<string>();
  for (const key of await storage.listKeys(STATS_PREFIX)) {
    const m = key.slice(STATS_PREFIX.length).match(/^(\d{4})\//);
    if (m) seasons.add(m[1]);
  }
  return [...seasons].sort().reverse();
}
