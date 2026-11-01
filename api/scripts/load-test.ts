/**
 * Capacity test for parallel matches (ABL-051).
 *
 * Plays several cameras against one installation at once: creates the streams
 * the way the camera app does, pushes synthetic video and audio to each with
 * ffmpeg, and records what viewers would get — each stream's status, how far
 * the DVR trails real time, how long a highlight takes, and whether the page's
 * status stays live while one match pauses. Midway it pauses and resumes one
 * stream; at the end it stops them all and prints a summary.
 *
 *   COURTSIDE_URL=https://… COURTSIDE_DEVICE_TOKEN=… npx tsx scripts/load-test.ts
 *
 * It starts the broadcast engine if it is off, and every stream becomes a real
 * recording. See docs/load-test.md before running it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const ffmpegPath: string = require("ffmpeg-static");

// --- Settings ---

function setting(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    console.error(`${name} is not set. See docs/load-test.md.`);
    process.exit(2);
  }
  return value;
}

function numberSetting(name: string, fallback: number): number {
  const value = Number(setting(name, String(fallback)));
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${name} must be a positive number`);
    process.exit(2);
  }
  return value;
}

const BASE_URL = setting("COURTSIDE_URL").replace(/\/+$/, "");
const DEVICE_TOKEN = setting("COURTSIDE_DEVICE_TOKEN");
const VIEWER_PIN = process.env.COURTSIDE_VIEWER_PIN;
const STREAMS = Math.round(numberSetting("LOAD_TEST_STREAMS", 2));
const MINUTES = numberSetting("LOAD_TEST_MINUTES", 30);
const BITRATE_KBPS = Math.round(numberSetting("LOAD_TEST_BITRATE_KBPS", 3000));
const SIZE = setting("LOAD_TEST_SIZE", "1920x1080");
const PRESET = setting("LOAD_TEST_PRESET", "veryfast");
const SAMPLE_SECONDS = numberSetting("LOAD_TEST_SAMPLE_SECONDS", 15);
const CLIP_SECONDS = numberSetting("LOAD_TEST_CLIP_SECONDS", 120);
const PAUSE_SECONDS = numberSetting("LOAD_TEST_PAUSE_SECONDS", 60);
const OUT_FILE = process.env.LOAD_TEST_OUT;

// Älta's own platform is production and never a test target.
if (/altabasket/i.test(BASE_URL)) {
  console.error("Refusing to load-test Älta's platform. Use an installation made for testing.");
  process.exit(2);
}
if (!/^\d+x\d+$/.test(SIZE)) {
  console.error("LOAD_TEST_SIZE must look like 1920x1080");
  process.exit(2);
}

// --- What is recorded ---

interface Sample {
  at: number;
  status: string;
  /** Seconds between now and the newest segment in the DVR playlist */
  dvrLagSeconds?: number;
  dvrSegments?: number;
  responseMs: number;
}

interface ClipResult {
  at: number;
  ms: number;
  httpStatus: number;
  durationSeconds?: number;
  burst: boolean;
  error?: string;
}

interface TestStream {
  n: number;
  id: string;
  rtmpUrl: string;
  ffmpeg?: ChildProcess;
  pushing: boolean;
  pushStartedAt?: number;
  pushedMs: number;
  ffmpegRestarts: number;
  paused: boolean;
  clipInFlight: boolean;
  samples: Sample[];
  clips: ClipResult[];
  recording?: { seconds: number; segments: number } | { error: string };
}

interface InstallationSample {
  at: number;
  broadcast: string;
  anyStreamLive: boolean;
  apiActiveStreams?: number;
  apiMemoryMb?: number;
  engine?: string;
}

const streams: TestStream[] = [];
const installation: InstallationSample[] = [];
const pauseResult: { pauseMs?: number; resumeMs?: number; liveAgainMs?: number; error?: string } = {};
const stopMs: number[] = [];
let viewerToken: string | null = null;
let stopping = false;

const startedAt = Date.now();
const runId = startedAt.toString(36);

