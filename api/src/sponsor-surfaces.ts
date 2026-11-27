/**
 * Sponsor surfaces (#121, #123): every place in Courtside a sponsor can be
 * shown, and the one function that decides who is shown there (#125).
 *
 * A surface is defined here, in code: what it shows (a clip or a logo),
 * whether it is exclusive (one sponsor per team at most) and whether its
 * phase has been released. Which surfaces the club has switched on, which
 * package gives which surfaces and which sponsor has which package are data,
 * in config/sponsors.json (sponsors.ts).
 *
 * Pure and synchronous: no storage, no requests. The caller hands in a
 * snapshot of the settings and the team, so the share image, the player and
 * the report all get the same answer.
 */
import type { Sponsor, SponsorClip, SponsorSettings } from "./sponsors.js";

export type SurfaceKind = "clip" | "logo";

export interface SurfaceDef {
  id: string;
  kind: SurfaceKind;
  /** At most one sponsor per team (and one for the whole club) may have it. */
  exclusive: boolean;
  /** Its phase is released. A surface that is not cannot be switched on or shown. */
  available: boolean;
  /** What the admin sees. */
  label: string;
  /** How a conflict names the one who has it: "P12 har redan huvudsponsor: X". */
  holder: string;
}

/**
 * Every surface, in the order the admin sees them. Timeouts and the
 * scoreboard have none (decided 2026-11-26, see #121).
 */
export const SURFACES = [
  { id: "start", kind: "clip", exclusive: false, available: true, label: "Klipp vid start", holder: "sponsor vid start" },
  { id: "p1", kind: "clip", exclusive: false, available: true, label: "Klipp i paus 1", holder: "sponsor i paus 1" },
  { id: "p2", kind: "clip", exclusive: false, available: true, label: "Klipp i paus 2", holder: "sponsor i paus 2" },
  { id: "p3", kind: "clip", exclusive: false, available: true, label: "Klipp i paus 3", holder: "sponsor i paus 3" },
  { id: "ot", kind: "clip", exclusive: false, available: true, label: "Klipp vid övertid", holder: "sponsor vid övertid" },
  { id: "end", kind: "clip", exclusive: false, available: true, label: "Klipp vid avslut", holder: "sponsor vid avslut" },
  { id: "corner", kind: "logo", exclusive: true, available: false, label: "Hörnlogga", holder: "huvudsponsor" },
  { id: "waiting", kind: "logo", exclusive: false, available: false, label: "Väntskärmen", holder: "sponsor på väntskärmen" },
  { id: "match-card", kind: "logo", exclusive: true, available: false, label: "Matchkortet", holder: "sponsor på matchkortet" },
  { id: "club-footer", kind: "logo", exclusive: false, available: false, label: "Klubbsidans sidfot", holder: "sponsor i sidfoten" },
  { id: "share-image", kind: "logo", exclusive: true, available: false, label: "Delningsbilden", holder: "sponsor på delningsbilden" },
  { id: "shared-clip", kind: "logo", exclusive: true, available: false, label: "Delade klipp", holder: "sponsor på delade klipp" },
  { id: "mvp", kind: "logo", exclusive: true, available: false, label: "Matchens MVP", holder: "sponsor för MVP" },
  { id: "notification", kind: "logo", exclusive: true, available: false, label: "Avisering om matchstart", holder: "sponsor på aviseringen" },
] as const satisfies readonly SurfaceDef[];

export type SurfaceId = (typeof SURFACES)[number]["id"];

export const SURFACE_IDS: readonly SurfaceId[] = SURFACES.map((s) => s.id);

/** The clip surfaces, in the order a match goes. They are #87's slots. */
export const CLIP_SURFACES = SURFACES.filter((s) => s.kind === "clip").map((s) => s.id) as ("start" | "p1" | "p2" | "p3" | "ot" | "end")[];

export function surfaceDef(id: string): SurfaceDef | undefined {
  return (SURFACES as readonly SurfaceDef[]).find((s) => s.id === id);
}

export function isSurfaceId(id: unknown): id is SurfaceId {
  return typeof id === "string" && SURFACE_IDS.includes(id as SurfaceId);
}

