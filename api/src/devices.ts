/**
 * Camera registry — which phones may broadcast to this installation.
 *
 * Replaces a single shared API key copied into every camera.  A shared key
 * cannot be taken away from one phone without taking it from all of them, and
 * it has to be compiled into the app, which means every club needs its own
 * build.  A paired device gets its own token instead: revocable one at a time,
 * and handed out at pairing rather than at build time, so one app from the App
 * Store can serve any club.
 *
 * Only a hash of each token is stored.  A leaked registry then grants nothing.
 */
import crypto from "node:crypto";
import type { MinioClient } from "./minio.js";

export interface Device {
  id: string;
  name: string;
  /** SHA-256 of the token. The token itself is shown once, at pairing. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  /** The camera app's release when last seen. Says which features it has. */
  appVersion?: string;
  revokedAt?: string;
  /** What the phone called itself at pairing, when an invite chose `name`. */
  deviceName?: string;
  /** The invite this camera was paired with, if any. */
  inviteId?: string;
}

/** A device as exposed over the API — never includes the hash. */
export type DeviceSummary = Omit<Device, "tokenHash">;

/** How long a pairing code can be used before it expires. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * An invite: a code an admin sends to someone else, who pairs their own camera
 * with it later, without the admin's screen.  It pairs one camera, and is
 * persisted because it outlives a restart.  Only a hash of the code is kept.
 */
export interface DeviceInvite {
  id: string;
  /** Whose camera this is. Becomes the camera's name. */
  name: string;
  codeHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  /** The camera the invite paired. */
  deviceId?: string;
  revokedAt?: string;
}

export type InviteStatus = "pending" | "used" | "expired" | "revoked";

/** An invite as exposed over the API — never includes the hash. */
export type InviteSummary = Omit<DeviceInvite, "codeHash"> & { status: InviteStatus };

/** How long an invite can be redeemed. */
export const INVITE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** How long a finished invite stays in the list before it is dropped. */
export const INVITE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Longest name an admin can give a camera. */
export const DEVICE_NAME_MAX = 60;

/** A camera name as an admin typed it, or null when it is empty. */
export function normaliseDeviceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, DEVICE_NAME_MAX).trim();
  return name || null;
}

function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

