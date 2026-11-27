/**
 * Sponsors and their clips (#87, #121).
 *
 * A sponsor is a company the club has sold sponsorship to: a name, a link, a
 * logo, a package (Platinum, Guld, Silver …) that gives it a set of surfaces
 * (sponsor-surfaces.ts), and the club's teams it applies to, or the whole
 * club. Its clips are short films played to viewers when the match starts,
 * in period breaks, in overtime and when it ends.
 *
 * The clips are played in the viewer's own player, never mixed into the HLS
 * stream (Restreamer copies the camera's codec, so a clip would have to match
 * the camera exactly).
 *
 * Stored in the club's own storage like the teams (teams.ts):
 *
 *   config/sponsors.json            sponsors, packages, surfaces, the clips in play order, the break lengths
 *   config/sponsor-logos/<id>       a sponsor's logo, PNG, 512 px at most (#128)
 *   sponsors/<id>/original          a clip as uploaded, deleted once transcoded
 *   sponsors/<id>/index.m3u8        HLS, 1080p30 at most
 *   sponsors/<id>/seg_00000.ts …
 *   sponsors/<id>/thumb.jpg         a frame for the admin list
 *
 * The logos are not under sponsors/<id>/: a clip is deleted with everything
 * under its prefix, and a migrated sponsor has the id of its first clip.
 *
 * The file is version 2 (#123). v0.8.1 reads only `clips` and `breakSeconds`,
 * so those keep their shape and a rollback still plays the same clips. A
 * version 1 file is migrated in memory when read, and nothing is written
 * until the admin changes something.
 */
import crypto from "node:crypto";
import type { RecordedPause } from "./types.js";
import { decodeLogo } from "./club-branding.js";
import {
  CLIP_SURFACES,
  SURFACES,
  exclusiveConflicts,
  isSurfaceId,
  sponsorsFor,
  surfaceDef,
  type SurfaceConflict,
  type SurfaceId,
} from "./sponsor-surfaces.js";

export const SPONSORS_KEY = "config/sponsors.json";

/** Largest file the admin may upload. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Where in a match a clip can be shown: the clip surfaces (sponsor-surfaces.ts).
 * The order here is the order of the admin's columns.
 */
export const SPONSOR_SLOTS = CLIP_SURFACES;
export type SponsorSlot = (typeof CLIP_SURFACES)[number];

/** The slots that are breaks, and so have a length the clips should fit into. */
export const BREAK_SLOTS = SPONSOR_SLOTS.filter((s) => s !== "start" && s !== "end") as ("p1" | "p2" | "p3" | "ot")[];
export type BreakSlot = (typeof BREAK_SLOTS)[number];

/** Break lengths in seconds until the admin changes them. */
export const DEFAULT_BREAK_SECONDS: Record<BreakSlot, number> = {
  p1: 120,
  p2: 900,
  p3: 120,
  ot: 120,
};

/** A break can be set to anything from a second to an hour (#94). */
const MAX_BREAK_SECONDS = 3600;
const MAX_NAME = 80;
/** How long the presigned PUT link is valid (#89). */
export const UPLOAD_LINK_SECONDS = 15 * 60;
/**
 * An upload still unconfirmed after this long has been abandoned. Storage
 * checks the link when the PUT starts, so a slow upload begun in time may
 * run well past the link's 15 minutes.
 */
const ABANDONED_UPLOAD_MS = 3 * 60 * 60 * 1000;

/**
 * uploading:  the admin has a PUT link and the file is on its way
 * queued:     uploaded and checked, waiting for its turn to be transcoded
 * processing: being transcoded
 * ready:      can be played
 * failed:     something went wrong; `error` says what, and the admin uploads again
 */
export type SponsorClipStatus = "uploading" | "queued" | "processing" | "ready" | "failed";

export interface SponsorClip {
  id: string;
  name: string;
  /** The sponsor it belongs to. Missing in a v0.8 file; added when it is read (#123). */
  sponsorId: string;
  status: SponsorClipStatus;
  /** Shown to the admin when status is "failed". */
  error?: string;
  /** The slots it is shown in. Kept in SPONSOR_SLOTS order. */
  slots: SponsorSlot[];
  /** Size of the uploaded original. */
  sizeBytes?: number;
  /** Length once transcoded. */
  durationSeconds?: number;
  /** Content type the browser gave the original, for ffmpeg's benefit only. */
  contentType?: string;
  createdAt: string;
  updatedAt: string;
}

