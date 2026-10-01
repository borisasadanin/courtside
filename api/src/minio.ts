import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketPolicyCommand,
  GetObjectCommand,
  PutObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { VodEntry, HighlightClip } from "./types.js";
import type { Device } from "./devices.js";
import { config } from "./config.js";

const BUCKET = config.MINIO_RECORDINGS_BUCKET;
const VOD_INDEX_KEY = "vod-index.json";
const CLIPS_INDEX_KEY = "clips-index.json";
const DEVICE_INDEX_KEY = "devices.json";

export class MinioClient {
  private s3: S3Client;
  private endpoint: string;

  /** Async mutex to prevent concurrent read-modify-write on vod-index.json */
  private writeLock: Promise<void> = Promise.resolve();

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const acquired = new Promise<void>((r) => { release = r; });
    const prev = this.writeLock;
    this.writeLock = acquired;
    await prev;
    try {
      return await fn();
    } finally {
      release!();
    }
  }

  constructor(endpoint: string, accessKey: string, secretKey: string) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.s3 = new S3Client({
      endpoint: this.endpoint,
      region: "us-east-1",
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
      },
      forcePathStyle: true, // Required for MinIO
    });
  }

  /**
   * Ensure the recordings bucket exists and is NOT publicly readable.
   *
   * Earlier versions attached a public-read policy so browsers could fetch HLS
   * segments directly.  That made every recording readable by anyone who knew
   * or guessed a URL, regardless of the viewer PIN — the PIN guarded the API,
   * not the media.  Segments are now reached through short-lived presigned
   * URLs issued by the media routes, so the policy is actively removed rather
   * than merely not set: an installation that was public before becomes
   * private on the next start.
   */
  async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    }

    try {
      await this.s3.send(new DeleteBucketPolicyCommand({ Bucket: BUCKET }));
    } catch {
      // No policy to remove — already private.
    }
  }

  /**
   * Short-lived presigned GET URL for one object.
   *
   * Expiry is deliberately short: the media routes presign at request time and
   * redirect, so a URL only has to survive the fetch that follows it.  A leaked
   * URL is then useless within minutes.
   */
  async presignGet(key: string, expiresInSeconds = 300): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: expiresInSeconds }
    );
  }

  /** True when the object exists. Used to reject media requests for unknown keys. */
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  /** Read the VOD index from MinIO. Returns [] if not found. */
  async readVodIndex(): Promise<VodEntry[]> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: VOD_INDEX_KEY })
      );
      const body = await res.Body?.transformToString();
      return body ? JSON.parse(body) : [];
    } catch {
      return [];
    }
  }

  /** Write the VOD index to MinIO. */
  async writeVodIndex(entries: VodEntry[]): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: VOD_INDEX_KEY,
        Body: JSON.stringify(entries, null, 2),
        ContentType: "application/json",
      })
    );
  }

  /** Add a new VOD entry and persist (mutex-protected). */
  async addVodEntry(entry: VodEntry): Promise<void> {
    return this.withLock(async () => {
      const entries = await this.readVodIndex();
      entries.push(entry);
      await this.writeVodIndex(entries);
    });
  }

  /** Update an existing VOD entry (by id) and persist (mutex-protected). */
  async updateVodEntry(
    id: string,
    update: Partial<VodEntry>
  ): Promise<void> {
    return this.withLock(async () => {
      const entries = await this.readVodIndex();
      const idx = entries.findIndex((e) => e.id === id);
      if (idx !== -1) {
        entries[idx] = { ...entries[idx], ...update };
        await this.writeVodIndex(entries);
      }
    });
  }

  /** Remove a VOD entry by id and persist (mutex-protected). */
  async removeVodEntry(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const entries = await this.readVodIndex();
      const filtered = entries.filter((e) => e.id !== id);
      if (filtered.length === entries.length) return false;
      await this.writeVodIndex(filtered);
      return true;
    });
  }

  // ============================
  // Clips index (persistent, like VOD index)
  // ============================

  /** Read the clips index from MinIO. Returns [] if not found. */
  async readClipsIndex(): Promise<HighlightClip[]> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: CLIPS_INDEX_KEY })
      );
      const body = await res.Body?.transformToString();
      return body ? JSON.parse(body) : [];
    } catch {
      return [];
    }
  }

  /** Write the clips index to MinIO. */
  async writeClipsIndex(entries: HighlightClip[]): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: CLIPS_INDEX_KEY,
        Body: JSON.stringify(entries, null, 2),
        ContentType: "application/json",
      })
    );
  }

  /** Add a new clip entry and persist (mutex-protected). */
  async addClipEntry(entry: HighlightClip): Promise<void> {
    return this.withLock(async () => {
      const entries = await this.readClipsIndex();
      entries.push(entry);
      await this.writeClipsIndex(entries);
    });
  }

  // ============================
  // Device registry
  // ============================

  /** Read the paired-camera registry. Returns [] when nothing is paired yet. */
  async readDeviceIndex(): Promise<Device[]> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: DEVICE_INDEX_KEY })
      );
      const body = await res.Body?.transformToString();
      return body ? JSON.parse(body) : [];
    } catch {
      return [];
    }
  }

  /** Persist the paired-camera registry (mutex-protected, like the other indexes). */
  async writeDeviceIndex(devices: Device[]): Promise<void> {
    return this.withLock(async () => {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: DEVICE_INDEX_KEY,
          Body: JSON.stringify(devices, null, 2),
          ContentType: "application/json",
        })
      );
    });
  }

  /** Storage key of the stitched VOD playlist for a recording. */
  vodPlaylistKey(streamId: string): string {
    return `${streamId}/index.m3u8`;
  }

  /** Storage key of a highlight clip's manifest. */
  clipManifestKey(streamId: string, clipId: string): string {
    return `clips/${streamId}/${clipId}.m3u8`;
  }

  /** Storage key of a highlight clip's MP4. */
  clipMp4Key(streamId: string, clipId: string): string {
    return `clips/${streamId}/${clipId}.mp4`;
  }

  /** Storage key of a highlight clip's thumbnail. */
  clipThumbnailKey(streamId: string, clipId: string): string {
    return `clips/${streamId}/${clipId}.jpg`;
  }

  /** Get total size of all objects under a prefix (streamId/) in bytes */
  async getVodSize(streamId: string): Promise<number> {
    let totalSize = 0;
    let continuationToken: string | undefined;

    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: `${streamId}/`,
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of res.Contents || []) {
        totalSize += obj.Size || 0;
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);

    return totalSize;
  }

  /** Get storage info: total used bytes and per-VOD sizes */
  async getStorageInfo(
    vodEntries: VodEntry[]
  ): Promise<{ totalBytes: number; vods: { id: string; sizeBytes: number }[] }> {
    const vods: { id: string; sizeBytes: number }[] = [];
    let totalBytes = 0;

    await Promise.all(
      vodEntries.map(async (entry) => {
        const size = await this.getVodSize(entry.id);
        vods.push({ id: entry.id, sizeBytes: size });
        totalBytes += size;
      })
    );

    return { totalBytes, vods };
  }

  /** Upload a raw buffer to a key in the recordings bucket */
  async uploadBuffer(key: string, body: Buffer | string, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
  }

  /** Download a file from the recordings bucket as a Buffer */
  async downloadBuffer(key: string): Promise<Buffer> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key })
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty response for key: ${key}`);
    return Buffer.from(bytes);
  }

  /** Read a text file from the recordings bucket. Returns null if not found. */
  async readFile(key: string): Promise<string | null> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key })
      );
      return (await res.Body?.transformToString()) ?? null;
    } catch {
      return null;
    }
  }

  /** Delete all objects under a prefix (streamId/) */
  async deleteVodFiles(streamId: string): Promise<number> {
    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      const listRes = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: `${streamId}/`,
          ContinuationToken: continuationToken,
        })
      );

      const objects = listRes.Contents || [];
      if (objects.length === 0) break;

      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: {
            Objects: objects.map((o) => ({ Key: o.Key })),
            Quiet: true,
          },
        })
      );

      deleted += objects.length;
      continuationToken = listRes.NextContinuationToken;
    } while (continuationToken);

    return deleted;
  }
}