function inviteStatus(invite: DeviceInvite, now = Date.now()): InviteStatus {
  if (invite.usedAt) return "used";
  if (invite.revokedAt) return "revoked";
  if (new Date(invite.expiresAt).getTime() <= now) return "expired";
  return "pending";
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Unambiguous alphabet: no O/0, I/1, so a code can be read aloud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePairingCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

interface PendingPairing {
  code: string;
  expiresAt: number;
}

/**
 * Registry of paired cameras.
 *
 * Pairing codes live in memory only: they are valid for minutes, and a restart
 * mid-pairing just means generating a new one.  Devices are persisted, because
 * a camera losing its pairing because the backend restarted would be a bad
 * surprise halfway through a season.
 */
export class DeviceRegistry {
  private devices: Device[] = [];
  private loading: Promise<void> | null = null;
  private invites: DeviceInvite[] = [];
  private invitesLoading: Promise<void> | null = null;
  private pending: PendingPairing[] = [];

  constructor(private minio: MinioClient) {}

  /**
   * Read the registry once.  Concurrent callers share the one read, so a second
   * read can never replace an array the first caller has already added to.
   */
  private load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.minio.readDeviceIndex().then(
        (devices) => { this.devices = devices; },
        (err) => { this.loading = null; throw err; }
      );
    }
    return this.loading;
  }

  private loadInvites(): Promise<void> {
    if (!this.invitesLoading) {
      this.invitesLoading = this.minio.readInviteIndex().then(
        (invites) => { this.invites = invites; },
        (err) => { this.invitesLoading = null; throw err; }
      );
    }
    return this.invitesLoading;
  }

  /** Issue a pairing code for a camera to redeem. */
  createPairingCode(): { code: string; expiresAt: string } {
    this.prunePending();
    const code = generatePairingCode();
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    this.pending.push({ code, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  private prunePending(): void {
    const now = Date.now();
    this.pending = this.pending.filter((p) => p.expiresAt > now);
  }

  /**
   * Redeem a pairing code or an invite code and register the camera.
   *
   * Both are single-use.  The camera app sends either in the same field, so an
   * app that only knows pairing codes can redeem an invite too.
   */
  async pair(code: string, name: string): Promise<{ device: DeviceSummary; token: string } | null> {
    this.prunePending();
    const normalised = normaliseCode(code);
    const index = this.pending.findIndex((p) => p.code === normalised);
    if (index === -1) return this.redeemInvite(normalised, name);
    this.pending.splice(index, 1);

    await this.load();

    const { device, token } = this.newDevice(name.trim() || "Kamera");
    this.devices.push(device);
    await this.minio.writeDeviceIndex(this.devices);

    return { device: toSummary(device), token };
  }

  private newDevice(name: string): { device: Device; token: string } {
    const token = crypto.randomBytes(32).toString("hex");
    const device: Device = {
      id: crypto.randomBytes(6).toString("hex"),
      name,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
    };
    return { device, token };
  }

  /**
   * Pair a camera with an invite.  The camera takes the invite's name, so the
   * admin sees whose camera it is; the phone's own name is kept beside it.
   */
  private async redeemInvite(
    code: string,
    phoneName: string
  ): Promise<{ device: DeviceSummary; token: string } | null> {
    await Promise.all([this.load(), this.loadInvites()]);

    // From here to the push, nothing awaits: two cameras redeeming the same
    // code at once cannot both find it unused.
    const hash = hashToken(code);
    const invite = this.invites.find((i) => i.codeHash === hash);
    if (!invite || inviteStatus(invite) !== "pending") return null;

    const { device, token } = this.newDevice(invite.name);
    const ownName = phoneName.trim();
    if (ownName) device.deviceName = ownName.slice(0, DEVICE_NAME_MAX);
    device.inviteId = invite.id;

    invite.usedAt = device.createdAt;
    invite.deviceId = device.id;
    this.devices.push(device);

    // The invite first: if the second write fails, the invite is spent rather
    // than left open for another camera.
    await this.minio.writeInviteIndex(this.invites);
    await this.minio.writeDeviceIndex(this.devices);

    return { device: toSummary(device), token };
  }

  /** Create an invite for one camera. The code is returned once, here. */
  async createInvite(name: string): Promise<{ invite: InviteSummary; code: string }> {
    await this.loadInvites();
    this.pruneInvites();

    const code = generatePairingCode();
    const now = Date.now();
    const invite: DeviceInvite = {
      id: crypto.randomBytes(6).toString("hex"),
      name,
      codeHash: hashToken(code),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
    };

    this.invites.push(invite);
    await this.minio.writeInviteIndex(this.invites);
    return { invite: toInviteSummary(invite), code };
  }

  /** Every invite still worth showing, newest first. */
  async listInvites(): Promise<InviteSummary[]> {
    await this.loadInvites();
    const now = Date.now();
    return this.invites
      .filter((i) => !isStale(i, now))
      .map((i) => toInviteSummary(i, now))
      .reverse(); // stored in the order they were made
  }

  /** Withdraw an invite nobody has used yet. */
  async revokeInvite(id: string): Promise<"revoked" | "not_found" | "not_pending"> {
    await this.loadInvites();
    const invite = this.invites.find((i) => i.id === id);
    if (!invite) return "not_found";
    if (inviteStatus(invite) !== "pending") return "not_pending";
    invite.revokedAt = new Date().toISOString();
    await this.minio.writeInviteIndex(this.invites);
    return "revoked";
  }

  /** Drop invites that finished long ago. Persisted with the next write. */
  private pruneInvites(): void {
    const now = Date.now();
    this.invites = this.invites.filter((i) => !isStale(i, now));
  }

  /** Give a camera a new name. Returns null when the id is unknown or revoked. */
  async rename(id: string, name: string): Promise<DeviceSummary | null> {
    await this.load();
    const device = this.devices.find((d) => d.id === id);
    if (!device || device.revokedAt) return null;
    device.name = name;
    await this.minio.writeDeviceIndex(this.devices);
    return toSummary(device);
  }

  /** The device this token belongs to, or null when unknown or revoked. */
  async verify(token: string): Promise<Device | null> {
    if (!token) return null;
    await this.load();
    const hash = hashToken(token);
    const device = this.devices.find((d) => d.tokenHash === hash);
    if (!device || device.revokedAt) return null;
    return device;
  }

  /**
   * Record that a device was seen, at most once a minute to avoid write churn.
   * A new app version is recorded at once, so an update shows up right away.
   * Apps before 1.1.0 send no version; theirs stays unknown.
   */
  async touch(device: Device, appVersion?: string): Promise<void> {
    const version = normaliseAppVersion(appVersion);
    const newVersion = version !== undefined && version !== device.appVersion;
    const last = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
    if (!newVersion && Date.now() - last < 60_000) return;
    device.lastSeenAt = new Date().toISOString();
    if (version !== undefined) device.appVersion = version;
    await this.minio.writeDeviceIndex(this.devices).catch(() => {
      // Losing a lastSeen timestamp is not worth failing a broadcast over.
    });
  }

  async list(): Promise<DeviceSummary[]> {
    await this.load();
    return this.devices.map(toSummary);
  }

  /** Revoke one device. Returns false when the id is unknown. */
  async revoke(id: string): Promise<boolean> {
    await this.load();
    const device = this.devices.find((d) => d.id === id);
    if (!device || device.revokedAt) return false;
    device.revokedAt = new Date().toISOString();
    await this.minio.writeDeviceIndex(this.devices);
    return true;
  }

  /** Test seam: number of unexpired pairing codes outstanding. */
  pendingCount(): number {
    this.prunePending();
    return this.pending.length;
  }
}

/** A version string as the app sends it ("1.1.0"), or undefined for anything else. */
export function normaliseAppVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^\d+(\.\d+){1,2}$/.test(trimmed) ? trimmed : undefined;
}

function toSummary(device: Device): DeviceSummary {
  const { tokenHash: _ignored, ...summary } = device;
  return summary;
}

function toInviteSummary(invite: DeviceInvite, now = Date.now()): InviteSummary {
  const { codeHash: _ignored, ...summary } = invite;
  return { ...summary, status: inviteStatus(invite, now) };
}

/** Finished (used, revoked or expired) longer than the retention period ago. */
function isStale(invite: DeviceInvite, now: number): boolean {
  if (inviteStatus(invite, now) === "pending") return false;
  const finished = invite.usedAt ?? invite.revokedAt ?? invite.expiresAt;
  return now - new Date(finished).getTime() > INVITE_RETENTION_MS;
}
