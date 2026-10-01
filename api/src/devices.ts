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
  revokedAt?: string;
}

/** A device as exposed over the API — never includes the hash. */
export type DeviceSummary = Omit<Device, "tokenHash">;

/** How long a pairing code can be used before it expires. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

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
  private loaded = false;
  private pending: PendingPairing[] = [];

  constructor(private minio: MinioClient) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.devices = await this.minio.readDeviceIndex();
    this.loaded = true;
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
   * Redeem a pairing code and register the camera.
   * The code is single-use: redeeming it removes it.
   */
  async pair(code: string, name: string): Promise<{ device: DeviceSummary; token: string } | null> {
    this.prunePending();
    const normalised = code.trim().toUpperCase();
    const index = this.pending.findIndex((p) => p.code === normalised);
    if (index === -1) return null;
    this.pending.splice(index, 1);

    await this.load();

    const token = crypto.randomBytes(32).toString("hex");
    const device: Device = {
      id: crypto.randomBytes(6).toString("hex"),
      name: name.trim() || "Kamera",
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
    };

    this.devices.push(device);
    await this.minio.writeDeviceIndex(this.devices);

    return { device: toSummary(device), token };
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

  /** Record that a device was seen, at most once a minute to avoid write churn. */
  async touch(device: Device): Promise<void> {
    const last = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
    if (Date.now() - last < 60_000) return;
    device.lastSeenAt = new Date().toISOString();
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

function toSummary(device: Device): DeviceSummary {
  const { tokenHash: _ignored, ...summary } = device;
  return summary;
}