function log(message: string): void {
  console.log(`[${new Date().toTimeString().slice(0, 8)}] ${message}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- HTTP ---

interface Answer {
  status: number;
  ms: number;
  text: string;
  json: any;
}

/** One API call, as the camera (device token) or as a viewer (viewer token). */
async function api(
  method: string,
  path: string,
  options: { body?: unknown; asViewer?: boolean; timeoutMs?: number } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (options.asViewer) {
    if (viewerToken) headers.Authorization = `Bearer ${viewerToken}`;
  } else {
    headers["X-Device-Token"] = DEVICE_TOKEN;
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const started = Date.now();
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Playlists and empty bodies are not JSON
    }
    return { status: res.status, ms: Date.now() - started, text, json };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, text: String(err), json: null };
  }
}

// --- Setup ---

async function ensureEngine(): Promise<void> {
  let res = await api("GET", "/api/restreamer/status");
  if (res.status === 401) throw new Error("The device token was not accepted (401). Pair a camera and use its token.");
  if (res.status !== 200) throw new Error(`GET /api/restreamer/status answered ${res.status}: ${res.text}`);
  if (res.json?.state === "running") return;

  log(`Broadcast engine is ${res.json?.state}; starting it (takes 1-3 minutes)`);
  await api("POST", "/api/restreamer/start");
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    await sleep(10_000);
    res = await api("GET", "/api/restreamer/status");
    if (res.json?.state === "running") return;
    log(`  engine: ${res.json?.state ?? res.status}`);
  }
  throw new Error("The broadcast engine did not start within 6 minutes");
}

/** A viewer token for the DVR and recording checks; without one those are skipped. */
async function getViewerToken(): Promise<string | null> {
  const res = await api("POST", "/api/auth/verify", { body: VIEWER_PIN ? { pin: VIEWER_PIN } : {} });
  if (res.status === 200 && typeof res.json?.token === "string") return res.json.token;
  log(`No viewer access (${res.status}); set COURTSIDE_VIEWER_PIN to measure DVR lag and check the recordings`);
  return null;
}

async function createStream(n: number): Promise<TestStream> {
  const body = { name: `Lasttest ${n}`, deviceId: `load-test-${runId}-${n}`, team: "Lasttest", opponent: `Lag ${n}` };
  for (let attempt = 1; attempt <= 10; attempt++) {
    const res = await api("POST", "/api/streams", { body });
    if (res.status === 201 || res.status === 200) {
      log(`Stream ${n}: ${res.json.id} (${res.ms} ms)`);
      return {
        n,
        id: res.json.id,
        rtmpUrl: res.json.rtmpUrl,
        pushing: false,
        pushedMs: 0,
        ffmpegRestarts: 0,
        paused: false,
        clipInFlight: false,
        samples: [],
        clips: [],
      };
    }
    if (res.status !== 409) throw new Error(`POST /api/streams answered ${res.status}: ${res.text}`);
    log(`Stream ${n}: engine not ready (${res.json?.message ?? "409"}), retrying in 15 s`);
    await sleep(15_000);
  }
  throw new Error(`Stream ${n} could not be created`);
}

// --- Pushing video ---

/** Synthetic camera: moving test picture and a tone, phone-like H.264/AAC over RTMP. */
function startPush(s: TestStream): void {
  const args = [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", `testsrc2=size=${SIZE}:rate=30`,
    "-f", "lavfi", "-i", `sine=frequency=${330 + 110 * s.n}:sample_rate=48000`,
    "-c:v", "libx264", "-preset", PRESET, "-tune", "zerolatency", "-profile:v", "main", "-pix_fmt", "yuv420p",
    "-b:v", `${BITRATE_KBPS}k`, "-maxrate", `${BITRATE_KBPS}k`, "-bufsize", `${BITRATE_KBPS * 2}k`,
    // A keyframe every 2 s, like the app; Restreamer cuts 2 s segments without re-encoding.
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
    "-f", "flv", s.rtmpUrl,
  ];
  const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  let lastError = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    lastError = chunk.toString().trim().split("\n").at(-1) ?? lastError;
  });
  s.ffmpeg = child;
  s.pushing = true;
  s.pushStartedAt = Date.now();

  child.on("exit", (code) => {
    if (s.pushStartedAt) s.pushedMs += Date.now() - s.pushStartedAt;
    s.pushStartedAt = undefined;
    if (s.ffmpeg !== child || !s.pushing || stopping) return;
    // Lost connection: come back like the app does
    s.ffmpegRestarts++;
    log(`Stream ${s.n}: ffmpeg exited (${code}) ${lastError}; reconnecting in 3 s`);
    setTimeout(() => {
      if (s.pushing && !stopping && s.ffmpeg === child) startPush(s);
    }, 3_000);
  });
}

function stopPush(s: TestStream): void {
  s.pushing = false;
  s.ffmpeg?.kill("SIGINT");
}

// --- Measuring ---

function parsePlaylist(text: string): { segments: number; seconds: number; newestAt?: number } {
  let segments = 0;
  let seconds = 0;
  let newestAt: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("#EXTINF:")) {
      segments++;
      seconds += parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      newestAt = Date.parse(line.slice(25));
    }
  }
  return { segments, seconds, newestAt };
}

async function sample(): Promise<void> {
  const at = Date.now();
  const [broadcast, health] = await Promise.all([api("GET", "/api/broadcast"), api("GET", "/health")]);

  await Promise.all(
    streams.map(async (s) => {
      const res = await api("GET", `/api/streams/${s.id}`);
      const entry: Sample = { at, status: res.json?.status ?? `http ${res.status}`, responseMs: res.ms };
      if (viewerToken && !s.paused) {
        const dvr = await api("GET", `/api/streams/${s.id}/dvr.m3u8`, { asViewer: true });
        if (dvr.status === 200) {
          const playlist = parsePlaylist(dvr.text);
          entry.dvrSegments = playlist.segments;
          if (playlist.newestAt) entry.dvrLagSeconds = (Date.now() - playlist.newestAt) / 1000;
        }
      }
      s.samples.push(entry);
    }),
  );

  const anyStreamLive = streams.some((s) => s.samples.at(-1)?.status === "live");
  const record: InstallationSample = {
    at,
    broadcast: broadcast.json?.status ?? `http ${broadcast.status}`,
    anyStreamLive,
    apiActiveStreams: health.json?.activeStreams,
    apiMemoryMb: health.json?.memoryMb,
    engine: health.json?.components?.restreamer,
  };
  installation.push(record);

  const perStream = streams
    .map((s) => {
      const last = s.samples.at(-1)!;
      const lag = last.dvrLagSeconds === undefined ? "" : ` lag ${last.dvrLagSeconds.toFixed(1)}s`;
      return `${s.n}:${last.status}${lag}`;
    })
    .join(" | ");
  const flag = anyStreamLive && record.broadcast !== "live" ? "  <-- page status not live" : "";
  const memory = record.apiMemoryMb === undefined ? "" : ` api=${record.apiMemoryMb}MB`;
  log(`page=${record.broadcast} engine=${record.engine} active=${record.apiActiveStreams}${memory} | ${perStream}${flag}`);
}

async function clip(s: TestStream, burst: boolean): Promise<void> {
  if (s.clipInFlight || s.paused || stopping) return;
  s.clipInFlight = true;
  const at = Date.now();
  const res = await api("POST", `/api/streams/${s.id}/clip`, {
    body: { timestamp: new Date(at).toISOString(), label: "Lasttest" },
    timeoutMs: 60_000,
  });
  s.clips.push({
    at,
    ms: res.ms,
    httpStatus: res.status,
    durationSeconds: res.json?.durationSeconds,
    burst,
    ...(res.status === 201 ? {} : { error: res.json?.message ?? res.text.slice(0, 120) }),
  });
  log(`Stream ${s.n}: clip ${res.status === 201 ? "made" : `failed (${res.status})`} in ${(res.ms / 1000).toFixed(1)} s${burst ? " [burst]" : ""}`);
  s.clipInFlight = false;
}

/** The camera's pause: tell the API, drop the connection, come back on the new URL. */
async function pauseAndResume(s: TestStream): Promise<void> {
  log(`Stream ${s.n}: pausing for ${PAUSE_SECONDS} s`);
  const paused = await api("PATCH", `/api/streams/${s.id}/pause`, { body: { type: "period" } });
  pauseResult.pauseMs = paused.ms;
  if (paused.status !== 200) {
    pauseResult.error = `pause answered ${paused.status}: ${paused.text}`;
    log(`Stream ${s.n}: ${pauseResult.error}`);
    return;
  }
  s.paused = true;
  stopPush(s);
  await sleep(PAUSE_SECONDS * 1000);
  if (stopping) return;

  const resumeStarted = Date.now();
  const resumed = await api("PATCH", `/api/streams/${s.id}/resume`);
  pauseResult.resumeMs = resumed.ms;
  if (resumed.status !== 200) {
    pauseResult.error = `resume answered ${resumed.status}: ${resumed.text}`;
    log(`Stream ${s.n}: ${pauseResult.error}`);
    return;
  }
  s.rtmpUrl = resumed.json.rtmpUrl ?? s.rtmpUrl;
  s.paused = false;
  startPush(s);

  while (!stopping && Date.now() - resumeStarted < 60_000) {
    const res = await api("GET", `/api/streams/${s.id}`);
    if (res.json?.status === "live") {
      pauseResult.liveAgainMs = Date.now() - resumeStarted;
      log(`Stream ${s.n}: live again ${(pauseResult.liveAgainMs / 1000).toFixed(1)} s after resume`);
      return;
    }
    await sleep(1000);
  }
  pauseResult.error = "not live again within 60 s of resume";
  log(`Stream ${s.n}: ${pauseResult.error}`);
}

async function stopAll(): Promise<void> {
  const exited = streams.map((s) =>
    s.ffmpeg && s.ffmpeg.exitCode === null && s.ffmpeg.signalCode === null
      ? new Promise((resolve) => {
          s.ffmpeg!.once("exit", resolve);
          setTimeout(resolve, 5_000);
        })
      : Promise.resolve(),
  );
  for (const s of streams) stopPush(s);
  await Promise.all(exited);
  await Promise.all(
    streams.map(async (s) => {
      const res = await api("DELETE", `/api/streams/${s.id}`);
      stopMs.push(res.ms);
      log(`Stream ${s.n}: stopped (${res.status}, ${res.ms} ms)`);
    }),
  );
}

/** Each recording should cover what was pushed, give or take the pause markers. */
async function checkRecordings(): Promise<void> {
  if (!viewerToken) return;
  log("Waiting 20 s for the recordings to be put together");
  await sleep(20_000);
  for (const s of streams) {
    const res = await api("GET", `/api/vod/${s.id}/playlist.m3u8`, { asViewer: true });
    if (res.status !== 200) {
      s.recording = { error: `GET /api/vod/${s.id}/playlist.m3u8 answered ${res.status}` };
      continue;
    }
    const { seconds, segments } = parsePlaylist(res.text);
    s.recording = { seconds, segments };
  }
}

// --- Summary ---

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const fmt = (v: number | undefined, unit = "s", digits = 1) => (v === undefined ? "–" : `${v.toFixed(digits)} ${unit}`);
const mmss = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

function summary(): string {
  const lines: string[] = [];
  lines.push("", "=== Load test summary ===");
  lines.push(`${BASE_URL}, ${streams.length} streams, ${SIZE} at ${BITRATE_KBPS} kbit/s, ran ${mmss(Date.now() - startedAt)}`);

  for (const s of streams) {
    const counts = new Map<string, number>();
    for (const x of s.samples) counts.set(x.status, (counts.get(x.status) ?? 0) + 1);
    const statuses = [...counts].map(([k, v]) => `${k} ${Math.round((100 * v) / s.samples.length)}%`).join(", ");
    const lags = s.samples.map((x) => x.dvrLagSeconds).filter((v): v is number => v !== undefined);
    const ok = s.clips.filter((c) => c.httpStatus === 201);
    const clipSeconds = ok.map((c) => c.ms / 1000);
    const failed = s.clips.length - ok.length;
    const recording = !s.recording
      ? "not checked"
      : "error" in s.recording
        ? s.recording.error
        : `${Math.round(s.recording.seconds)} s in ${s.recording.segments} segments`;

    lines.push("");
    lines.push(`Stream ${s.n} (${s.id}): pushed ${mmss(s.pushedMs)}, ffmpeg reconnects ${s.ffmpegRestarts}`);
    lines.push(`  status:     ${statuses || "no samples"}`);
    lines.push(`  DVR lag:    p50 ${fmt(percentile(lags, 50))}, p95 ${fmt(percentile(lags, 95))}, max ${fmt(percentile(lags, 100))}`);
    lines.push(`  clips:      ${ok.length} made, ${failed} failed; p50 ${fmt(percentile(clipSeconds, 50))}, max ${fmt(percentile(clipSeconds, 100))}`);
    for (const c of s.clips.filter((c) => c.httpStatus !== 201)) lines.push(`              failed ${c.httpStatus}: ${c.error}`);
    lines.push(`  recording:  ${recording}`);
  }

  const whileLive = installation.filter((x) => x.anyStreamLive);
  const wrong = whileLive.filter((x) => x.broadcast !== "live");
  const responses = streams.flatMap((s) => s.samples.map((x) => x.responseMs));
  const burst = streams.flatMap((s) => s.clips.filter((c) => c.burst && c.httpStatus === 201).map((c) => c.ms / 1000));

  lines.push("");
  lines.push(`Page status:  not "live" in ${wrong.length} of ${whileLive.length} samples while a stream was live`);
  lines.push(
    `Pause:        pause ${fmt(pauseResult.pauseMs, "ms", 0)}, resume ${fmt(pauseResult.resumeMs, "ms", 0)}, ` +
      `live again after ${fmt(pauseResult.liveAgainMs === undefined ? undefined : pauseResult.liveAgainMs / 1000)}` +
      (pauseResult.error ? ` (${pauseResult.error})` : ""),
  );
  lines.push(`Burst clips:  ${burst.length} at once, slowest ${fmt(percentile(burst, 100))}`);
  lines.push(`API:          GET /api/streams/:id p50 ${fmt(percentile(responses, 50), "ms", 0)}, p95 ${fmt(percentile(responses, 95), "ms", 0)}`);
  const memory = installation.map((x) => x.apiMemoryMb).filter((v): v is number => v !== undefined);
  lines.push(
    memory.length
      ? `API memory:   ${memory[0]} MB at start, ${Math.max(...memory)} MB at most, ${memory.at(-1)} MB at the end`
      : "API memory:   not reported (platform older than ABL-051)",
  );
  lines.push(`Stop:         slowest DELETE ${fmt(percentile(stopMs, 100), "ms", 0)}`);
  return lines.join("\n");
}

// --- Run ---

async function shutDown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await stopAll();
  await checkRecordings();
  console.log(summary());
  if (OUT_FILE) {
    const results = { settings: { BASE_URL, STREAMS, MINUTES, BITRATE_KBPS, SIZE, SAMPLE_SECONDS, CLIP_SECONDS, PAUSE_SECONDS }, streams: streams.map(({ ffmpeg: _ffmpeg, ...rest }) => rest), installation, pauseResult, stopMs };
    await writeFile(OUT_FILE, JSON.stringify(results, null, 2));
    log(`Results written to ${OUT_FILE}`);
  }
}

async function main(): Promise<void> {
  log(`Load test: ${STREAMS} streams for ${MINUTES} min against ${BASE_URL}`);
  await ensureEngine();
  viewerToken = await getViewerToken();

  for (let n = 1; n <= STREAMS; n++) streams.push(await createStream(n));
  for (const s of streams) startPush(s);

  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log("Interrupted; stopping every stream (Ctrl-C again to quit at once)");
  });

  const runMs = MINUTES * 60_000;
  const endAt = Date.now() + runMs;
  const pauseAt = Date.now() + runMs / 2 - (PAUSE_SECONDS * 1000) / 2;
  const burstAt = Date.now() + runMs * 0.75;
  const clipEveryMs = (CLIP_SECONDS * 1000) / STREAMS; // round robin: each stream every CLIP_SECONDS
  let nextSample = Date.now() + SAMPLE_SECONDS * 1000;
  let nextClip = Date.now() + Math.max(30_000, clipEveryMs);
  let clipTurn = 0;
  let pauseDone = false;
  let burstDone = false;

  while (!interrupted && Date.now() < endAt) {
    const now = Date.now();
    if (!pauseDone && now >= pauseAt && PAUSE_SECONDS * 1000 < runMs / 2) {
      pauseDone = true;
      void pauseAndResume(streams[0]);
    }
    if (!burstDone && now >= burstAt) {
      burstDone = true;
      log("Clip on every stream at once");
      for (const s of streams) void clip(s, true);
    }
    if (now >= nextClip) {
      nextClip += clipEveryMs;
      void clip(streams[clipTurn++ % streams.length], false);
    }
    if (now >= nextSample) {
      nextSample += SAMPLE_SECONDS * 1000;
      await sample();
    }
    await sleep(500);
  }

  await shutDown();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  if (streams.length) await shutDown();
  process.exit(1);
});
