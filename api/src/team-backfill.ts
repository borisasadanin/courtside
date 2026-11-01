/**
 * One-time backfill (ABL-048): every team named on a recording made before the
 * registry joins it, so old opponents show up under Hantera → Lag ready for a
 * logo. The club's own side (homeTeam) joins as one of the club's own teams.
 * The placeholders used when the camera typed nothing are left out.
 *
 * Done once per installation and marked in config/backfill.json, so a team
 * the admin removed afterwards does not come back at the next restart.
 * ensure() makes a second run harmless anyway.
 */
import type { TeamRegistry } from "./teams.js";
import { normalizeName, teamKey } from "./teams.js";
import type { VodEntry } from "./types.js";

export const BACKFILL_KEY = "config/backfill.json";

interface BackfillStorage {
  readFileIfExists(key: string): Promise<string | null>;
  uploadBuffer(key: string, body: Buffer | string, contentType: string): Promise<void>;
  readVodIndex(): Promise<VodEntry[]>;
}

interface BackfillMarks {
  /** When the teams on existing recordings were added to the registry. */
  teamsFromRecordings?: string;
}

/**
 * Add the teams of existing recordings to the registry, unless done before.
 * Returns how many teams were new. Throws when storage cannot be read, and
 * then marks nothing, so the next start tries again.
 */
export async function backfillTeams(
  storage: BackfillStorage,
  teams: Pick<TeamRegistry, "findByName" | "ensure">,
  placeholders: string[],
): Promise<number> {
  const raw = await storage.readFileIfExists(BACKFILL_KEY);
  const marks: BackfillMarks = raw ? JSON.parse(raw) : {};
  if (marks.teamsFromRecordings) return 0;

  const skip = new Set(placeholders.map(teamKey));
  // One per name; a name that was ever the club's side is one of its own teams.
  const names = new Map<string, { name: string; own: boolean }>();
  for (const vod of await storage.readVodIndex()) {
    for (const [name, own] of [[vod.homeTeam, true], [vod.awayTeam, false]] as const) {
      const key = teamKey(name ?? "");
      if (!key || skip.has(key)) continue;
      const seen = names.get(key);
      if (seen) seen.own ||= own;
      else names.set(key, { name: normalizeName(name), own });
    }
  }

  let added = 0;
  for (const { name, own } of names.values()) {
    if (await teams.findByName(name)) continue;
    if (await teams.ensure(name, { own })) added++;
  }

  marks.teamsFromRecordings = new Date().toISOString();
  await storage.uploadBuffer(BACKFILL_KEY, JSON.stringify(marks, null, 2), "application/json");
  return added;
}
