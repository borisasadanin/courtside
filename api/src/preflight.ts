/**
 * Preflight — does this installation actually work?
 *
 * A club running the kit has nobody to ask when something is wrong, so the
 * installation has to say so itself.  Each check reports what it found and, if
 * it failed, what to do about it; a check never throws, because a broken
 * dependency is the thing being measured rather than a reason to stop.
 */
import { Context } from "@osaas/client-core";
import { config } from "./config.js";
import { clubManifest } from "./club-config.js";
import type { MinioClient } from "./minio.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it. Omitted when the check passed. */
  fix?: string;
}

const RESTREAMER_SERVICE_ID = "datarhei-restreamer";

/** Storage key used to probe writability. Removed again immediately. */
const PROBE_KEY = ".preflight-probe";

async function checkStorage(minio: MinioClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Read-only on purpose. ensureBucket() would delete a public policy, and a
  // check that repairs what it measures can only ever report success.
  if (await minio.bucketExists()) {
    results.push({
      id: "storage.bucket",
      title: "Lagringen svarar",
      status: "ok",
      detail: `Bucket "${config.MINIO_RECORDINGS_BUCKET}" finns på ${config.MINIO_ENDPOINT}`,
    });
  } else {
    return [
      {
        id: "storage.bucket",
        title: "Lagringen svarar",
        status: "fail",
        detail: `Hittade ingen bucket "${config.MINIO_RECORDINGS_BUCKET}" på ${config.MINIO_ENDPOINT}`,
        fix: "Kontrollera MINIO_ENDPOINT, MINIO_ACCESS_KEY och MINIO_SECRET_KEY. Bucketen skapas när backend startar.",
      },
    ];
  }

  const probeBody = `preflight ${new Date().toISOString()}`;
  try {
    await minio.uploadBuffer(PROBE_KEY, probeBody, "text/plain");
    results.push({
      id: "storage.writable",
      title: "Lagringen går att skriva till",
      status: "ok",
      detail: "Testobjekt skrevs och lästes tillbaka",
    });
  } catch (err) {
    results.push({
      id: "storage.writable",
      title: "Lagringen går att skriva till",
      status: "fail",
      detail: message(err),
      fix: "Nyckeln saknar skrivrättighet. Inspelning och klipp kommer inte att fungera.",
    });
    return results;
  }

  // The one that matters most: recordings of children must not be world-readable.
  try {
    const res = await fetch(
      `${config.MINIO_ENDPOINT}/${config.MINIO_RECORDINGS_BUCKET}/${PROBE_KEY}`
    );
    if (res.ok) {
      results.push({
        id: "storage.private",
        title: "Inspelningarna är inte publika",
        status: "fail",
        detail: "Ett objekt kunde läsas utan autentisering",
        fix: "Ta bort bucketens publika läspolicy. Starta om backend — den tar bort policyn vid uppstart.",
      });
    } else {
      results.push({
        id: "storage.private",
        title: "Inspelningarna är inte publika",
        status: "ok",
        detail: `Osignerad läsning nekas (HTTP ${res.status})`,
      });
    }
  } catch {
    results.push({
      id: "storage.private",
      title: "Inspelningarna är inte publika",
      status: "warn",
      detail: "Kunde inte avgöra — lagringen svarade inte på en osignerad förfrågan",
    });
  }

  try {
    await minio.deleteObject(PROBE_KEY);
  } catch {
    // The probe is tiny and harmless if it lingers.
  }

  return results;
}

async function checkOsc(): Promise<CheckResult[]> {
  if (!config.OSC_PAT) {
    return [
      {
        id: "osc.token",
        title: "OSC-token fungerar",
        status: "fail",
        detail: "OSC_ACCESS_TOKEN saknas",
        fix: "Skapa en Personal Access Token på app.osaas.io och lägg in den i konfigurationen.",
      },
    ];
  }

  try {
    const ctx = new Context({ personalAccessToken: config.OSC_RESTREAMER_TOKEN });
    await ctx.getServiceAccessToken(RESTREAMER_SERVICE_ID);
    return [
      {
        id: "osc.token",
        title: "OSC-token fungerar",
        status: "ok",
        detail: `Tjänstetoken hämtad för tenant ${config.OSC_TENANT}`,
      },
    ];
  } catch (err) {
    return [
      {
        id: "osc.token",
        title: "OSC-token fungerar",
        status: "fail",
        detail: message(err),
        fix: "Token är ogiltig, utgången eller saknar rättighet till datarhei-restreamer.",
      },
    ];
  }
}

function checkConfiguration(): CheckResult[] {
  const results: CheckResult[] = [];

  results.push(
    config.VIEWER_PIN
      ? {
          id: "access.viewerPin",
          title: "Tittarskydd är påslaget",
          status: "ok",
          detail: "En kod krävs för att se sändningar",
        }
      : {
          id: "access.viewerPin",
          title: "Tittarskydd är påslaget",
          status: "warn",
          detail: "VIEWER_PIN är tom — vem som helst med länken kan titta",
          fix: "Sätt VIEWER_PIN. Det här är oftast ungdomsidrott.",
        }
  );

  results.push(
    config.PUBLIC_SITE_URL
      ? {
          id: "web.siteUrl",
          title: "Publik webbadress är satt",
          status: "ok",
          detail: config.PUBLIC_SITE_URL,
        }
      : {
          id: "web.siteUrl",
          title: "Publik webbadress är satt",
          status: "warn",
          detail: "PUBLIC_SITE_URL saknas",
          fix: "Delningslänkar och förhandsvisningar i sociala medier blir ofullständiga utan den.",
        }
  );

  results.push({
    id: "club.identity",
    title: "Klubbidentitet är ifylld",
    status: clubManifest.name && clubManifest.name !== "Courtside" ? "ok" : "warn",
    detail: `Namn: ${clubManifest.name}${clubManifest.venue ? `, hall: ${clubManifest.venue}` : ""}`,
    fix:
      clubManifest.name === "Courtside"
        ? "Sätt CLUB_NAME så att hemsidan visar klubbens namn i stället för produktnamnet."
        : undefined,
  });

  return results;
}

export async function runPreflight(minio: MinioClient): Promise<CheckResult[]> {
  const [storage, osc] = await Promise.all([checkStorage(minio), checkOsc()]);
  return [...checkConfiguration(), ...storage, ...osc];
}

/** Worst status across all checks, for an exit code or a summary line. */
export function overallStatus(results: CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "ok";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
