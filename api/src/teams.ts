/**
 * Team registry — the club's own teams and the opponents they meet, each with
 * a short name, a colour and optionally a logo (ABL-047).
 *
 * Recordings keep their team names as plain text and are matched to the
 * registry by name, so nothing in the VOD index has to change. Matching
 * ignores case and extra whitespace: "AIK", "Aik" and "aik " are one team.
 * A team that was merged into another, or renamed, keeps answering to its old
 * names, so recordings made under them still find it.
 *
 * Kept in the club's own storage like the club look (club-branding.ts): the
 * list in config/teams.json, each logo in config/teams/<id>.
 */
import crypto from "node:crypto";
import { decodeLogo } from "./club-branding.js";

export const TEAMS_KEY = "config/teams.json";

export function teamLogoKey(id: string): string {
  return `config/teams/${id}`;
}

/** A team as stored. Short name and colour are only stored when the admin chose them. */
export interface TeamRecord {
  id: string;
  name: string;
  shortName?: string;
  color?: string;
  /** Content type of the uploaded logo, or absent when there is none. */
  logoType?: string;
  /** One of the club's own teams (P12, F14 …), rather than an opponent. */
  own?: boolean;
  /** Earlier names: from a rename, or of a team merged into this one. */
  aliases?: string[];
  createdAt: string;
  updatedAt: string;
}

