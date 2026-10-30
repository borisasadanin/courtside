/**
 * First-run setup — the club chooses its own PINs.
 *
 * The installer generates a one-time SETUP_CODE and shows it once.  Until setup
 * is done the installation has no admin PIN at all, so the only way in is that
 * code: a fresh installation is never open.  Whoever has it picks the admin and
 * viewer PINs, which are kept in the club's own storage and survive restarts.
 *
 * Setting a new SETUP_CODE reopens setup.  That is the "forgot the admin PIN"
 * path: the landing page does it for whoever signs in with the OSC account that
 * owns the installation.  The viewer PIN carries over unless a new one is chosen.
 */
import crypto from "node:crypto";
import { mutableConfig } from "./config.js";

export const SETUP_KEY = "config/setup.json";

/** Refusal when a viewer PIN is left out without saying that is meant. */
export const OPEN_ACCESS_UNCONFIRMED =
  "Välj en tittarkod, eller bekräfta att alla som har adressen får titta.";

export interface SetupRecord {
  /** SHA-256 of the SETUP_CODE that was used. A different code reopens setup. */
  codeHash: string;
  adminPin: string;
  viewerPin: string;
  completedAt: string;
  /** When the admin last changed a PIN from the admin view. */
  changedAt?: string;
}

interface SetupStorage {
  readFileIfExists(key: string): Promise<string | null>;
  uploadBuffer(key: string, body: Buffer | string, contentType: string): Promise<void>;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison, so the code cannot be guessed a character at a time. */
export function codeMatches(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  return crypto.timingSafeEqual(
    Buffer.from(sha256(given.trim().toUpperCase())),
    Buffer.from(sha256(expected.trim().toUpperCase())),
  );
}

function pinMatches(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(given.trim())), Buffer.from(sha256(expected)));
}

export const ADMIN_PIN_PATTERN = /^\d{6,8}$/;
export const VIEWER_PIN_PATTERN = /^\d{4,8}$/;

export class Setup {
  private required = false;
  /** The record from before a reset, whose viewer PIN carries over. */
  private previous: SetupRecord | null = null;
  /** The record in force, rewritten when the admin changes a PIN. */
  private current: SetupRecord | null = null;

  constructor(
    private readonly storage: SetupStorage,
    private readonly setupCode: string,
  ) {}

  /** Whether the installation is waiting for first-run setup. */
  isRequired(): boolean {
    return this.required;
  }

  /** Whether setup was reopened by a reset that keeps an existing viewer PIN. */
  keepsViewerPin(): boolean {
    return this.required && !!this.previous?.viewerPin;
  }

  /**
   * Restore the PINs chosen during setup, or open setup if there are none for
   * the current code.  Without a SETUP_CODE the PINs come from the environment
   * and setup does not exist.
   */
  async load(): Promise<void> {
    if (!this.setupCode) {
      this.required = false;
      return;
    }

    const raw = await this.storage.readFileIfExists(SETUP_KEY);
    const record = raw ? (JSON.parse(raw) as SetupRecord) : null;

    if (record && record.codeHash === sha256(this.normalised())) {
      mutableConfig.ADMIN_PIN = record.adminPin;
      mutableConfig.VIEWER_PIN = record.viewerPin;
      this.current = record;
      this.required = false;
      return;
    }

    // No record, or one made with an earlier code: setup is open, and nobody
    // gets in with an old admin PIN in the meantime.  A new code is how an
    // owner who forgot the admin PIN gets back in, so viewers keep theirs —
    // a reset must not leave the matches open to anyone with the link.
    mutableConfig.ADMIN_PIN = "";
    this.previous = record;
    if (record) mutableConfig.VIEWER_PIN = record.viewerPin;
    this.required = true;
  }

