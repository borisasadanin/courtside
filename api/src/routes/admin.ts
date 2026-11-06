/**
 * Admin routes: storage info, admin token verification.
 */
import type { FastifyInstance } from "fastify";
import { requireAdminAuth } from "../auth.js";
import { config } from "../config.js";
import { minio, oscManager, streamMeta } from "../state.js";
import { orphanClips, readDeletionLog } from "../erasure.js";
import { runPreflight, overallStatus } from "../preflight.js";
import { plan, removeData, removeSelf } from "../teardown.js";
import { NotNow, startUpdate, updateInfo } from "../update.js";
import { requestLang, say, type Text } from "../i18n.js";

const OSC_UNREACHABLE: Text = {
  sv: "Kunde inte nå Open Source Cloud. Försök igen om en stund.",
  en: "Could not reach Open Source Cloud. Try again in a while.",
};

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/admin/storage — Get storage usage info (admin)
  app.get("/api/admin/storage", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;

    try {
      const [entries, clips] = await Promise.all([minio.readVodIndex(), minio.readClipsIndex()]);
      const stoppedEntries = entries.filter((e) => e.stoppedAt);
      const storageInfo = await minio.getStorageInfo(stoppedEntries);
      const clipSummary = (c: (typeof clips)[number]) => ({ id: c.id, label: c.label, createdAt: c.createdAt, thumbnailUrl: c.thumbnailUrl });

      // Merge VOD metadata with size info
      const vods = stoppedEntries
        .map((entry) => {
          const sizeInfo = storageInfo.vods.find((v) => v.id === entry.id);
          return {
            ...entry,
            sizeBytes: sizeInfo?.sizeBytes || 0,
            clips: clips.filter((c) => c.streamId === entry.id).map(clipSummary),
          };
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      const capacityBytes = config.MINIO_STORAGE_CAPACITY_GB * 1024 * 1024 * 1024;

      return reply.send({
        totalBytes: storageInfo.totalBytes,
        capacityBytes,
        vodCount: vods.length,
        vods,
        // Clips left behind by a match deleted before clips went with it
        orphanClips: orphanClips(clips, new Set(entries.map((e) => e.id)), new Set(streamMeta.keys())).map(clipSummary),
      });
    } catch (err) {
      request.log.error(err, "Failed to get storage info");
      return reply.code(500).send({ error: "Failed to get storage info" });
    }
  });

  // GET /api/admin/deletions — What has been deleted, newest first (admin)
  app.get("/api/admin/deletions", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      return reply.send((await readDeletionLog(minio)).reverse());
    } catch (err) {
      request.log.error(err, "Failed to read the deletion log");
      return reply.code(500).send({ error: say(request, { sv: "Kunde inte läsa raderingsloggen", en: "Could not read the deletion log" }) });
    }
  });

  // GET /api/admin/preflight — Same checks as `npm run preflight`, from the admin view
  app.get("/api/admin/preflight", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;

    const checks = await runPreflight(minio);
    return reply.send({ status: overallStatus(checks), checks });
  });

  // GET /api/admin/platform — What removing the whole installation would remove
  app.get("/api/admin/platform", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      const p = await plan();
      if ("sv" in p) return reply.send({ removable: false, reason: say(request, p) });
      return reply.send({ removable: true, club: p.club, app: p.app.name, store: p.store, storage: p.storage, restreamer: p.restreamer });
    } catch (err) {
      request.log.error(err, "teardown plan failed");
      return reply.send({ removable: false, reason: say(request, OSC_UNREACHABLE) });
    }
  });

  // POST /api/admin/platform/delete — Remove the whole installation, recordings included.
  // The body must name the club's short name, typed by the admin.
  app.post<{ Body: { confirm?: string } }>("/api/admin/platform/delete", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    const p = await plan().catch(() => OSC_UNREACHABLE);
    if ("sv" in p) return reply.code(409).send({ error: say(request, p) });
    if (request.body?.confirm !== p.club) return reply.code(400).send({ error: say(request, { sv: `Skriv ${p.club} för att bekräfta.`, en: `Type ${p.club} to confirm.` }) });

    request.log.warn({ club: p.club }, "removing the whole installation on the admin's request");
    const lang = requestLang(request);
    const removed = await removeData(p, minio, lang);
    // Gone once the answer is sent, below.
    const after = (what: Text, detail: Text) => removed.push({ what: what[lang], ok: true, detail: detail[lang] });
    after({ sv: `Webbplatsen och servern (${p.app.name})`, en: `The website and the server (${p.app.name})` }, { sv: "tas bort nu", en: "being removed now" });
    after({ sv: `Adressen ${p.domain}`, en: `The address ${p.domain}` }, { sv: "frigörs nu", en: "being released now" });
    after({ sv: "Courtsides åtkomst till ert OSC-konto", en: "Courtside's access to your OSC account" }, { sv: "återkallas nu", en: "being revoked now" });
    reply.send({ club: p.club, removed });
    // After the answer is on its way: removing the app ends this process.
    setTimeout(() => void removeSelf(p, request.log), 1000);
  });

  // GET /api/admin/update — Which release this runs, and whether a newer one is out
  app.get("/api/admin/update", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    const info = await updateInfo();
    return reply.header("Cache-Control", "no-cache").send({ ...info, reason: info.reason && say(request, info.reason) });
  });

  // POST /api/admin/update — Rebuild from the newest release (site down a few minutes)
  app.post("/api/admin/update", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    try {
      const version = await startUpdate(oscManager.getActiveStreamCount());
      request.log.info({ version }, "update started from the admin view");
      return reply.code(202).send({ version });
    } catch (err) {
      if (err instanceof NotNow) return reply.code(409).send({ error: say(request, err.text) });
      request.log.error(err, "update failed");
      return reply.code(502).send({ error: say(request, { sv: "Uppdateringen kunde inte startas. Försök igen om en stund.", en: "The update could not be started. Try again in a while." }) });
    }
  });

  // GET /api/admin/verify — Check if admin token is still valid
  app.get("/api/admin/verify", async (request, reply) => {
    if (!requireAdminAuth(request, reply)) return;
    return reply.send({ ok: true });
  });
}
