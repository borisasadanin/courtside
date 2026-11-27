/**
 * Which of the club's teams a match, a stream or a replay belongs to (#124).
 *
 * The sponsors that apply to a team are shown on its matches, so every
 * surface needs to know the team. This is the one place that decides it, and
 * the only one to change when the team model changes (#82).
 *
 * In order:
 *   1. the match's own team, by its id in the registry,
 *   2. for a stream or a replay without a match: the match its metadata or VOD entry names,
 *   3. otherwise the home team's name, looked up in the registry (aliases count).
 *
 * Null when none of them gives a team: then only the club's sponsors apply.
 */
import { matches, minio, sponsors, streamMeta, teams } from "./state.js";
import { sponsorsFor, type SponsorPick } from "./sponsor-surfaces.js";
import type { VodEntry } from "./types.js";

export interface SponsorContext {
  matchId?: string;
  streamId?: string;
  vodId?: string;
}

/** What ownTeamOf reads, so the tests can hand in their own. */
export interface OwnTeamDeps {
  /** The match with its teams as the registry has them now; ownTeam.id is "" for a name it no longer has. */
  matchSummary(id: string): Promise<{ ownTeam: { id: string } } | null>;
  stream(id: string): { matchId?: string; homeTeam?: string } | undefined;
  vod(id: string): Promise<Pick<VodEntry, "matchId" | "homeTeam"> | undefined>;
  findTeamByName(name: string): Promise<{ id: string } | null>;
}

const live: OwnTeamDeps = {
  matchSummary: (id) => matches.summary(id),
  stream: (id) => streamMeta.get(id),
  vod: async (id) => (await minio.readVodIndex()).find((v) => v.id === id),
  findTeamByName: (name) => teams.findByName(name),
};

/** The registry id of the club's team in this match, stream or replay, or null. */
export async function ownTeamOf(ctx: SponsorContext, deps: OwnTeamDeps = live): Promise<string | null> {
  let matchId = ctx.matchId;
  let homeTeam: string | undefined;

  if (!matchId && ctx.streamId) {
    const meta = deps.stream(ctx.streamId);
    matchId = meta?.matchId;
    homeTeam = meta?.homeTeam;
  }
  if (!matchId && ctx.vodId) {
    const vod = await deps.vod(ctx.vodId);
    matchId = vod?.matchId;
    homeTeam = vod?.homeTeam;
  }

  if (matchId) {
    // The summary already follows a merge: by id, and by name when the id is gone.
    const id = (await deps.matchSummary(matchId))?.ownTeam.id;
    if (id) return id;
  }
  if (homeTeam) return (await deps.findTeamByName(homeTeam))?.id ?? null;
  return null;
}

/** Who is shown on a surface for this match, stream or replay: ownTeamOf, then sponsorsFor. */
export async function sponsorsForContext(ctx: SponsorContext, surface: string, deps: OwnTeamDeps = live): Promise<SponsorPick[]> {
  const [teamId, settings] = await Promise.all([ownTeamOf(ctx, deps), sponsors.readAll()]);
  return sponsorsFor(settings, teamId, surface);
}