/** A sponsor chosen for a surface, with its clips there when it is a clip surface. */
export interface SponsorPick {
  sponsor: Sponsor;
  /** Ready clips that have the surface in their slots, in play order. Empty for logos. */
  clips: SponsorClip[];
}

/** Does this sponsor apply to the team? Null team: only the club's sponsors. */
function appliesTo(sponsor: Sponsor, teamId: string | null): "team" | "club" | null {
  if (sponsor.teamsGone) return null;
  if (sponsor.teamIds.length === 0) return "club";
  return teamId && sponsor.teamIds.includes(teamId) ? "team" : null;
}

/** The surfaces a sponsor's package gives, minus the ones switched off for it. */
function claims(s: SponsorSettings, sponsor: Sponsor, surface: string): boolean {
  const pkg = s.packages.find((p) => p.id === sponsor.packageId);
  return Boolean(pkg?.surfaces.includes(surface as SurfaceId)) && !sponsor.off.includes(surface as SurfaceId);
}

/**
 * Who is shown on one surface for one team. A sponsor is shown when:
 *
 *   1. the surface is released and switched on for the installation,
 *   2. its package has the surface,
 *   3. it has not had the surface switched off,
 *   4. it is active,
 *   5. it is the whole club's, or the team's,
 *   6. for a clip surface: it has a ready clip with the surface in its slots.
 *
 * The team's sponsors come before the club's, then by package priority, then
 * in the admin's order. An exclusive surface gives one sponsor at most.
 */
export function sponsorsFor(s: SponsorSettings, teamId: string | null, surface: string): SponsorPick[] {
  const def = surfaceDef(surface);
  if (!def || !def.available || !s.surfaces[def.id as SurfaceId]) return [];

  const priority = new Map(s.packages.map((p) => [p.id, p.priority]));
  const picks: (SponsorPick & { scope: "team" | "club"; order: number })[] = [];
  s.sponsors.forEach((sponsor, order) => {
    if (!sponsor.active || !claims(s, sponsor, def.id)) return;
    const scope = appliesTo(sponsor, teamId);
    if (!scope) return;
    const clips = def.kind === "clip"
      ? s.clips.filter((c) => c.sponsorId === sponsor.id && c.status === "ready" && c.slots.includes(def.id as never))
      : [];
    if (def.kind === "clip" && clips.length === 0) return;
    picks.push({ sponsor, clips, scope, order });
  });

  picks.sort((a, b) =>
    (a.scope === b.scope ? 0 : a.scope === "team" ? -1 : 1) ||
    (priority.get(a.sponsor.packageId) ?? Infinity) - (priority.get(b.sponsor.packageId) ?? Infinity) ||
    a.order - b.order,
  );
  const out = picks.map(({ sponsor, clips }) => ({ sponsor, clips }));
  return def.exclusive ? out.slice(0, 1) : out;
}

/** Two or more active sponsors that have the same exclusive surface for the same team, or for the club. */
export interface SurfaceConflict {
  surface: SurfaceId;
  /** The team, or null for the whole club. */
  teamId: string | null;
  sponsorIds: string[];
}

/**
 * Every conflict on an exclusive surface. A team's sponsor goes before the
 * club's, so a team sponsor and a club sponsor with the same surface are not
 * a conflict; two club sponsors, or two of the same team, are. Inactive
 * sponsors hold nothing. Surfaces of later phases count too, so the data is
 * clean when they are released.
 */
export function exclusiveConflicts(s: SponsorSettings): SurfaceConflict[] {
  const out: SurfaceConflict[] = [];
  for (const def of SURFACES as readonly SurfaceDef[]) {
    if (!def.exclusive) continue;
    const byScope = new Map<string | null, string[]>();
    for (const sponsor of s.sponsors) {
      if (!sponsor.active || sponsor.teamsGone || !claims(s, sponsor, def.id)) continue;
      const scopes = sponsor.teamIds.length === 0 ? [null] : sponsor.teamIds;
      for (const scope of scopes) byScope.set(scope, [...(byScope.get(scope) ?? []), sponsor.id]);
    }
    for (const [teamId, sponsorIds] of byScope) {
      if (sponsorIds.length > 1) out.push({ surface: def.id as SurfaceId, teamId, sponsorIds });
    }
  }
  return out;
}
