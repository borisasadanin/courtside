/**
 * Club manifest — everything that makes an installation *this club's*
 * installation rather than someone else's.
 *
 * This is deliberately separate from config.ts: config.ts holds credentials and
 * infrastructure, this holds identity.  The manifest is served publicly over
 * GET /api/club so the website can theme itself at runtime.  That is what lets
 * one prebuilt website bundle serve any club — no rebuild, no baked-in logo.
 *
 * Sport-specific terminology lives here too, so support for other sports later
 * is a matter of configuration rather than a refactor.
 */

/** Terminology and rules that differ between sports. */
export interface SportProfile {
  /** Identifier, e.g. "basketball", "floorball", "handball". */
  id: string;
  /** What a scheduled break is called, shown to viewers. */
  periodBreakLabel: string;
  /** What an unscheduled break is called, shown to viewers. */
  timeoutLabel: string;
  /** Number of regular periods in a match. */
  periodCount: number;
  /** Length of a highlight clip in seconds. */
  clipDurationSeconds: number;
}

const BASKETBALL: SportProfile = {
  id: "basketball",
  periodBreakLabel: "Periodpaus",
  timeoutLabel: "Timeout",
  periodCount: 4,
  clipDurationSeconds: 8,
};

/** Public club identity — safe to expose to any viewer. */
export interface ClubManifest {
  /** Display name of the service, e.g. "Hammarby Courtside". */
  name: string;
  /** Club name used as the default home team, e.g. "Hammarby IF". */
  shortName: string;
  /** Default venue for new recordings, e.g. "Hammarbyhallen". */
  venue: string;
  /** Accent colour as a CSS colour, applied as a custom property. */
  accentColor: string;
  /** Logo URL, or empty to use the one shipped with the website build.
   *  Relative paths resolve against the website origin. */
  logoUrl: string;
  /** Public website origin, used for share links and social previews. */
  siteUrl: string;
  /** One-line description used for social previews. */
  tagline: string;
  /** Sport terminology and rules. */
  sport: SportProfile;
  /** Who answers for the recordings, shown under "Om inspelningarna". */
  privacy: ClubPrivacy;
}

/**
 * The club is responsible for what it records, and viewers must be told who
 * that is and how to reach them.  Set in the admin view; empty until then, and
 * the website falls back to the club's name.
 */
export interface ClubPrivacy {
  /** The association responsible, e.g. "Hammarby IF Basketförening". */
  controller: string;
  /** Where to ask about or object to a recording. */
  contact: string;
  /** The club's own privacy policy, if it has one. */
  policyUrl: string;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/**
 * Normalise a CSS colour.  Accepts "C8A43F" as well as "#C8A43F", because in a
 * .env file an unquoted "#" starts a comment and silently eats the value — a
 * trap every club would otherwise fall into exactly once.
 */
function colour(name: string, fallback: string): string {
  const raw = (process.env[name] || "").trim();
  if (!raw) return fallback;
  return /^[0-9a-fA-F]{3,8}$/.test(raw) ? `#${raw}` : raw;
}

const NAME = optional("CLUB_NAME", "Courtside");
const SHORT_NAME = optional("CLUB_SHORT_NAME", NAME);

export const clubManifest: ClubManifest = {
  name: NAME,
  shortName: SHORT_NAME,
  venue: optional("CLUB_VENUE", ""),
  accentColor: colour("CLUB_ACCENT_COLOR", "#C8A43F"),
  logoUrl: optional("CLUB_LOGO_URL", ""),
  siteUrl: optional("PUBLIC_SITE_URL", "").replace(/\/$/, ""),
  tagline: optional("CLUB_TAGLINE", `Följ ${NAME} live — direkt från hallen.`),
  sport: BASKETBALL,
  privacy: { controller: "", contact: "", policyUrl: "" },
};

/** Default team name for a new recording when the camera sends none. */
export const defaultHomeTeam = SHORT_NAME;

/** Placeholder opponent name when the camera sends none. */
export const defaultAwayTeam = optional("CLUB_DEFAULT_OPPONENT", "Motståndare");

/**
 * Absolute URL for the club logo, for use in social previews where relative
 * paths are not allowed.  Returns null when no public site URL is configured.
 */
export function absoluteLogoUrl(): string | null {
  const { logoUrl, siteUrl } = clubManifest;
  if (/^https?:\/\//.test(logoUrl)) return logoUrl;
  if (!siteUrl) return null;
  return `${siteUrl}${logoUrl.startsWith("/") ? "" : "/"}${logoUrl}`;
}
