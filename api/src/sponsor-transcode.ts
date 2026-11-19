/**
 * Transcoding of sponsor clips (#91, #92).
 *
 * The admin's file may be anything a phone or an editing program produces,
 * up to 4K60 HEVC. Viewers get HLS at 1080p30 at most, H.264 + AAC, so every
 * browser that plays the match plays the clip too.
 *
 * Measured before writing this (see the first comment on #87): a 30 s clip
 * takes 4–9 s on an M5 and under 600 MB of memory; on an OSC node expect
 * 30 s – 3 min. So:
 *
 *   - ffmpeg reads the original over a presigned GET URL. It is never
 *     downloaded, because nobody knows how much temporary disk the runner has.
 *     Only the output, a fraction of the original's size, is written locally.
 *   - One job at a time, two threads, lowest CPU priority: a live broadcast
 *     must not notice a clip being transcoded.
 *   - It runs in the background. No request waits for it; the admin view
 *     asks for the clip's status instead.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { setPriority } from "node:os";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { extractSegmentFrame } from "./mp4-converter.js";
import { originalKey, sponsorPrefix, type SponsorRegistry } from "./sponsors.js";

const require = createRequire(import.meta.url);
const ffmpegPath: string = require("ffmpeg-static");

/** Longest a single clip may take before it is given up. */
const TRANSCODE_TIMEOUT_MS = 20 * 60_000;
/** Longest sponsor clip accepted, so a full match uploaded by mistake does not run for an hour. */
export const MAX_CLIP_SECONDS = 5 * 60;

export interface TranscodeResult {
  /** Files to store under sponsors/<id>/, by name. */
  files: { name: string; body: Buffer; contentType: string }[];
  durationSeconds: number;
}

/**
 * ffmpeg arguments: whatever comes in, 1080p30 H.264 + AAC as 4 s HLS segments
 * comes out. Exported for the tests.
 */
export function transcodeArgs(input: string, outDir: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-y",
    "-i", input,
    // First video stream, and the first audio stream if there is one.
    "-map", "0:v:0", "-map", "0:a:0?",
    "-t", String(MAX_CLIP_SECONDS),
    // Never larger than 1080p, never upscaled, even dimensions for H.264.
    "-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
    "-fpsmax", "30",
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high",
    "-b:v", "5M", "-maxrate", "5M", "-bufsize", "10M",
    // A keyframe every 4 s at 30 fps, so every segment starts on one.
    "-g", "120", "-keyint_min", "120", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
    "-threads", "2",
    "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
    "-hls_segment_filename", join(outDir, "seg_%05d.ts"),
    join(outDir, "index.m3u8"),
  ];
}

/** Sum of the EXTINF durations in a playlist. */
export function playlistDuration(manifest: string): number {
  let total = 0;
  for (const m of manifest.matchAll(/#EXTINF:([\d.]+)/g)) total += parseFloat(m[1]);
  return Math.round(total * 10) / 10;
}

/** The last lines ffmpeg wrote, for the log when it fails. */
function tail(text: string, lines = 8): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    if (child.pid) {
      try { setPriority(child.pid, 19); } catch { /* not allowed here: run at normal priority */ }
    }
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), TRANSCODE_TIMEOUT_MS);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(signal === "SIGKILL" ? "Bearbetningen tog för lång tid." : `ffmpeg avslutades med ${code}:\n${tail(stderr)}`));
    });
  });
}

/**
 * Transcode one original, read from `inputUrl`, into HLS and a thumbnail.
 * Nothing is stored here; the caller decides what to do with the files.
 */
export async function transcodeSponsorClip(inputUrl: string): Promise<TranscodeResult> {
  const workDir = join(tmpdir(), `sponsor-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(workDir, { recursive: true });
  try {
    await runFfmpeg(transcodeArgs(inputUrl, workDir));

    const manifest = await readFile(join(workDir, "index.m3u8"), "utf8");
    const durationSeconds = playlistDuration(manifest);
    const segments = (await readdir(workDir)).filter((f) => f.endsWith(".ts")).sort();
    if (segments.length === 0 || durationSeconds <= 0) throw new Error("Filen innehöll ingen video.");

    const files: TranscodeResult["files"] = [];
    for (const name of segments) {
      files.push({ name, body: await readFile(join(workDir, name)), contentType: "video/mp2t" });
    }
    files.push({ name: "index.m3u8", body: Buffer.from(manifest), contentType: "application/vnd.apple.mpegurl" });

    // A frame for the admin list. Not having one is no reason to fail the clip.
    try {
      files.push({ name: "thumb.jpg", body: await extractSegmentFrame(files[0].body, 640), contentType: "image/jpeg" });
    } catch { /* the admin list shows a placeholder */ }

    return { files, durationSeconds };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

interface QueueStorage {
  presignGet(key: string, expiresInSeconds?: number): Promise<string>;
  uploadBuffer(key: string, body: Buffer | string, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

interface Logger {
  info(msg: string): void;
  warn(obj: unknown, msg?: string): void;
}

/**
 * One clip at a time, in the order they were uploaded. The status of each
 * clip lives in the registry, so the admin view sees queued → processing →
 * ready or failed.
 */
export class SponsorTranscodeQueue {
  private pending: string[] = [];
  private running: Promise<void> | null = null;

  constructor(
    private readonly registry: SponsorRegistry,
    private readonly storage: QueueStorage,
    private readonly log: Logger,
    private readonly transcode: (inputUrl: string) => Promise<TranscodeResult> = transcodeSponsorClip,
  ) {}

  /** Put a clip in line. A clip already in line is not added twice. */
  enqueue(id: string): void {
    if (!this.pending.includes(id)) this.pending.push(id);
    this.running ??= this.drain().finally(() => { this.running = null; });
  }

  /** Resolves when the queue is empty. For the tests and for shutdown. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** At start-up: a clip cut off by the restart is failed, queued ones go back in line. */
  async resume(): Promise<void> {
    for (const clip of await this.registry.recoverAfterRestart()) this.enqueue(clip.id);
  }

  private async drain(): Promise<void> {
    for (let id = this.pending.shift(); id; id = this.pending.shift()) {
      await this.process(id);
    }
  }

  private async process(id: string): Promise<void> {
    const clip = await this.registry.get(id);
    if (!clip || clip.status !== "queued") return;
    await this.registry.patch(id, { status: "processing" });
    const started = Date.now();

    try {
      // Long enough to outlast the slowest transcode, since ffmpeg reads as it goes.
      const url = await this.storage.presignGet(originalKey(id), 3 * 3600);
      const result = await this.transcode(url);

      // The admin may have deleted the clip while it was transcoding.
      if (!(await this.registry.get(id))) {
        await this.storage.deletePrefix(sponsorPrefix(id));
        return;
      }
      for (const f of result.files) {
        await this.storage.uploadBuffer(`${sponsorPrefix(id)}${f.name}`, f.body, f.contentType);
      }
      await this.storage.deleteObject(originalKey(id)).catch(() => {});
      await this.registry.patch(id, { status: "ready", durationSeconds: result.durationSeconds });
      this.log.info(`Sponsor clip ${id} ready: ${result.durationSeconds} s in ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (err) {
      this.log.warn(err, `Sponsor clip ${id} failed`);
      await this.storage.deleteObject(originalKey(id)).catch(() => {});
      await this.registry
        .patch(id, { status: "failed", error: "Klippet kunde inte bearbetas. Prova att exportera det som MP4 och ladda upp igen." })
        .catch(() => { /* deleted meanwhile */ });
    }
  }
}
