/**
 * Fakes shared by the sponsorship tests (#121). Not a test file itself, so
 * importing it runs no tests twice.
 */
import { vi } from "vitest";
import { writeFile } from "node:fs/promises";
import type { VodEntry } from "../types.js";

/** Storage as the sponsor code sees it, kept in a map. */
export function memoryStorage() {
  const files = new Map<string, { body: Buffer | string; type: string }>();
  /** The VOD index, for the tests to fill. */
  const vods: Partial<VodEntry>[] = [];
  return {
    files,
    vods,
    readFileIfExists: vi.fn(async (key: string) => files.get(key)?.body.toString() ?? null),
    uploadBuffer: vi.fn(async (key: string, body: Buffer | string, type: string) => {
      files.set(key, { body, type });
    }),
    downloadBuffer: vi.fn(async (key: string) => {
      const f = files.get(key);
      if (!f) throw new Error(`NoSuchKey ${key}`);
      return Buffer.from(f.body);
    }),
    deleteObject: vi.fn(async (key: string) => {
      files.delete(key);
    }),
    deletePrefix: vi.fn(async (prefix: string) => {
      let n = 0;
      for (const key of [...files.keys()]) if (key.startsWith(prefix) && files.delete(key)) n++;
      return n;
    }),
    listKeys: vi.fn(async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)).sort()),
    // The rest is what the routes and the transcode queue use.
    readFile: vi.fn(async (key: string) => files.get(key)?.body.toString() ?? null),
    presignGet: vi.fn(async (key: string) => `https://storage.example.com/${key}?sig=get`),
    presignPut: vi.fn(async (key: string, type: string) => `https://storage.example.com/${key}?sig=put&type=${encodeURIComponent(type)}`),
    objectSize: vi.fn(async (key: string) => {
      const f = files.get(key);
      return f ? Buffer.byteLength(f.body) : null;
    }),
    downloadToFile: vi.fn(async (key: string, path: string) => {
      const f = files.get(key);
      if (!f) throw new Error(`NoSuchKey ${key}`);
      await writeFile(path, f.body);
    }),
    readVodIndex: vi.fn(async () => vods as VodEntry[]),
    updateVodEntry: vi.fn(async () => true),
  };
}

/** The club's teams: P12 and F14 are its own, AIK an opponent. */
export const TEAMS = {
  p12: { id: "p12", name: "Älta P12", own: true },
  f14: { id: "f14", name: "Älta F14", own: true },
  aik: { id: "aik", name: "AIK", own: false },
};

/** A config/sponsors.json as v0.8.1 wrote it: three clips, one still transcoding. */
export const V081_FILE = JSON.stringify({
  clips: [
    {
      id: "a1b2c3d4e5f6", name: "ICA Maxi", status: "ready", slots: ["start", "p2", "end"],
      sizeBytes: 18234567, durationSeconds: 15, contentType: "video/mp4",
      createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:02:00.000Z",
    },
    {
      id: "0f9e8d7c6b5a", name: "Bilfirman", status: "ready", slots: ["start", "p1", "p2", "p3", "ot"],
      sizeBytes: 9234567, durationSeconds: 20, contentType: "video/quicktime",
      createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:01:00.000Z",
    },
    {
      id: "112233445566", name: "Pizzerian", status: "processing", slots: [],
      sizeBytes: 1234567, contentType: "video/mp4",
      createdAt: "2026-11-03T10:00:00.000Z", updatedAt: "2026-11-03T10:00:30.000Z",
    },
  ],
  breakSeconds: { p1: 120, p2: 600, p3: 120, ot: 120 },
}, null, 2);

