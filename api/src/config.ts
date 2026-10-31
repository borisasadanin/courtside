/**
 * Centralized configuration — all env vars, constants, and validation.
 *
 * Nothing in here has a tenant-, club- or deployment-specific default.  Every
 * value that identifies *a particular installation* must come from the
 * environment, and the process refuses to start without the required ones.
 * That is what makes this codebase deployable by anyone.
 */

// --- Helpers ---

function required(name: string): string {
  const value = process.env[name];
  if (!value) missing.push(name);
  return value || "";
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** Collected during module evaluation, reported by validateConfig(). */
const missing: string[] = [];

// --- Runtime ---

const PORT = parseInt(process.env.PORT || "8000", 10);

// --- Credentials (no defaults — ever) ---

/** Shared secret for the camera app. Generated at install time. */
const API_KEY = required("API_KEY");
/**
 * One-time code that opens first-run setup, where the club chooses its own
 * PINs.  Generated at install time.  See setup.ts.
 */
const SETUP_CODE = process.env.SETUP_CODE || "";
/**
 * Admin PIN for the website's admin view.  Not required when SETUP_CODE is
 * set: the club chooses it during setup instead.
 */
const ADMIN_PIN = SETUP_CODE ? process.env.ADMIN_PIN || "" : required("ADMIN_PIN");
/** Viewer PIN. Empty means open access (allowed, but warned about). */
const VIEWER_PIN = process.env.VIEWER_PIN || "";

// --- OSC (Open Source Cloud) ---

const OSC_PAT = required("OSC_ACCESS_TOKEN");
/** OSC tenant that owns the Restreamer instance, e.g. "myclub". */
const OSC_TENANT = required("OSC_TENANT");
/** Separate token for the Restreamer tenant, if it differs from the main one. */
const OSC_RESTREAMER_TOKEN = optional("OSC_RESTREAMER_TOKEN", OSC_PAT);
/** Name of the Restreamer instance to create/manage on demand. */
const OSC_INSTANCE_NAME = optional("OSC_INSTANCE_NAME", "restreamer");
/** OSC region suffix, e.g. "prod" or "prod-se". */
const OSC_REGION = optional("OSC_REGION", "prod");

/**
 * Restreamer base URL.  Derived from tenant + instance + region unless given
 * explicitly, because OSC hostnames follow a fixed pattern.
 */
const RESTREAMER_URL = optional(
  "RESTREAMER_URL",
  `https://${OSC_TENANT}-${OSC_INSTANCE_NAME}.datarhei-restreamer.auto.${OSC_REGION}.osaas.io`
);

/**
 * Prefix for Restreamer process IDs.  Scopes this installation's processes so
 * listManagedProcesses() never picks up anything else running on the instance.
 */
const PROCESS_PREFIX = optional("PROCESS_PREFIX", "cs-");

const RESTREAMER_GRACE_PERIOD_MS = parseInt(
  process.env.RESTREAMER_GRACE_PERIOD_MS || String(15 * 60 * 1000),
  10
);

// --- Object storage (S3/MinIO) ---

const MINIO_ENDPOINT = required("MINIO_ENDPOINT");
const MINIO_ACCESS_KEY = required("MINIO_ACCESS_KEY");
const MINIO_SECRET_KEY = required("MINIO_SECRET_KEY");
const MINIO_RECORDINGS_BUCKET = optional("STORAGE_BUCKET", "recordings");
const MINIO_STORAGE_CAPACITY_GB = parseInt(
  process.env.MINIO_STORAGE_CAPACITY_GB || "50",
  10
);

// --- Public web ---

/** Public origin of the website, e.g. "https://live.myclub.se". No trailing slash. */
const PUBLIC_SITE_URL = optional("PUBLIC_SITE_URL", "").replace(/\/$/, "");

/**
 * Allowed CORS origins.  Comma-separated.  PUBLIC_SITE_URL is always allowed,
 * and localhost is allowed for development.
 */
const CORS_ORIGINS = optional("CORS_ORIGINS", "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

// --- Sessions ---

const VIEWER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STOPPED_TTL_MS = 10 * 60 * 1000; // 10 minutes

// --- Validation ---

export function validateConfig(): void {
  if (missing.length > 0) {
    console.error(
      `Missing required environment variables: ${missing.join(", ")}\n` +
        `See .env.example for what each one means.`
    );
    process.exit(1);
  }

  if (!VIEWER_PIN) {
    console.warn("VIEWER_PIN not set — anyone with the link can watch.");
  }
  if (!PUBLIC_SITE_URL) {
    console.warn(
      "PUBLIC_SITE_URL not set — share links and social previews will be incomplete."
    );
  }
}

export const config = {
  PORT,
  API_KEY,
  SETUP_CODE,
  ADMIN_PIN,
  VIEWER_PIN,
  OSC_PAT,
  OSC_TENANT,
  OSC_RESTREAMER_TOKEN,
  OSC_INSTANCE_NAME,
  OSC_REGION,
  RESTREAMER_URL,
  PROCESS_PREFIX,
  RESTREAMER_GRACE_PERIOD_MS,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_RECORDINGS_BUCKET,
  MINIO_STORAGE_CAPACITY_GB,
  PUBLIC_SITE_URL,
  CORS_ORIGINS,
  VIEWER_TOKEN_TTL_MS,
  ADMIN_TOKEN_TTL_MS,
  STOPPED_TTL_MS,
} as const;

/**
 * The PINs in force.  Mutable because PUT /api/auth/pin and first-run setup
 * change them at runtime; setup also restores them from storage at startup.
 */
export const mutableConfig = {
  ADMIN_PIN,
  VIEWER_PIN,
};