/** A company the club has sold sponsorship to (#123). */
export interface Sponsor {
  id: string;
  name: string;
  /** The sponsor's own website, http or https only. */
  url?: string;
  packageId: string;
  /** The club's own teams it applies to. Empty: the whole club. */
  teamIds: string[];
  /**
   * Every team it applied to has been removed (#127). It is then shown
   * nowhere, rather than quietly becoming the whole club's, until the admin
   * chooses again.
   */
  teamsGone?: boolean;
  /** Surfaces of its package it is not shown on. */
  off: SurfaceId[];
  active: boolean;
  /** Content type of the logo, or absent when there is none (#128). */
  logoType?: string;
  createdAt: string;
  updatedAt: string;
}

/** A level of sponsorship: a name, a priority (lower first) and the surfaces it gives. */
export interface SponsorPackage {
  id: string;
  name: string;
  priority: number;
  surfaces: SurfaceId[];
}

/** config/sponsors.json, version 2. */
export interface SponsorSettings {
  version: 2;
  /** Every clip, in the order they are played: grouped by sponsor, in the sponsors' order. */
  clips: SponsorClip[];
  breakSeconds: Record<BreakSlot, number>;
  /** In the admin's order. */
  sponsors: Sponsor[];
  packages: SponsorPackage[];
  /** Which surfaces are switched on for the installation. */
  surfaces: Record<SurfaceId, boolean>;
  /** YYYY-MM-DD: where the season's report starts counting (#138). Absent until the admin sets it. */
  seasonStart?: string;
}

/** The gold package's id: where migrated clips and sponsors made for a bare upload go. */
export const GOLD = "gold";

/** The packages every installation starts with (#121). Platinum gets every surface. */
export const DEFAULT_PACKAGES: SponsorPackage[] = [
  { id: "platinum", name: "Platinum", priority: 1, surfaces: SURFACES.map((s) => s.id) },
  { id: GOLD, name: "Guld", priority: 2, surfaces: [...CLIP_SURFACES, "waiting", "club-footer"] },
  { id: "silver", name: "Silver", priority: 3, surfaces: ["club-footer"] },
];

/** Every surface is off until the club switches it on, except the clips that were already playing in v0.8. */
function defaultSurfaces(): Record<SurfaceId, boolean> {
  return Object.fromEntries(SURFACES.map((s) => [s.id, s.kind === "clip"])) as Record<SurfaceId, boolean>;
}

export function sponsorLogoKey(id: string): string {
  return `config/sponsor-logos/${id}`;
}

export function originalKey(id: string): string {
  return `sponsors/${id}/original`;
}

export function sponsorPrefix(id: string): string {
  return `sponsors/${id}/`;
}

export function sponsorManifestKey(id: string): string {
  return `sponsors/${id}/index.m3u8`;
}

export function sponsorThumbKey(id: string): string {
  return `sponsors/${id}/thumb.jpg`;
}

