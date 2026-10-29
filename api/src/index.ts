import "dotenv/config";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import { config, validateConfig } from "./config.js";
import { clubManifest } from "./club-config.js";
import { initServices, streamMeta, collectors } from "./state.js";
import { restoreStreamMeta } from "./stream-meta-store.js";
import { SegmentCollector } from "./segment-collector.js";
import { RestreamerClient } from "./restreamer.js";
import { OscInstanceManager } from "./osc-manager.js";
import { MinioClient } from "./minio.js";

// Route plugins
import authRoutes from "./routes/auth-routes.js";
import streamRoutes from "./routes/streams.js";
import vodRoutes from "./routes/vod.js";
import adminRoutes from "./routes/admin.js";
import restreamerRoutes from "./routes/restreamer-routes.js";
import broadcastRoutes from "./routes/broadcast-routes.js";
import clipRoutes from "./routes/clip-routes.js";
import clubRoutes from "./routes/club-routes.js";
import mediaRoutes from "./routes/media.js";
import deviceRoutes from "./routes/device-routes.js";
import dvrRoutes from "./routes/dvr.js";
import webRoutes, { webDistDir } from "./routes/web.js";
import setupRoutes from "./routes/setup-routes.js";
import { Setup } from "./setup.js";
import { Branding } from "./club-branding.js";

// --- Validate required env vars (exits on failure) ---
validateConfig();

// --- Log the installation's identity (no secrets) ---
console.log(
  `${clubManifest.name} — tenant: ${config.OSC_TENANT}, Restreamer (until OSC reports its address): ${config.RESTREAMER_URL}`
);

// --- Create service instances ---

const restreamer = new RestreamerClient(config.RESTREAMER_URL, config.OSC_RESTREAMER_TOKEN, "");
const minio = new MinioClient(config.MINIO_ENDPOINT, config.MINIO_ACCESS_KEY, config.MINIO_SECRET_KEY);
const oscManager = new OscInstanceManager({
  instanceName: config.OSC_INSTANCE_NAME,
  personalAccessToken: config.OSC_RESTREAMER_TOKEN,
  gracePeriodMs: config.RESTREAMER_GRACE_PERIOD_MS,
  logger: undefined as unknown as { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  s3Config: {
    endpoint: config.MINIO_ENDPOINT.replace(/^https?:\/\//, ""),
    accessKeyId: config.MINIO_ACCESS_KEY,
    secretAccessKey: config.MINIO_SECRET_KEY,
    bucket: config.MINIO_RECORDINGS_BUCKET,
  },
  onInstanceReady: (info) => {
    restreamer.useInstanceUrl(info.url);
    restreamer.rtmpHost = info.rtmpHost;
  },
});

// --- Expose services to route modules ---
initServices(restreamer, minio, oscManager);

const setup = new Setup(minio, config.SETUP_CODE);
const branding = new Branding(minio);

// --- Fastify setup ---

const app = Fastify({ logger: true });

// Patch logger into oscManager (needs app.log which is only available after Fastify creation)
(oscManager as unknown as { log: unknown }).log = app.log;

// Allowed origins: the configured public site, any extra CORS_ORIGINS, and
// localhost for development.  An installation that sets neither is reachable
// from localhost only, which is a safe default rather than a silent wildcard.
const allowedOrigins: (string | RegExp)[] = [
  ...(config.PUBLIC_SITE_URL ? [config.PUBLIC_SITE_URL] : []),
  ...config.CORS_ORIGINS,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

await app.register(cors, {
  origin: allowedOrigins,
  methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
});
await app.register(rateLimit, { global: false });

// --- Register route plugins ---
await app.register(authRoutes);
await app.register(streamRoutes);
await app.register(vodRoutes);
await app.register(adminRoutes);
await app.register(restreamerRoutes);
await app.register(broadcastRoutes);
await app.register(clipRoutes);
await app.register(clubRoutes, { branding });
await app.register(mediaRoutes);
await app.register(deviceRoutes);
await app.register(dvrRoutes);
await app.register(setupRoutes, { setup });

const webRoot = webDistDir();
if (webRoot) {
  await app.register(webRoutes, { root: webRoot });
  console.log(`Serving the website from ${webRoot}`);
} else {
  console.log("No built website found — serving the API only");
}

// The release this installation runs: the repository root's package.json,
// whose version is bumped in the commit each vX.Y.Z tag points to.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "unknown";
  }
})();

// --- Health check ---
app.get("/health", async () => {
  const restreamerState = oscManager.getState();
  const minioReachable = await minio
    .readVodIndex()
    .then(() => true)
    .catch(() => false);

  return {
    status: "ok",
    version: VERSION,
    components: {
      restreamer: restreamerState,
      minio: minioReachable ? "ok" : "unreachable",
    },
    activeStreams: oscManager.getActiveStreamCount(),
    uptime: process.uptime(),
  };
});

// --- Token cleanup timer ---

// --- Startup ---

// Ensure MinIO recordings bucket exists
try {
  await minio.ensureBucket();
  console.log("MinIO recordings bucket ready");
} catch (err) {
  console.error("Failed to initialize MinIO bucket (VOD will be unavailable):", err);
}

// Restore the PINs chosen at first-run setup, or open setup.  Before listening,
// so no request is ever answered with the wrong PINs.
try {
  await setup.load();
  if (setup.isRequired()) console.log("Waiting for first-run setup — open the website with the setup code");
} catch (err) {
  // Storage unreachable: keep setup closed rather than guess.  Admin stays
  // locked (no PIN) until storage is back and the process restarts.
  console.error("Could not read setup state:", err);
}

// The look the club chose in the admin view. Without it the environment's
// values stand, which is a fine way to fail.
try {
  await branding.load();
} catch (err) {
  console.error("Could not read club branding:", err);
}

// Start background health polling for Restreamer
oscManager.startBackgroundPolling();

// --- Recover streams that were running when this process last stopped ---
//
// A redeploy or crash during a match used to leave the segments in storage with
// nothing that knew how to assemble them. Metadata and each part's timeline are
// checkpointed, so both the stitching and the collection can carry on.
try {
  const restored = await restoreStreamMeta(minio, app.log);
  for (const streamId of restored) {
    const meta = streamMeta.get(streamId);
    if (!meta) continue;
    if (meta.pausedAt) {
      // A paused stream resumes on request. Count it, so the instance it is
      // waiting on is not shut down as idle.
      oscManager.streamPaused();
      continue;
    }

    const timeline = await SegmentCollector.readCheckpoint(minio, streamId, meta.partNumber);
    const collector = new SegmentCollector(
      streamId,
      () => restreamer.baseUrlValue,
      minio,
      app.log,
      meta.partNumber,
      timeline,
    );
    collector.start();
    collectors.set(streamId, collector);
  }
} catch (err) {
  app.log.error(err, "Stream recovery failed — previous recordings may need manual stitching");
}

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.log(`Courtside API running on port ${config.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
