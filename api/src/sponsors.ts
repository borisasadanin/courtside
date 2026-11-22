/**
 * Sponsor clips (#87): short films the club uploads, played to live viewers
 * when the match starts, in period breaks, in overtime and when it ends.
 *
 * The clips belong to the whole club. They are played in the viewer's own
 * player, never mixed into the HLS stream (Restreamer copies the camera's
 * codec, so a clip would have to match the camera exactly), and never in a
 * replay.
 *
 * Stored in the club's own storage like the teams (teams.ts):
 *
 *   config/sponsors.json            the list, in play order, and the break lengths
 *   sponsors/<id>/original          the file as uploaded, deleted once transcoded
 *   sponsors/<id>/index.m3u8        HLS, 1080p30 at most
 *   sponsors/<id>/seg_00000.ts …
 *   sponsors/<id>/thumb.jpg         a frame for the admin list
 */
import crypto from "node:crypto";
import type { RecordedPause } from "./types.js";

export const SPONSORS_KEY = "config/sponsors.json";

/** Largest file the admin may upload. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Where in a match a clip can be shown. The order here is the order of the admin's columns. */
export const SPONSOR_SLOTS = ["start", "p1", "p2", "p3", "ot", "end"] as const;
export type SponsorSlot = (typeof SPONSOR_SLOTS)[number];

/** The slots that are breaks, and so have a length the clips should fit into. */
export const BREAK_SLOTS = ["p1", "p2", "p3", "ot"] as const;
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

export interface SponsorSettings {
  /** Every clip, in the order they are played. */
  clips: SponsorClip[];
  breakSeconds: Record<BreakSlot, number>;
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

export class SponsorRegistry {
  private settings: SponsorSettings | null = null;
  private loading: Promise<SponsorSettings> | null = null;
  /** Changes run one at a time: the transcoder and the admin both write the list. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: SponsorStorage) {}

  /** Every clip in play order, and the break lengths. */
  async read(): Promise<SponsorSettings> {
    const s = await this.load();
    return { clips: s.clips.map((c) => ({ ...c, slots: [...c.slots] })), breakSeconds: { ...s.breakSeconds } };
  }

  async get(id: string): Promise<SponsorClip | null> {
    const c = (await this.load()).clips.find((x) => x.id === id);
    return c ? { ...c, slots: [...c.slots] } : null;
  }

  /**
   * For the viewers: the ready clips of each slot, in play order. A slot with
   * no clips is left out, so the player can tell "nothing to show" at a glance.
   */
  async playlist(): Promise<Partial<Record<SponsorSlot, SponsorClip[]>>> {
    const out: Partial<Record<SponsorSlot, SponsorClip[]>> = {};
    for (const clip of (await this.load()).clips) {
      if (clip.status !== "ready") continue;
      for (const slot of clip.slots) (out[slot] ??= []).push(clip);
    }
    return out;
  }

  /** A new clip waiting for its upload. Last in the play order, in no slot yet. */
  async create(name: unknown, sizeBytes: unknown, contentType: unknown): Promise<SponsorClip> {
    const size = Number(sizeBytes);
    if (!Number.isFinite(size) || size <= 0) throw new SponsorError("Filen är tom.", 400);
    if (size > MAX_UPLOAD_BYTES) throw new SponsorError("Filen får vara högst 200 MB.", 413);
    const type = typeof contentType === "string" ? contentType.trim() : "";
    if (type && !/^video\//i.test(type)) throw new SponsorError("Filen måste vara en video.", 415);

    return this.exclusive(async (s) => {
      const now = new Date().toISOString();
      const clip: SponsorClip = {
        id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        name: checkName(name),
        status: "uploading",
        slots: [],
        sizeBytes: size,
        ...(type && { contentType: type }),
        createdAt: now,
        updatedAt: now,
      };
      return { settings: { ...s, clips: [...s.clips, clip] }, result: clip };
    });
  }

  /** Change one clip's fields. Throws SponsorError when it does not exist. */
  async patch(id: string, change: Partial<Omit<SponsorClip, "id" | "createdAt">>): Promise<SponsorClip> {
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

  /** Remove a clip and every file it has. Returns false when there was none. */
  async remove(id: string): Promise<boolean> {
    const removed = await this.exclusive(async (s) => {
      if (!s.clips.some((c) => c.id === id)) return { settings: s, result: false };
      return { settings: { ...s, clips: s.clips.filter((c) => c.id !== id) }, result: true };
    });
    if (removed) await this.storage.deletePrefix(sponsorPrefix(id));
    return removed;
  }

  /** New play order. Must name every clip exactly once. */
  async reorder(ids: unknown): Promise<SponsorSettings> {
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
      const next = { ...s, clips: (ids as string[]).map((id) => byId.get(id)!) };
      return { settings: next, result: next };
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
      const parsed = raw ? (JSON.parse(raw) as Partial<SponsorSettings>) : {};
      this.settings = {
        clips: parsed.clips ?? [],
        breakSeconds: { ...DEFAULT_BREAK_SECONDS, ...(parsed.breakSeconds ?? {}) },
      };
      return this.settings;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  /** Run one change against the current settings and store what it returns. */
  private exclusive<T>(change: (s: SponsorSettings) => Promise<{ settings: SponsorSettings; result: T }>): Promise<T> {
    const run = this.queue.then(async () => {
      const before = await this.load();
      const { settings, result } = await change(before);
      if (settings !== before) {
        await this.storage.uploadBuffer(SPONSORS_KEY, JSON.stringify(settings, null, 2), "application/json");
        this.settings = settings;
      }
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

function find(s: SponsorSettings, id: string): SponsorClip {
  const clip = s.clips.find((c) => c.id === id);
  if (!clip) throw new SponsorError("Klippet finns inte.", 404);
  return clip;
}

function checkName(raw: unknown): string {
  const name = String(typeof raw === "string" ? raw : "").trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_NAME) throw new SponsorError(`Namnet ska vara 1–${MAX_NAME} tecken.`, 400);
  return name;
}
