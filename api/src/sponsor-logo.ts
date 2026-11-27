/**
 * A sponsor's logo, scaled down by ffmpeg (#128).
 *
 * The admin view already shrinks the picture in the browser, but the API
 * cannot trust that: whatever came in is decoded and written anew as a PNG
 * of at most 512 px. A file that only claims to be an image fails here.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ffmpegPath: string = require("ffmpeg-static");

export const LOGO_MAX_PX = 512;
const TIMEOUT_MS = 30_000;

/** Never upscaled, the aspect ratio kept, transparency kept. */
export function logoArgs(input: string, output: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", input,
    "-vf", `scale=w='min(${LOGO_MAX_PX},iw)':h='min(${LOGO_MAX_PX},ih)':force_original_aspect_ratio=decrease`,
    "-frames:v", "1",
    "-c:v", "png", "-pix_fmt", "rgba",
    output,
  ];
}

/** PNG, JPEG or WebP in, a PNG of at most 512 × 512 out. Throws when the file is not a picture ffmpeg can read. */
export async function scaleLogo(bytes: Buffer): Promise<Buffer> {
  const dir = join(tmpdir(), `sponsor-logo-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  try {
    const input = join(dir, "in");
    const output = join(dir, "out.png");
    await writeFile(input, bytes);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegPath, logoArgs(input, output), { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
      const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg avslutades med ${code}: ${stderr.trim()}`));
      });
    });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