interface SponsorStorage {
  readFileIfExists(key: string): Promise<string | null>;
  uploadBuffer(key: string, body: Buffer | string, contentType: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  downloadBuffer(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}

/** The team registry as the sponsors need it: to check that a team is one of the club's own, and to name it. */
interface SponsorTeams {
  get(id: string): Promise<{ id: string; name: string; own: boolean } | null>;
}

interface RegistryOptions {
  teams?: SponsorTeams;
  /** Scales a logo down to PNG, 512 px at most (#128). */
  scaleLogo?: (bytes: Buffer) => Promise<Buffer>;
}

/** What the admin may change about a sponsor. Fields left out stay as they are. */
export interface SponsorInput {
  name?: unknown;
  /** Empty string or null: no link. */
  url?: unknown;
  packageId?: unknown;
  teamIds?: unknown;
  off?: unknown;
  active?: unknown;
}

/** A refused change, with the message for the admin and the HTTP status to send. */
export class SponsorError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * The slots in play order for a period break, counted among period breaks
 * only: the first is p1, the second p2, the third p3, and every one after
 * that ot (overtime). Timeouts never get a slot.
 */
export function slotForPeriodBreak(n: number): BreakSlot | null {
  if (!Number.isInteger(n) || n < 1) return null;
  if (n === 1) return "p1";
  if (n === 2) return "p2";
  if (n === 3) return "p3";
  return "ot";
}

/**
 * Which period break the latest pause is, counting period breaks only (#95).
 * `meta.pauses` numbers timeouts and period breaks together, so the third
 * pause of a match may well be its first period break.
 */
export function periodBreakNumber(pauses: RecordedPause[] | undefined): number {
  return (pauses ?? []).filter((p) => p.type === "period").length;
}


/** A file as some version of Courtside wrote it: v0.8 (no version) or v2. */
type RawSettings = Partial<Omit<SponsorSettings, "version" | "clips" | "surfaces">> & {
  version?: number;
  clips?: (Omit<SponsorClip, "sponsorId"> & { sponsorId?: string })[];
  surfaces?: Partial<Record<string, unknown>>;
};

/**
 * Version 2 from whatever was read (#123). A clip without a sponsor gets one
 * of its own, with the clip's id and name, in Guld, for the whole club: a
 * v0.8 clip, or one added by v0.8.1 after a rollback. So does a clip whose
 * sponsor is missing, which a v0.8.1 write leaves behind, since it keeps only
 * `clips` and `breakSeconds`. The ids come from the file alone, so every
 * read gives the same sponsors.
 */
export function migrate(raw: RawSettings): SponsorSettings {
  const packages = (raw.packages ?? []).map((p) => ({ ...p, surfaces: [...(p.surfaces ?? [])] }));
  for (const p of DEFAULT_PACKAGES) {
    if (!packages.some((x) => x.id === p.id)) packages.push({ ...p, surfaces: [...p.surfaces] });
  }

  const sponsors: Sponsor[] = (raw.sponsors ?? []).map((x) => ({
    ...x,
    teamIds: [...(x.teamIds ?? [])],
    off: [...(x.off ?? [])],
    active: x.active !== false,
  }));
  const known = new Set(sponsors.map((x) => x.id));
  const clips: SponsorClip[] = (raw.clips ?? []).map((c) => {
    const sponsorId = c.sponsorId ?? c.id;
    if (!known.has(sponsorId)) {
      known.add(sponsorId);
      sponsors.push({
        id: sponsorId,
        name: c.name,
        packageId: GOLD,
        teamIds: [],
        off: [],
        active: true,
        createdAt: c.createdAt,
        updatedAt: c.createdAt,
      });
    }
    return { ...c, sponsorId, slots: [...(c.slots ?? [])] };
  });

  const surfaces = defaultSurfaces();
  for (const def of SURFACES) {
    const on = raw.surfaces?.[def.id];
    if (typeof on === "boolean") surfaces[def.id] = on;
  }

  return {
    version: 2,
    clips,
    breakSeconds: { ...DEFAULT_BREAK_SECONDS, ...(raw.breakSeconds ?? {}) },
    sponsors,
    packages,
    surfaces,
    ...(typeof raw.seasonStart === "string" && { seasonStart: raw.seasonStart }),
  };
}

/**
 * The clips grouped by sponsor, in the sponsors' order, each sponsor's in the
 * order they had. Stored like that, v0.8.1 plays them in the same order
 * after a rollback as this version does.
 */
function grouped(s: SponsorSettings): SponsorSettings {
  const index = new Map(s.sponsors.map((x, i) => [x.id, i]));
  const at = (c: SponsorClip) => index.get(c.sponsorId) ?? s.sponsors.length;
  const clips = s.clips.map((c, i) => ({ c, i })).sort((a, b) => at(a.c) - at(b.c) || a.i - b.i).map((x) => x.c);
  return { ...s, clips };
}

/** Conflicts in `after` that `before` did not have: a new one, or a sponsor added to one. */
function newConflicts(before: SponsorSettings, after: SponsorSettings): SurfaceConflict[] {
  const key = (c: SurfaceConflict) => `${c.surface}|${c.teamId ?? ""}`;
  const old = new Map(exclusiveConflicts(before, { onlyAvailable: true }).map((c) => [key(c), new Set(c.sponsorIds)]));
  return exclusiveConflicts(after, { onlyAvailable: true }).filter((c) => {
    const had = old.get(key(c));
    return !had || c.sponsorIds.some((id) => !had.has(id));
  });
}

const MAX_URL = 300;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

interface ChangeOptions {
  /** The sponsor being changed, so a conflict names the other one. */
  subject?: string;
  /**
   * Skip the check for new conflicts. Only for following a change made
   * elsewhere (a team merged), which cannot be refused any more: the
   * surfaces still show one sponsor, the first in order.
   */
  allowConflicts?: boolean;
}

export class SponsorRegistry {
  private settings: SponsorSettings | null = null;
  private loading: Promise<SponsorSettings> | null = null;
  /** Changes run one at a time: the transcoder and the admin both write the list. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly teams?: SponsorTeams;
  private readonly scaleLogo: (bytes: Buffer) => Promise<Buffer>;

  constructor(private readonly storage: SponsorStorage, options: RegistryOptions = {}) {
    this.teams = options.teams;
    this.scaleLogo = options.scaleLogo ?? (async () => {
      throw new SponsorError("Loggan kan inte bearbetas här.", 500);
    });
  }

  /** Read the file now, at start-up, so snapshot() has something to give (#123). */
  async ready(): Promise<void> {
    await this.load();
  }

  /**
   * The settings as they are, without waiting: for code that cannot be async,
   * like drawing the share image. Before ready() it is an empty registry.
   */
  snapshot(): SponsorSettings {
    return structuredClone(this.settings ?? migrate({}));
  }

  /** Every clip in play order, and the break lengths: what v0.8 had. */
  async read(): Promise<{ clips: SponsorClip[]; breakSeconds: Record<BreakSlot, number> }> {
    const s = await this.load();
    return { clips: s.clips.map((c) => ({ ...c, slots: [...c.slots] })), breakSeconds: { ...s.breakSeconds } };
  }

  /** Everything: sponsors, packages, surfaces, clips, break lengths and season start. */
  async readAll(): Promise<SponsorSettings> {
    return structuredClone(await this.load());
  }

  async get(id: string): Promise<SponsorClip | null> {
    const c = (await this.load()).clips.find((x) => x.id === id);
    return c ? { ...c, slots: [...c.slots] } : null;
  }

  async getSponsor(id: string): Promise<Sponsor | null> {
    const x = (await this.load()).sponsors.find((y) => y.id === id);
    return x ? structuredClone(x) : null;
  }

  /**
   * For the viewers: the ready clips of each slot, in play order, for a team
   * (null: the club's sponsors only). Decided by sponsorsFor, like every other
   * surface. A slot with no clips is left out, so the player can tell
   * "nothing to show" at a glance.
   */
  async playlist(teamId: string | null = null): Promise<Partial<Record<SponsorSlot, SponsorClip[]>>> {
    const s = await this.load();
    const out: Partial<Record<SponsorSlot, SponsorClip[]>> = {};
    for (const slot of SPONSOR_SLOTS) {
      const clips = sponsorsFor(s, teamId, slot).flatMap((p) => p.clips);
      if (clips.length > 0) out[slot] = clips;
    }
    return out;
  }

  /**
   * A new clip waiting for its upload, last of its sponsor's, in no slot yet.
   * Without a sponsor (an upload from v0.8's page) it gets one of its own,
   * named after the clip, like a migrated clip (#129).
   */
  async create(name: unknown, sizeBytes: unknown, contentType: unknown, sponsorId?: unknown): Promise<SponsorClip> {
    const size = Number(sizeBytes);
    if (!Number.isFinite(size) || size <= 0) throw new SponsorError("Filen är tom.", 400);
    if (size > MAX_UPLOAD_BYTES) throw new SponsorError("Filen får vara högst 200 MB.", 413);
    const type = typeof contentType === "string" ? contentType.trim() : "";
    if (type && !/^video\//i.test(type)) throw new SponsorError("Filen måste vara en video.", 415);
    const clipName = checkName(name);

    return this.exclusive(async (s) => {
      const now = new Date().toISOString();
      const id = newId();
      let sponsors = s.sponsors;
      let owner: string;
      if (sponsorId === undefined || sponsorId === null || sponsorId === "") {
        owner = id;
        sponsors = [...sponsors, newSponsor(id, clipName, GOLD, now)];
      } else {
        owner = findSponsor(s, sponsorId).id;
      }
      const clip: SponsorClip = {
        id,
        name: clipName,
        sponsorId: owner,
        status: "uploading",
        slots: [],
        sizeBytes: size,
        ...(type && { contentType: type }),
        createdAt: now,
        updatedAt: now,
      };
      return { settings: { ...s, sponsors, clips: [...s.clips, clip] }, result: clip };
    });
  }

  /** Change one clip's fields. Throws SponsorError when it does not exist. */
  async patch(id: string, change: Partial<Omit<SponsorClip, "id" | "createdAt" | "sponsorId">>): Promise<SponsorClip> {
    return this.exclusive(async (s) => {
      const current = find(s, id);
      const next: SponsorClip = { ...current, ...change, updatedAt: new Date().toISOString() };
      if (next.status !== "failed") delete next.error;
      return { settings: { ...s, clips: s.clips.map((c) => (c.id === id ? next : c)) }, result: next };
    });
  }

  async rename(id: string, name: unknown): Promise<SponsorClip> {
    return this.patch(id, { name: checkName(name) });
  }

  /** Remove a clip and every file it has. Its sponsor stays. Returns false when there was none. */
  async remove(id: string): Promise<boolean> {
    const removed = await this.exclusive(async (s) => {
      if (!s.clips.some((c) => c.id === id)) return { settings: s, result: false };
      return { settings: { ...s, clips: s.clips.filter((c) => c.id !== id) }, result: true };
    });
    if (removed) await this.storage.deletePrefix(sponsorPrefix(id));
    return removed;
  }

  /**
   * New play order of the clips. Must name every clip exactly once.
   *
   * The clips are played sponsor by sponsor, so this also orders the
   * sponsors that have clips, by their first clip; sponsors without clips
   * keep their places. Within a sponsor, its clips get the order given.
   */
  async reorder(ids: unknown): Promise<{ clips: SponsorClip[] }> {
    return this.exclusive(async (s) => {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
        throw new SponsorError("Ordningen ska vara en lista med klipp.", 400);
      }
      const unique = new Set(ids as string[]);
      const known = new Set(s.clips.map((c) => c.id));
      if (unique.size !== ids.length || unique.size !== known.size || [...unique].some((id) => !known.has(id))) {
        throw new SponsorError("Ordningen måste innehålla varje klipp en gång.", 409);
      }
      const byId = new Map(s.clips.map((c) => [c.id, c]));
      const clips = (ids as string[]).map((id) => byId.get(id)!);

      const withClips = [...new Set(clips.map((c) => c.sponsorId))];
      const queue = withClips.map((id) => s.sponsors.find((x) => x.id === id)).filter((x): x is Sponsor => Boolean(x));
      const holders = new Set(queue.map((x) => x.id));
      const sponsors = s.sponsors.map((x) => (holders.has(x.id) ? queue.shift()! : x));

      const next = { ...s, sponsors, clips };
      return { settings: next, result: { clips: grouped(next).clips } };
    });
  }

  /** The slots one clip is shown in. Unknown slots are refused. */
  async setSlots(id: string, slots: unknown): Promise<SponsorClip> {
    if (!Array.isArray(slots) || slots.some((x) => !SPONSOR_SLOTS.includes(x as SponsorSlot))) {
      throw new SponsorError("Okänd sponsoryta.", 400);
    }
    const chosen = SPONSOR_SLOTS.filter((slot) => slots.includes(slot));
    return this.patch(id, { slots: chosen });
  }

  /** Change one or more break lengths. Breaks left out stay as they are. */
  async setBreakSeconds(input: unknown): Promise<Record<BreakSlot, number>> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new SponsorError("Pauslängderna saknas.", 400);
    }
    const entries = Object.entries(input as Record<string, unknown>);
    for (const [slot, value] of entries) {
      if (!BREAK_SLOTS.includes(slot as BreakSlot)) throw new SponsorError("Okänd paus.", 400);
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_BREAK_SECONDS) {
        throw new SponsorError("Pauslängden ska vara 1 sekund till 60 minuter, i hela sekunder.", 400);
      }
    }
    return this.exclusive(async (s) => {
      const breakSeconds = { ...s.breakSeconds, ...(Object.fromEntries(entries) as Record<BreakSlot, number>) };
      return { settings: { ...s, breakSeconds }, result: { ...breakSeconds } };
    });
  }

  // --- Sponsors (#126) ---

  /** A new sponsor, last in the order. Guld and the whole club unless the admin chose otherwise. */
  async createSponsor(input: SponsorInput): Promise<Sponsor> {
    const id = newId();
    return this.exclusive(async (s) => {
      const now = new Date().toISOString();
      const fields = await this.checkInput(s, { packageId: GOLD, ...input, name: input.name ?? "" });
      const sponsor: Sponsor = { ...newSponsor(id, "", GOLD, now), ...fields };
      if (!sponsor.url) delete sponsor.url;
      return { settings: { ...s, sponsors: [...s.sponsors, sponsor] }, result: structuredClone(sponsor) };
    }, { subject: id });
  }

  /** Change a sponsor's name, link, package, teams, surfaces switched off, or whether it is active. */
  async patchSponsor(id: string, input: SponsorInput): Promise<Sponsor> {
    return this.exclusive(async (s) => {
      const current = findSponsor(s, id);
      const fields = await this.checkInput(s, input);
      if (Object.keys(fields).length === 0) throw new SponsorError("Inget att ändra.", 400);
      const next: Sponsor = { ...current, ...fields, updatedAt: new Date().toISOString() };
      if (!next.url) delete next.url;
      if (fields.teamIds) delete next.teamsGone;
      return { settings: { ...s, sponsors: s.sponsors.map((x) => (x.id === id ? next : x)) }, result: structuredClone(next) };
    }, { subject: id });
  }

  /** Remove a sponsor and its logo. Refused while it has clips: they would have no one to play for. */
  async removeSponsor(id: string): Promise<void> {
    const removed = await this.exclusive(async (s) => {
      const sponsor = findSponsor(s, id);
      const clips = s.clips.filter((c) => c.sponsorId === id).length;
      if (clips > 0) {
        throw new SponsorError(
          `${sponsor.name} har ${clips === 1 ? "ett klipp" : `${clips} klipp`}. Ta bort eller flytta ${clips === 1 ? "det" : "dem"} först.`,
          409,
        );
      }
      return { settings: { ...s, sponsors: s.sponsors.filter((x) => x.id !== id) }, result: sponsor };
    });
    if (removed.logoType) await this.storage.deleteObject(sponsorLogoKey(id)).catch(() => {});
  }

  /** New order of the sponsors. Must name every sponsor exactly once. Their clips follow. */
  async reorderSponsors(ids: unknown): Promise<Sponsor[]> {
    return this.exclusive(async (s) => {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
        throw new SponsorError("Ordningen ska vara en lista med sponsorer.", 400);
      }
      const unique = new Set(ids as string[]);
      const byId = new Map(s.sponsors.map((x) => [x.id, x]));
      if (unique.size !== ids.length || unique.size !== byId.size || [...unique].some((id) => !byId.has(id))) {
        throw new SponsorError("Ordningen måste innehålla varje sponsor en gång.", 409);
      }
      const sponsors = (ids as string[]).map((id) => byId.get(id)!);
      return { settings: { ...s, sponsors }, result: structuredClone(sponsors) };
    });
  }

  /** Switch surfaces on or off for the installation. A surface of a later phase cannot be switched on. */
  async setSurfaces(input: unknown): Promise<Record<SurfaceId, boolean>> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new SponsorError("Ytorna saknas.", 400);
    }
    const entries = Object.entries(input as Record<string, unknown>);
    for (const [id, on] of entries) {
      const def = surfaceDef(id);
      if (!def) throw new SponsorError("Okänd sponsoryta.", 400);
      if (typeof on !== "boolean") throw new SponsorError("Ange på eller av.", 400);
      if (on && !def.available) throw new SponsorError(`${def.label} finns inte än.`, 400);
    }
    return this.exclusive(async (s) => {
      const surfaces = { ...s.surfaces, ...(Object.fromEntries(entries) as Record<SurfaceId, boolean>) };
      return { settings: { ...s, surfaces }, result: { ...surfaces } };
    });
  }

  /** Move a clip to another sponsor, last among that sponsor's clips. */
  async setClipSponsor(clipId: string, sponsorId: unknown): Promise<SponsorClip> {
    return this.exclusive(async (s) => {
      const clip = find(s, clipId);
      const sponsor = findSponsor(s, sponsorId);
      if (clip.sponsorId === sponsor.id) return { settings: s, result: { ...clip } };
      const next = { ...clip, sponsorId: sponsor.id, updatedAt: new Date().toISOString() };
      const clips = [...s.clips.filter((c) => c.id !== clipId), next];
      return { settings: { ...s, clips }, result: { ...next } };
    });
  }

  /** Where the season's report starts (#138): YYYY-MM-DD, or null for none. */
  async setSeasonStart(date: unknown): Promise<string | null> {
    if (date !== null && (typeof date !== "string" || !DATE.test(date) || Number.isNaN(Date.parse(date)))) {
      throw new SponsorError("Datumet ska skrivas ÅÅÅÅ-MM-DD.", 400);
    }
    return this.exclusive(async (s) => {
      const { seasonStart: _old, ...rest } = s;
      const next: SponsorSettings = date ? { ...rest, seasonStart: date } : rest;
      return { settings: next, result: (date as string | null) ?? null };
    });
  }

  // --- Teams (#127) ---

  /** A team was merged into another: its sponsors now apply to the team that stayed. */
  async teamMerged(dropId: string, keepId: string): Promise<void> {
    await this.exclusive(async (s) => {
      if (!s.sponsors.some((x) => x.teamIds.includes(dropId))) return { settings: s, result: undefined };
      const now = new Date().toISOString();
      const sponsors = s.sponsors.map((x) => x.teamIds.includes(dropId)
        ? { ...x, teamIds: [...new Set(x.teamIds.map((t) => (t === dropId ? keepId : t)))], updatedAt: now }
        : x);
      return { settings: { ...s, sponsors }, result: undefined };
    }, { allowConflicts: true });
  }

  /**
   * A team was removed: it leaves its sponsors' teams. A sponsor left with no
   * team is shown nowhere, and the admin sees "inga lag", rather than it
   * quietly becoming the whole club's sponsor.
   */
  async teamRemoved(teamId: string): Promise<void> {
    await this.exclusive(async (s) => {
      if (!s.sponsors.some((x) => x.teamIds.includes(teamId))) return { settings: s, result: undefined };
      const now = new Date().toISOString();
      const sponsors = s.sponsors.map((x) => {
        if (!x.teamIds.includes(teamId)) return x;
        const teamIds = x.teamIds.filter((t) => t !== teamId);
        return { ...x, teamIds, ...(teamIds.length === 0 && { teamsGone: true }), updatedAt: now };
      });
      return { settings: { ...s, sponsors }, result: undefined };
    }, { allowConflicts: true });
  }

  // --- Logos (#128) ---

  /**
   * Store a logo sent as a data URL: PNG, JPEG or WebP, at most 1 MB, never
   * SVG. It is scaled down to a PNG of at most 512 px, whatever came in.
   */
  async setLogo(id: string, dataUrl: string): Promise<Sponsor> {
    await this.getSponsorOrThrow(id);
    const logo = decodeLogo(dataUrl);
    if (typeof logo === "string") throw new SponsorError(logo, 400);
    let png: Buffer;
    try {
      png = await this.scaleLogo(logo.bytes);
    } catch (err) {
      if (err instanceof SponsorError) throw err;
      throw new SponsorError("Bilden gick inte att läsa. Välj en PNG, JPG eller WebP.", 400);
    }
    return this.exclusive(async (s) => {
      const current = findSponsor(s, id);
      await this.storage.uploadBuffer(sponsorLogoKey(id), png, "image/png");
      const next = { ...current, logoType: "image/png", updatedAt: laterThan(current.updatedAt) };
      return { settings: { ...s, sponsors: s.sponsors.map((x) => (x.id === id ? next : x)) }, result: structuredClone(next) };
    });
  }

  async removeLogo(id: string): Promise<Sponsor> {
    return this.exclusive(async (s) => {
      const { logoType, ...current } = findSponsor(s, id);
      if (!logoType) return { settings: s, result: structuredClone(current) };
      await this.storage.deleteObject(sponsorLogoKey(id));
      const next = { ...current, updatedAt: laterThan(current.updatedAt) };
      return { settings: { ...s, sponsors: s.sponsors.map((x) => (x.id === id ? next : x)) }, result: structuredClone(next) };
    });
  }

  /** The stored logo, or null when the sponsor has none. */
  async logo(id: string): Promise<{ bytes: Buffer; type: string } | null> {
    const sponsor = (await this.load()).sponsors.find((x) => x.id === id);
    if (!sponsor?.logoType) return null;
    return { bytes: await this.storage.downloadBuffer(sponsorLogoKey(id)), type: sponsor.logoType };
  }

  /**
   * After a restart nothing is transcoding, so a clip that was "processing"
   * never will be, and neither will an upload whose link ran out before it was
   * confirmed (#92). They are marked failed and the admin uploads again. Queued
   * clips are returned so the caller can put them back in the queue.
   */
  async recoverAfterRestart(nowMs = Date.now()): Promise<SponsorClip[]> {
    return this.exclusive(async (s) => {
      let changed = false;
      const now = new Date(nowMs).toISOString();
      const clips = s.clips.map((c) => {
        const interrupted =
          c.status === "processing" ||
          (c.status === "uploading" && nowMs - Date.parse(c.createdAt) > UPLOAD_LINK_SECONDS * 1000);
        if (!interrupted) return c;
        changed = true;
        return { ...c, status: "failed" as const, error: "Avbröts av en omstart – ladda upp igen.", updatedAt: now };
      });
      const queued = clips.filter((c) => c.status === "queued");
      return { settings: changed ? { ...s, clips } : s, result: queued };
    });
  }

  /**
   * An upload the browser never confirmed (tab closed, connection lost) would
   * stay "uploading" for ever. Once its PUT link has long expired it is marked
   * failed, so the admin sees why and can delete it, and anything that did
   * arrive is removed. Returns how many clips were given up on.
   */
  async expireAbandonedUploads(now = Date.now()): Promise<number> {
    const expired = await this.exclusive(async (s) => {
      const stale = new Set(
        s.clips
          .filter((c) => c.status === "uploading" && now - Date.parse(c.createdAt) > ABANDONED_UPLOAD_MS)
          .map((c) => c.id),
      );
      if (stale.size === 0) return { settings: s, result: [] as string[] };
      const at = new Date(now).toISOString();
      const clips = s.clips.map((c) =>
        stale.has(c.id)
          ? { ...c, status: "failed" as const, error: "Uppladdningen blev aldrig klar. Ladda upp klippet igen.", updatedAt: at }
          : c,
      );
      return { settings: { ...s, clips }, result: [...stale] };
    });
    for (const id of expired) await this.storage.deletePrefix(sponsorPrefix(id));
    return expired.length;
  }

  // --- Internals ---

  private async load(): Promise<SponsorSettings> {
    if (this.settings) return this.settings;
    this.loading ??= this.storage.readFileIfExists(SPONSORS_KEY).then((raw) => {
      // Migrated in memory only: the file stays as it is until the admin changes something.
      this.settings = migrate(raw ? (JSON.parse(raw) as RawSettings) : {});
      return this.settings;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  /**
   * Run one change against the current settings and store what it returns.
   * A change that would give an exclusive surface a second sponsor is refused
   * with 409 before anything is written (#126).
   */
  private exclusive<T>(
    change: (s: SponsorSettings) => Promise<{ settings: SponsorSettings; result: T }>,
    options: ChangeOptions = {},
  ): Promise<T> {
    const run = this.queue.then(async () => {
      const before = await this.load();
      const { settings, result } = await change(before);
      if (settings !== before) {
        if (!options.allowConflicts) {
          const conflict = newConflicts(before, settings)[0];
          if (conflict) throw await this.conflictError(settings, conflict, options.subject);
        }
        const next = grouped(settings);
        await this.storage.uploadBuffer(SPONSORS_KEY, JSON.stringify(next, null, 2), "application/json");
        this.settings = next;
      }
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** "P12 har redan huvudsponsor: ICA Maxi." */
  private async conflictError(s: SponsorSettings, c: SurfaceConflict, subject?: string): Promise<SponsorError> {
    const otherId = c.sponsorIds.find((id) => id !== subject) ?? c.sponsorIds[0];
    const other = s.sponsors.find((x) => x.id === otherId)?.name ?? "en annan sponsor";
    const scope = c.teamId === null ? "Klubben" : ((await this.teams?.get(c.teamId))?.name ?? "Laget");
    return new SponsorError(`${scope} har redan ${surfaceDef(c.surface)!.holder}: ${other}.`, 409);
  }

  private async getSponsorOrThrow(id: string): Promise<Sponsor> {
    return findSponsor(await this.load(), id);
  }

  /** The fields of a sponsor the admin sent, checked. Fields left out are left out. */
  private async checkInput(s: SponsorSettings, input: SponsorInput): Promise<Partial<Sponsor>> {
    const out: Partial<Sponsor> = {};
    if (input.name !== undefined) out.name = checkName(input.name);
    if (input.url !== undefined) out.url = checkUrl(input.url);
    if (input.packageId !== undefined) {
      if (!s.packages.some((p) => p.id === input.packageId)) throw new SponsorError("Okänt paket.", 400);
      out.packageId = input.packageId as string;
    }
    if (input.teamIds !== undefined) out.teamIds = await this.checkTeams(input.teamIds);
    if (input.off !== undefined) {
      if (!Array.isArray(input.off) || input.off.some((x) => !isSurfaceId(x))) {
        throw new SponsorError("Okänd sponsoryta.", 400);
      }
      out.off = SURFACES.map((d) => d.id).filter((id) => (input.off as string[]).includes(id));
    }
    if (input.active !== undefined) {
      if (typeof input.active !== "boolean") throw new SponsorError("Ange om sponsorn är aktiv.", 400);
      out.active = input.active;
    }
    return out;
  }

  /** Only the club's own teams: a sponsor of the opponent makes no sense here. */
  private async checkTeams(raw: unknown): Promise<string[]> {
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) {
      throw new SponsorError("Lagen ska vara en lista.", 400);
    }
    const ids = [...new Set(raw as string[])];
    for (const id of ids) {
      const team = await this.teams?.get(id);
      if (!team?.own) throw new SponsorError("Välj bara föreningens egna lag.", 400);
    }
    return ids;
  }
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function newSponsor(id: string, name: string, packageId: string, now: string): Sponsor {
  return { id, name, packageId, teamIds: [], off: [], active: true, createdAt: now, updatedAt: now };
}

/** Now, but always after `iso`: a logo's address changes even when replaced within the same millisecond. */
function laterThan(iso: string): string {
  return new Date(Math.max(Date.now(), Date.parse(iso) + 1)).toISOString();
}

function find(s: SponsorSettings, id: string): SponsorClip {
  const clip = s.clips.find((c) => c.id === id);
  if (!clip) throw new SponsorError("Klippet finns inte.", 404);
  return clip;
}

function findSponsor(s: SponsorSettings, id: unknown): Sponsor {
  const sponsor = s.sponsors.find((x) => x.id === id);
  if (!sponsor) throw new SponsorError("Sponsorn finns inte.", 404);
  return sponsor;
}

function checkName(raw: unknown): string {
  const name = String(typeof raw === "string" ? raw : "").trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_NAME) throw new SponsorError(`Namnet ska vara 1–${MAX_NAME} tecken.`, 400);
  return name;
}

/** A link to the sponsor's site, http or https only, or "" for none. */
function checkUrl(raw: unknown): string {
  if (raw === null || raw === "") return "";
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SponsorError("Länken ska börja med http:// eller https://.", 400);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || text.length > MAX_URL) {
    throw new SponsorError("Länken ska börja med http:// eller https://.", 400);
  }
  return url.toString();
}
