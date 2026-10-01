/**
 * `npm run preflight` — check an installation without starting it.
 *
 * Printed for a person who has just deployed the kit and wants to know whether
 * it will work, so the output names the problem and what to do, not a stack
 * trace.
 */
import "dotenv/config";
import { config, validateConfig } from "./config.js";
import { MinioClient } from "./minio.js";
import { runPreflight, overallStatus, type CheckResult } from "./preflight.js";

const SYMBOL: Record<CheckResult["status"], string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
};

// Exits with a list of what is missing when required values are absent.
validateConfig();

const minio = new MinioClient(
  config.MINIO_ENDPOINT,
  config.MINIO_ACCESS_KEY,
  config.MINIO_SECRET_KEY
);

console.log("\nCourtside preflight\n");

const results = await runPreflight(minio);

for (const r of results) {
  console.log(`  ${SYMBOL[r.status]}  ${r.title}`);
  console.log(`     ${r.detail}`);
  if (r.fix) console.log(`     → ${r.fix}`);
  console.log("");
}

const overall = overallStatus(results);
const failed = results.filter((r) => r.status === "fail").length;
const warned = results.filter((r) => r.status === "warn").length;

if (overall === "fail") {
  console.log(`${failed} kontroll(er) misslyckades. Installationen fungerar inte ännu.\n`);
  process.exit(1);
} else if (overall === "warn") {
  console.log(`Allt nödvändigt fungerar. ${warned} sak(er) bör ses över.\n`);
  process.exit(0);
} else {
  console.log("Allt ser bra ut.\n");
  process.exit(0);
}