  /**
   * Validate and store the club's choices. Returns an error message, or null.
   * Watching without a viewer PIN takes `openAccess`: it is usually children on
   * the film, so leaving the field empty is not enough to open it to anyone.
   */
  async complete(input: {
    code?: string;
    adminPin?: string;
    viewerPin?: string;
    openAccess?: boolean;
  }): Promise<string | null> {
    if (!this.required) return "Installationen är redan uppsatt.";
    if (!codeMatches(input.code ?? "", this.setupCode)) return "Fel uppsättningskod.";

    const adminPin = (input.adminPin ?? "").trim();
    // After a reset an empty viewer PIN means "keep the one we have".
    const viewerPin = (input.viewerPin ?? "").trim() || this.previous?.viewerPin || "";
    if (!ADMIN_PIN_PATTERN.test(adminPin)) return "Admin-koden ska vara 6–8 siffror.";
    if (!viewerPin && !input.openAccess) return OPEN_ACCESS_UNCONFIRMED;
    if (viewerPin && !VIEWER_PIN_PATTERN.test(viewerPin)) return "Tittarkoden ska vara 4–8 siffror.";
    if (viewerPin === adminPin) return "Tittarkoden och admin-koden måste vara olika.";

    const record: SetupRecord = {
      codeHash: sha256(this.normalised()),
      adminPin,
      viewerPin,
      completedAt: new Date().toISOString(),
    };
    await this.storage.uploadBuffer(SETUP_KEY, JSON.stringify(record, null, 2), "application/json");

    mutableConfig.ADMIN_PIN = adminPin;
    mutableConfig.VIEWER_PIN = viewerPin;
    this.current = record;
    this.required = false;
    this.previous = null;
    return null;
  }

  /**
   * Why the admin view cannot change the PINs, or null if it can.  Without a
   * setup code they come from the environment, and a change here would be
   * lost at the next restart.
   */
  pinsLocked(): string | null {
    if (!this.setupCode) return "Koderna är satta i serverns inställningar och ändras där.";
    if (this.required || !this.current) return "Installationen är inte uppsatt än.";
    return null;
  }

  /**
   * New PINs from the admin view, kept in the same record as setup's so they
   * survive a restart.  A PIN left out stays as it is.  A new admin PIN needs
   * the current one: a session left open on a shared computer must not be
   * enough to lock the club out.  Returns an error message, or null.
   */
  async changePins(input: {
    currentAdminPin?: string;
    adminPin?: string;
    viewerPin?: string;
    openAccess?: boolean;
  }): Promise<string | null> {
    const locked = this.pinsLocked();
    if (locked) return locked;
    const record = this.current!;

    const adminPin = input.adminPin?.trim() || record.adminPin;
    const viewerPin = input.viewerPin === undefined ? record.viewerPin : input.viewerPin.trim();
    if (adminPin !== record.adminPin) {
      if (!pinMatches(input.currentAdminPin ?? "", record.adminPin)) return "Fel nuvarande admin-kod.";
      if (!ADMIN_PIN_PATTERN.test(adminPin)) return "Admin-koden ska vara 6–8 siffror.";
    }
    if (!viewerPin && record.viewerPin && !input.openAccess) return OPEN_ACCESS_UNCONFIRMED;
    if (viewerPin && !VIEWER_PIN_PATTERN.test(viewerPin)) return "Tittarkoden ska vara 4–8 siffror.";
    if (viewerPin === adminPin) return "Tittarkoden och admin-koden måste vara olika.";

    const next: SetupRecord = { ...record, adminPin, viewerPin, changedAt: new Date().toISOString() };
    // Stored first: if storage fails, the PINs in force stay the ones on record.
    await this.storage.uploadBuffer(SETUP_KEY, JSON.stringify(next, null, 2), "application/json");
    this.current = next;
    mutableConfig.ADMIN_PIN = adminPin;
    mutableConfig.VIEWER_PIN = viewerPin;
    return null;
  }

  private normalised(): string {
    return this.setupCode.trim().toUpperCase();
  }
}