/** A team as the API shows it, with short name and colour always filled in. */
export interface Team {
  id: string;
  name: string;
  shortName: string;
  color: string;
  own: boolean;
  /** Absent when the team has no logo: show the short name on its colour instead. */
  logoUrl?: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamInput {
  name?: string;
  /** Empty string or null: back to the one derived from the name. */
  shortName?: string | null;
  /** Empty string or null: back to the one derived from the name. */
  color?: string | null;
  own?: boolean;
}

interface TeamStorage {
  readFileIfExists(key: string): Promise<string | null>;
  uploadBuffer(key: string, body: Buffer | string, contentType: string): Promise<void>;
  downloadBuffer(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}

/** A refused change, with the message for the admin and the HTTP status to send. */
export class TeamError extends Error {
  constructor(message: string, readonly status: number, readonly teamId?: string) {
    super(message);
  }
}

const MAX_NAME = 60;
const COLOUR = /^#[0-9a-fA-F]{6}$/;
/** Letters and digits, Swedish ones included. No \p{L}: the website's copy targets ES2015. */
const SHORT_NAME = /^[0-9A-ZÀ-ÖØ-Þ]{2,4}$/;
const NOT_ALNUM = /[^0-9A-Za-zÀ-ÖØ-öø-ÿ]/g;

// --- Names ---

/** The name as it is shown: trimmed, with single spaces. */
export function normalizeName(name: string): string {
  return String(name ?? "").trim().replace(/\s+/g, " ");
}

/** What two names must share to be the same team. */
export function teamKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

/** Words that say "club" rather than which club, skipped for the short name. */
const GENERIC_WORDS = new Set([
  "if", "ik", "bk", "bbk", "bc", "bf", "fc", "sk", "ss",
  "basket", "basketball", "basketboll", "basketklubb", "basketbollklubb", "idrottsförening", "idrottsklubb",
]);

/**
 * Three or four letters from the name, like FIBA's "GALA": a short name kept
 * whole ("AIK", "KFUM", "P12"), initials of a long one, otherwise the first
 * three letters of the place ("Solna Vikings" → "SOL"). Age groups and words
 * like "IF" and "Basket" are skipped when there is something else.
 *
 * The club's own teams usually share the club's name and differ only by age
 * group, so for them the age group is the short name ("Hornets P12" → "P12").
 *
 * The website has the same function (web/modules/teams.js), for names that are
 * not in the registry. Change both together.
 */
export function deriveShortName(name: string, own = false): string {
  const words = normalizeName(name)
    .split(/[\s\-–/.,&]+/)
    .map((w) => w.replace(NOT_ALNUM, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  const ageGroup = words.length > 1 ? words.find((w) => /\d/.test(w) && w.length <= 4) : undefined;
  if (own && ageGroup) return ageGroup.toUpperCase();
  const core = words.filter((w) => !GENERIC_WORDS.has(w.toLowerCase()) && !/\d/.test(w));
  const use = core.length > 0 ? core : words;
  const short = use.length >= 3
    ? use.slice(0, 4).map((w) => w[0]).join("")
    : use[0].length <= 4 ? use[0] : use[0].slice(0, 3);
  return short.toUpperCase();
}

// --- Colour ---

type Rgb = [number, number, number];

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

/**
 * A colour of the team's own, from its name, so it is the same every time and
 * on every page. Darkened until white initials on it pass 4.5:1 (WCAG AA).
 * Mirrored in web/modules/teams.js.
 */
export function deriveColor(name: string): string {
  const key = teamKey(name);
  // FNV-1a: cheap, and spreads similar names over different hues.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // FNV's low bits barely mix, and the hue comes from them: stir once more.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  let rgb = hslToRgb((hash >>> 0) % 360, 0.55, 0.42);
  while ((1.05) / (luminance(rgb) + 0.05) < 4.5) rgb = rgb.map((v) => v * 0.9) as Rgb;
  return "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

// --- Registry ---

function present(r: TeamRecord): Team {
  return {
    id: r.id,
    name: r.name,
    shortName: r.shortName || deriveShortName(r.name, r.own === true),
    color: r.color || deriveColor(r.name),
    own: r.own === true,
    // The version in the URL makes browsers fetch a replaced logo at once.
    ...(r.logoType && { logoUrl: `/api/teams/${r.id}/logo?v=${encodeURIComponent(r.updatedAt)}` }),
    aliases: r.aliases ?? [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Own teams first, then by name as a Swede would sort them. */
function byOwnThenName(a: TeamRecord, b: TeamRecord): number {
  if (!!a.own !== !!b.own) return a.own ? -1 : 1;
  return a.name.localeCompare(b.name, "sv");
}

export class TeamRegistry {
  private records: TeamRecord[] | null = null;
  private loading: Promise<TeamRecord[]> | null = null;
  /** Changes run one at a time, so two cameras starting at once both get their team. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: TeamStorage) {}

  /** Every team, own teams first. */
  async list(): Promise<Team[]> {
    return [...(await this.load())].sort(byOwnThenName).map(present);
  }

  async get(id: string): Promise<Team | null> {
    const r = (await this.load()).find((t) => t.id === id);
    return r ? present(r) : null;
  }

  /** The team a name belongs to, by its name or one of its earlier names. */
  async findByName(name: string): Promise<Team | null> {
    const r = this.owner(await this.load(), name);
    return r ? present(r) : null;
  }

  /**
   * The team with this name, created if there is none — how a team typed in
   * the camera app joins the registry. `own` applies only to a new team.
   * Returns null for an empty name.
   */
  async ensure(name: string, opts: { own?: boolean } = {}): Promise<Team | null> {
    if (typeof name !== "string" || !normalizeName(name)) return null;
    // Looked up as it is stored, so a long name finds its team the next time too.
    const stored = normalizeName(name).slice(0, MAX_NAME);
    const found = await this.findByName(stored);
    if (found) return found;
    return this.exclusive(async (records) => {
      // Someone may have added it while this waited its turn.
      const existing = this.owner(records, stored);
      if (existing) return { records, result: present(existing) };
      const team = this.newRecord(stored, opts.own === true);
      return { records: [...records, team], result: present(team) };
    });
  }

  /** Add a team from the admin view. Throws TeamError when the name is taken or a field is wrong. */
  async create(input: TeamInput): Promise<Team> {
    return this.exclusive(async (records) => {
      const name = this.checkName(records, input.name);
      const team = { ...this.newRecord(name, input.own === true), ...this.checkStyle(input) };
      return { records: [...records, team], result: present(team) };
    });
  }

  /** Change name, short name, colour or own. Fields left out stay as they are. */
  async update(id: string, input: TeamInput): Promise<Team> {
    return this.exclusive(async (records) => {
      const current = this.find(records, id);
      const next: TeamRecord = { ...current, updatedAt: new Date().toISOString() };

      if (input.name !== undefined) {
        const name = this.checkName(records, input.name, id);
        if (teamKey(name) !== teamKey(current.name)) {
          // The old name keeps pointing here, for the recordings made under it.
          next.aliases = mergeNames(current.aliases, [current.name], name);
        } else {
          next.aliases = current.aliases;
        }
        next.name = name;
      }
      const style = this.checkStyle(input);
      for (const field of ["shortName", "color"] as const) {
        if (input[field] === undefined) continue;
        if (style[field]) next[field] = style[field];
        else delete next[field];
      }
      if (typeof input.own === "boolean") next.own = input.own;
      if (next.aliases?.length === 0) delete next.aliases;

      return { records: records.map((t) => (t.id === id ? next : t)), result: present(next) };
    });
  }

  /** Remove a team and its logo. Recordings keep the name as text. */
  async remove(id: string): Promise<void> {
    await this.exclusive(async (records) => {
      const team = this.find(records, id);
      if (team.logoType) await this.storage.deleteObject(teamLogoKey(id));
      return { records: records.filter((t) => t.id !== id), result: undefined };
    });
  }

  /** Store a logo sent as a data URL (PNG, JPEG or WebP, at most 1 MB). */
  async setLogo(id: string, dataUrl: string): Promise<Team> {
    return this.exclusive(async (records) => {
      const team = this.find(records, id);
      const logo = decodeLogo(dataUrl);
      if (typeof logo === "string") throw new TeamError(logo, 400);
      await this.storage.uploadBuffer(teamLogoKey(id), logo.bytes, logo.type);
      const next = { ...team, logoType: logo.type, updatedAt: new Date().toISOString() };
      return { records: records.map((t) => (t.id === id ? next : t)), result: present(next) };
    });
  }

  async removeLogo(id: string): Promise<Team> {
    return this.exclusive(async (records) => {
      const { logoType, ...team } = this.find(records, id);
      if (!logoType) return { records, result: present(team) };
      await this.storage.deleteObject(teamLogoKey(id));
      const next = { ...team, updatedAt: new Date().toISOString() };
      return { records: records.map((t) => (t.id === id ? next : t)), result: present(next) };
    });
  }

  /** The uploaded logo, or null when the team has none. */
  async logo(id: string): Promise<{ bytes: Buffer; type: string } | null> {
    const team = (await this.load()).find((t) => t.id === id);
    if (!team?.logoType) return null;
    return { bytes: await this.storage.downloadBuffer(teamLogoKey(id)), type: team.logoType };
  }

  /**
   * Fold a duplicate into the team that stays. The duplicate's names become
   * the kept team's earlier names, so its recordings follow; what the kept
   * team lacks (logo, short name, colour, being one of the club's own) it
   * takes from the duplicate.
   */
  async merge(keepId: string, dropId: string): Promise<Team> {
    if (keepId === dropId) throw new TeamError("Välj två olika lag.", 400);
    return this.exclusive(async (records) => {
      const keep = this.find(records, keepId);
      const drop = this.find(records, dropId);
      const next: TeamRecord = {
        ...keep,
        shortName: keep.shortName || drop.shortName,
        color: keep.color || drop.color,
        own: keep.own || drop.own,
        aliases: mergeNames(keep.aliases, [drop.name, ...(drop.aliases ?? [])], keep.name),
        updatedAt: new Date().toISOString(),
      };
      if (!next.shortName) delete next.shortName;
      if (!next.color) delete next.color;
      if (!next.own) delete next.own;

      if (!keep.logoType && drop.logoType) {
        const bytes = await this.storage.downloadBuffer(teamLogoKey(dropId));
        await this.storage.uploadBuffer(teamLogoKey(keepId), bytes, drop.logoType);
        next.logoType = drop.logoType;
      }
      if (drop.logoType) {
        await this.storage.deleteObject(teamLogoKey(dropId)).catch(() => {
          // A left-over logo file harms nothing; the merge itself must not fail on it.
        });
      }
      const rest = records.filter((t) => t.id !== dropId).map((t) => (t.id === keepId ? next : t));
      return { records: rest, result: present(next) };
    });
  }

  // --- Internals ---

  private async load(): Promise<TeamRecord[]> {
    if (this.records) return this.records;
    this.loading ??= this.storage.readFileIfExists(TEAMS_KEY).then((raw) => {
      const parsed = raw ? (JSON.parse(raw) as { teams?: TeamRecord[] }) : null;
      this.records = parsed?.teams ?? [];
      return this.records;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  /** Run one change against the current list and store the list it returns. */
  private exclusive<T>(change: (records: TeamRecord[]) => Promise<{ records: TeamRecord[]; result: T }>): Promise<T> {
    const run = this.queue.then(async () => {
      const before = await this.load();
      const { records, result } = await change(before);
      if (records !== before) {
        await this.storage.uploadBuffer(TEAMS_KEY, JSON.stringify({ teams: records }, null, 2), "application/json");
        this.records = records;
      }
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private owner(records: TeamRecord[], name: string): TeamRecord | undefined {
    const key = teamKey(name);
    if (!key) return undefined;
    return records.find((t) => teamKey(t.name) === key || t.aliases?.some((a) => teamKey(a) === key));
  }

  private find(records: TeamRecord[], id: string): TeamRecord {
    const team = records.find((t) => t.id === id);
    if (!team) throw new TeamError("Laget finns inte.", 404);
    return team;
  }

  private newRecord(name: string, own: boolean): TeamRecord {
    const now = new Date().toISOString();
    return { id: crypto.randomUUID().slice(0, 8), name, ...(own && { own: true }), createdAt: now, updatedAt: now };
  }

  /** A valid name not used by another team, or a TeamError. */
  private checkName(records: TeamRecord[], raw: unknown, self?: string): string {
    const name = normalizeName(typeof raw === "string" ? raw : "");
    if (!name || name.length > MAX_NAME) throw new TeamError(`Namnet ska vara 1–${MAX_NAME} tecken.`, 400);
    const other = this.owner(records, name);
    if (other && other.id !== self) {
      throw new TeamError(`Det finns redan ett lag som heter ${other.name}.`, 409, other.id);
    }
    return name;
  }

  private checkStyle(input: TeamInput): Pick<TeamRecord, "shortName" | "color"> {
    const out: Pick<TeamRecord, "shortName" | "color"> = {};
    const shortName = typeof input.shortName === "string" ? input.shortName.replace(/\s+/g, "").toUpperCase() : "";
    if (shortName) {
      if (!SHORT_NAME.test(shortName)) throw new TeamError("Kortnamnet ska vara 2–4 bokstäver eller siffror.", 400);
      out.shortName = shortName;
    }
    const color = typeof input.color === "string" ? input.color.trim() : "";
    if (color) {
      if (!COLOUR.test(color)) throw new TeamError("Färgen ska anges som #RRGGBB.", 400);
      out.color = color.toLowerCase();
    }
    return out;
  }
}

/** Earlier names, one per key, without the team's current name. */
function mergeNames(current: string[] | undefined, added: string[], name: string): string[] {
  const out: string[] = [];
  const seen = new Set([teamKey(name)]);
  for (const n of [...(current ?? []), ...added]) {
    const key = teamKey(n);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalizeName(n));
  }
  return out;
}
