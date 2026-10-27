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

export interface SetupRecord {
  /** SHA-256 of the SETUP_CODE that was used. A different code reopens setup. */
  codeHash: string;
  adminPin: string;
  viewerPin: string;
  completedAt: string;
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

export const ADMIN_PIN_PATTERN = /^\d{6,8}$/;
export const VIEWER_PIN_PATTERN = /^\d{4,8}$/;

export class Setup {
  private required = false;
  /** The record from before a reset, whose viewer PIN carries over. */
  private previous: SetupRecord | null = null;

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

  /** Validate and store the club's choices. Returns an error message, or null. */
  async complete(input: {
    code?: string;
    adminPin?: string;
    viewerPin?: string;
  }): Promise<string | null> {
    if (!this.required) return "Installationen är redan uppsatt.";
    if (!codeMatches(input.code ?? "", this.setupCode)) return "Fel uppsättningskod.";

    const adminPin = (input.adminPin ?? "").trim();
    // After a reset an empty viewer PIN means "keep the one we have".
    const viewerPin = (input.viewerPin ?? "").trim() || this.previous?.viewerPin || "";
    if (!ADMIN_PIN_PATTERN.test(adminPin)) return "Admin-koden ska vara 6–8 siffror.";
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
    this.required = false;
    this.previous = null;
    return null;
  }

  private normalised(): string {
    return this.setupCode.trim().toUpperCase();
  }
}
