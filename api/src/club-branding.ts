/**
 * Club branding chosen in the admin view — name, tagline, colour and logo,
 * and who answers for the recordings.
 *
 * The environment (club-config.ts) gives the starting values; what the club
 * sets in the admin view is kept in its own storage and wins over them, so a
 * club changes its look without touching the OSC configuration or restarting.
 */
import { clubManifest, type ClubPrivacy } from "./club-config.js";

export const BRANDING_KEY = "config/club.json";
export const LOGO_KEY = "config/logo";

/** Logos are resized in the browser before upload, so this is generous. */
export const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];

export interface BrandingRecord {
  name?: string;
  tagline?: string;
  accentColor?: string;
  /** Content type of the uploaded logo, or absent when there is none. */
  logoType?: string;
  privacy?: ClubPrivacy;
  updatedAt: string;
}

interface BrandingStorage {
  readFileIfExists(key: string): Promise<string | null>;
  uploadBuffer(key: string, body: Buffer | string, contentType: string): Promise<void>;
  downloadBuffer(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}

/** Only a six-digit hex colour: it is also used to compute contrast. */
const COLOUR = /^#[0-9a-fA-F]{6}$/;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export class Branding {
  private record: BrandingRecord | null = null;
  /** Values from the environment, restored when an override is cleared. */
  private readonly defaults = {
    name: clubManifest.name,
    tagline: clubManifest.tagline,
    accentColor: clubManifest.accentColor,
    logoUrl: clubManifest.logoUrl,
  };

  constructor(private readonly storage: BrandingStorage) {}

  async load(): Promise<void> {
    const raw = await this.storage.readFileIfExists(BRANDING_KEY);
    this.record = raw ? (JSON.parse(raw) as BrandingRecord) : null;
    this.apply();
  }

  /** Validate and store name, tagline and colour. Returns an error message, or null. */
  async update(input: { name?: string; tagline?: string; accentColor?: string }): Promise<string | null> {
    const name = (input.name ?? "").trim();
    const tagline = (input.tagline ?? "").trim();
    const accentColor = (input.accentColor ?? "").trim();

    if (!name || name.length > 60) return "Namnet ska vara 1–60 tecken.";
    if (tagline.length > 140) return "Beskrivningen får vara högst 140 tecken.";
    if (!COLOUR.test(accentColor)) return "Färgen ska anges som #RRGGBB.";

    await this.save({ ...this.record, name, tagline, accentColor });
    return null;
  }

  /** Validate and store who answers for the recordings. Returns an error message, or null. */
  async updatePrivacy(input: Partial<ClubPrivacy>): Promise<string | null> {
    const controller = (input.controller ?? "").trim();
    const contact = (input.contact ?? "").trim();
    const policyUrl = (input.policyUrl ?? "").trim();

    if (controller.length > 100) return "Föreningens namn får vara högst 100 tecken.";
    if (contact && (contact.length > 120 || !EMAIL.test(contact))) return "Kontakten ska vara en e-postadress.";
    if (policyUrl && (policyUrl.length > 300 || !/^https:\/\/[^\s"<>]+$/.test(policyUrl))) {
      return "Länken ska börja med https://.";
    }

    await this.save({ ...this.record, privacy: { controller, contact, policyUrl } });
    return null;
  }

  /** Store a logo sent as a data URL. Returns an error message, or null. */
  async setLogo(dataUrl: string): Promise<string | null> {
    const match = /^data:([a-z/]+);base64,(.+)$/.exec(dataUrl ?? "");
    if (!match || !LOGO_TYPES.includes(match[1])) return "Logotypen ska vara PNG, JPG eller WebP.";

    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length === 0) return "Bilden är tom.";
    if (bytes.length > MAX_LOGO_BYTES) return "Bilden är för stor (max 1 MB).";

    await this.storage.uploadBuffer(LOGO_KEY, bytes, match[1]);
    await this.save({ ...this.record, logoType: match[1] });
    return null;
  }

  async removeLogo(): Promise<void> {
    if (!this.record?.logoType) return;
    await this.storage.deleteObject(LOGO_KEY);
    const { logoType: _removed, ...rest } = this.record;
    await this.save(rest);
  }

  /** The uploaded logo, or null when the club has not uploaded one. */
  async logo(): Promise<{ bytes: Buffer; type: string } | null> {
    if (!this.record?.logoType) return null;
    return { bytes: await this.storage.downloadBuffer(LOGO_KEY), type: this.record.logoType };
  }

  private async save(fields: Omit<BrandingRecord, "updatedAt">): Promise<void> {
    const record: BrandingRecord = { ...fields, updatedAt: new Date().toISOString() };
    await this.storage.uploadBuffer(BRANDING_KEY, JSON.stringify(record, null, 2), "application/json");
    this.record = record;
    this.apply();
  }

  /** Write the effective values into the public manifest. */
  private apply(): void {
    const r = this.record;
    clubManifest.name = r?.name || this.defaults.name;
    clubManifest.tagline = r?.tagline || this.defaults.tagline;
    clubManifest.accentColor = r?.accentColor || this.defaults.accentColor;
    clubManifest.privacy = { controller: "", contact: "", policyUrl: "", ...r?.privacy };
    // The version in the URL makes browsers fetch a replaced logo at once.
    clubManifest.logoUrl = r?.logoType
      ? `/api/club/logo?v=${encodeURIComponent(r.updatedAt)}`
      : this.defaults.logoUrl;
  }
}
