/**
 * Stream CRUD routes: create, list, get, delete streams.
 * Also includes viewer heartbeat and auto-cleanup.
 */
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { config } from "../config.js";
import { broadcasterOf, requireBroadcasterAuth, requireViewerAuth, requireViewerOrBroadcasterAuth } from "../auth.js";
import { streamMeta, restreamer, minio, oscManager, collectors, clipsByStream, guestSpaces, PAUSE_TYPES } from "../state.js";
import type { PauseType, StreamMeta } from "../state.js";
import { SegmentCollector } from "../segment-collector.js";
import { getViewerCount, registerViewer, viewers } from "../viewer-tracking.js";
import { determineStreamStatus } from "../stream-status.js";
import { uploadPauseSegments } from "../pause-segments.js";
import { stitchPlaylist, buildPartList } from "../playlist-stitcher.js";
import type { CreateStreamBody, StreamInfo, StreamPublicInfo, VodEntry } from "../types.js";
import { streamStartedBy } from "../broadcast-state.js";
import { clubManifest, defaultHomeTeam, defaultAwayTeam } from "../club-config.js";
import { saveStreamMetaSoon } from "../stream-meta-store.js";
import { forgetLivePicture, recordingStopped, withLivePictures } from "../match-images.js";
import { matches } from "../state.js";
import { clubDate, type MatchSummary } from "../matches.js";

/** DVR playlist URL for a stream (relative path — frontend prepends API base). */
function dvrUrl(id: string): string {
  return `/api/streams/${id}/dvr.m3u8`;
}

/**
 * Match fields for the public API: the match in the schedule, the current
 * period, and the pause type while paused.
 */
function matchInfo(meta: StreamMeta | undefined, status: StreamPublicInfo["status"]): Pick<StreamPublicInfo, "pauseType" | "period" | "matchId" | "homeTeam" | "awayTeam"> {
  if (!meta) return {};
  const info: Pick<StreamPublicInfo, "pauseType" | "period" | "matchId" | "homeTeam" | "awayTeam"> = { ...ofMatch(meta), period: meta.periodNumber };
  if (status === "paused") info.pauseType = meta.pauseType ?? "period";
  return info;
}

/**
 * The stream's match id, when it has one (ABL-048), and its teams as recorded,
 * so a live card can name them without the schedule (ABL-049).
 */
function ofMatch(meta: StreamMeta | undefined): Pick<StreamPublicInfo, "matchId" | "homeTeam" | "awayTeam"> {
  return {
    ...(meta?.matchId && { matchId: meta.matchId }),
    ...(meta?.homeTeam && meta.awayTeam && { homeTeam: meta.homeTeam, awayTeam: meta.awayTeam }),
  };
}

/** A typed team name, trimmed, or "" when none was typed. */
function typed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Record that a stream's live playlist is up. After a resume this is also the
 * moment viewers can see the match again, so log how long that took — the
 * budget is five seconds from the button in the app (ABL-005).
 */
function markLive(id: string, meta: StreamMeta, log: { info: (msg: string) => void }): void {
  meta.wasLive = true;
  if (!meta.resumedAt) return;
  const ms = Date.now() - new Date(meta.resumedAt).getTime();
  log.info(`Resume ${id}: live again ${ms} ms after the resume request (part ${meta.partNumber})`);
  meta.resumedAt = undefined;
}

/**
 * How long a stream may go without a running process and without the camera
 * asking about it before cleanup ends it. The camera polls its stream every
 * ten seconds while the app is open, so a camera that has lost its connection
 * and keeps retrying never reaches this. It covers a camera that is gone: an
 * app that crashed, was closed, or a phone that ran out of battery. Long
 * enough for a halftime spent without pressing pause.
 */
export const STREAM_IDLE_LIMIT_MS = 15 * 60 * 1000;

/** Note that the camera is still there (see STREAM_IDLE_LIMIT_MS). */
export function noteCamera(meta: StreamMeta | undefined): void {
  if (meta) meta.cameraSeenAt = Date.now();
}

/**
 * The last sign of life of a stream: created, process running, or camera
 * asking. Cleanup ends a stream once this is older than STREAM_IDLE_LIMIT_MS.
 */
export function lastSignOfLife(meta: StreamMeta): number {
  return Math.max(new Date(meta.createdAt).getTime() || 0, meta.lastRunningAt ?? 0, meta.cameraSeenAt ?? 0);
}

/**
 * End a stream and make its recording playable. Used by the camera's stop and
 * by cleanup, so a match ended either way is stitched the same.
 */
export async function endStream(id: string, meta: StreamMeta, log: FastifyBaseLogger): Promise<void> {
  const stoppedAt = new Date().toISOString();
  meta.stoppedAt = stoppedAt;
  // The guest space's 14 days count from here (#52).
  guestSpaces.streamEnded(id, stoppedAt).catch((err) => log.error(err, "Could not note the guest space's end"));

  const durationSeconds = Math.round((new Date(stoppedAt).getTime() - new Date(meta.createdAt).getTime()) / 1000);
  minio.updateVodEntry(id, { stoppedAt, durationSeconds }).catch((err) => {
    log.error(err, "Failed to finalize VOD entry");
  });
  saveStreamMetaSoon(minio, log);
  viewers.delete(id);

  // Stop collecting segments and build the final part manifest
  const collector = collectors.get(id);
  if (collector) {
    collectors.delete(id);
    await collector.stop().catch((err) => log.error(err, `Could not finish collecting ${id}`));
  }

  // A cover frame from the first period; the live picture goes (ABL-045)
  void recordingStopped(id, meta.partNumber ?? 1, log);

  // All recordings are played from index.m3u8, which only stitching writes
  if (meta.partNumber >= 1) {
    const parts = buildPartList(meta.completedParts, meta.partNumber);
    stitchPlaylist(minio, id, parts).catch((err) => {
      log.error(err, `Failed to stitch playlist for ${id}`);
    });
  }
}

/**
 * Resume a paused stream: the next recording part, a collector for it.
 * Returns how the process was switched. Throws, with the stream left paused,
 * if Restreamer could not be switched to the new part.
 */
async function resumePaused(id: string, meta: StreamMeta, log: FastifyBaseLogger): Promise<void> {
  // Every resume is a new recording part; only a period break is a new period.
  const pausedAt = meta.pausedAt;
  const pauseType = meta.pauseType;
  meta.partNumber++;
  if (pauseType !== "timeout") meta.periodNumber++;
  meta.pausedAt = undefined;
  meta.pauseType = undefined;
  const resumeStarted = Date.now();
  meta.resumedAt = new Date(resumeStarted).toISOString();
  // Reset wasLive so status becomes "waiting" (not "stopped") during the
  // gap before HLS is live again.  It gets re-set to true once isHlsLive()
  // returns true in the streams list/detail routes.
  meta.wasLive = false;

  try {
    // Restreamer recording disabled — SegmentCollector handles recording via HTTP polling
    const how = await restreamer.switchPart(id, meta.partNumber);
    log.info(`Resume ${id}: process ${how} for part ${meta.partNumber} in ${Date.now() - resumeStarted} ms`);
  } catch (err) {
    // Rollback
    meta.partNumber--;
    if (pauseType !== "timeout") meta.periodNumber--;
    meta.resumedAt = undefined;
    meta.pausedAt = pausedAt;
    meta.pauseType = pauseType;
    throw err;
  }
  oscManager.streamResumed();

  // Start collecting segments for the new part
  const collector = new SegmentCollector(id, () => restreamer.baseUrlValue, minio, log, meta.partNumber);
  collector.start();
  collectors.set(id, collector);
  saveStreamMetaSoon(minio, log);
}

export default async function streamRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/streams — Create a new stream (or resume existing one for same device)
  app.post<{ Body: CreateStreamBody }>("/api/streams", async (request, reply) => {
    if (!(await requireBroadcasterAuth(request, reply))) return;

    const { name, deviceId, opponent, team, matchId } = request.body || {};
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return reply.code(400).send({ error: "missing_name", message: "Namn saknas" });
    }

    // A match picked from the schedule (ABL-048), looked up before anything
    // starts so an unknown one starts nothing. If the schedule cannot be read,
    // the broadcast goes ahead as one without a match: it must not fail on that.
    let scheduled: MatchSummary | null = null;
    if (matchId !== undefined && matchId !== null && matchId !== "") {
      let lookedUp = true;
      try {
        scheduled = typeof matchId === "string" ? await matches.summary(matchId) : null;
      } catch (err) {
        lookedUp = false;
        request.log.warn(err, `Could not read the schedule for match ${String(matchId)}`);
      }
      if (!scheduled && lookedUp) {
        return reply.code(404).send({
          error: "match_not_found",
          message: "Matchen finns inte i schemat längre. Välj en annan match, eller Annan match.",
        });
      }
    }

    // Ensure Restreamer is available
    let oscState = oscManager.getState();
    if (oscState === "stopping") {
      // Grace period active — instant cancel, Restreamer is still running
      try {
        await oscManager.ensureRunning();
        oscState = oscManager.getState();
      } catch {
        // Fall through to state check below
      }
    } else if (oscState === "stopped") {
      // Restreamer is fully stopped — kick off start in background (takes 1-3 min)
      // Don't block the request; return 409 and let the client retry
      oscManager.ensureRunning().catch((err) => {
        app.log.error(err, "Background Restreamer start failed");
      });
      return reply.code(409).send({
        error: "restreamer_not_ready",
        message: "Sändningsmotorn startar automatiskt. Försök igen om ca 1 minut.",
      });
    }
    const oscInfo = oscManager.getInfo();
    // Started and counting down for lack of a stream is up: this stream is
    // the one it waits for (ensureRunning starts the countdown again).
    if (!oscManager.isUp() || !oscInfo) {
      const stateMessages: Record<string, string> = {
        starting: "Sändningsmotorn startar. Vänta tills den är redo och försök igen (~1 min).",
        stopping: "Sändningsmotorn håller på att stängas ner. Försök igen om en stund.",
      };
      return reply.code(409).send({
        error: "restreamer_not_ready",
        message: stateMessages[oscState] || "Sändningsmotorn är inte redo.",
      });
    }
    restreamer.rtmpHost = oscInfo.rtmpHost;

    const displayName = `${name.trim()} kamera`;

    // If deviceId provided, reconnect to an ACTIVE (non-stopped) stream from same device
    if (deviceId) {
      for (const [existingId, meta] of streamMeta) {
        if (meta.deviceId !== deviceId || meta.name !== displayName) continue;

        // Only reconnect to active streams — stopped streams always create a new one
        // to avoid overwriting previous recordings in MinIO
        if (meta.stoppedAt) continue;

        noteCamera(meta);
        if (meta.pausedAt) {
          // The app was restarted during a pause and no longer knows it. It
          // will start sending as soon as it gets this answer, so resume here:
          // otherwise nothing records and viewers keep seeing the pause.
          try {
            await resumePaused(existingId, meta, request.log);
          } catch (err) {
            request.log.error(err, `Could not resume ${existingId} for a returning camera`);
            return reply.code(409).send({
              error: "restreamer_not_ready",
              message: "Kunde inte fortsätta sändningen. Försök igen om en stund.",
            });
          }
        } else {
          oscManager.streamStarted();
        }

        const vod = (await minio.readVodIndex().catch(() => [])).find((v) => v.id === existingId);
        const info: StreamInfo = {
          id: existingId,
          name: meta.name,
          rtmpUrl: restreamer.rtmpUrl(existingId),
          hlsUrl: restreamer.hlsUrl(existingId, meta.partNumber),
          createdAt: meta.createdAt,
          ...ofMatch(meta),
          // The recording follows a change to its match; the stream's own copy does not
          homeTeam: vod?.homeTeam ?? meta.homeTeam,
          awayTeam: vod?.awayTeam ?? meta.awayTeam,
        };
        return reply.code(200).send(info);
      }
    }

    // No existing stream for this device — create new
    const streamId = crypto.randomUUID().slice(0, 8);

    try {
      // Restreamer recording disabled — SegmentCollector handles recording via HTTP polling
      await restreamer.createProcess(streamId, { recording: false, partNumber: 1 });

      oscManager.streamStarted();

      // Start collecting HLS segments for VOD recording
      const collector = new SegmentCollector(streamId, () => restreamer.baseUrlValue, minio, request.log, 1);
      collector.start();
      collectors.set(streamId, collector);

      const info: StreamInfo = {
        id: streamId,
        name: displayName,
        rtmpUrl: restreamer.rtmpUrl(streamId),
        hlsUrl: restreamer.hlsUrl(streamId),
        createdAt: new Date().toISOString(),
      };

      // The match this recording belongs to: the one picked, or else one on
      // the same day between the same teams, made now if there is none, so
      // an older app or "Annan match" still lands on a match (ABL-048). A team
      // typed in the app joins the registry on the way (ABL-047).
      let match = scheduled;
      const typedTeam = typed(team);
      const typedOpponent = typed(opponent);
      if (!match) {
        try {
          match = await matches.forRecording(
            clubDate(),
            typedTeam || defaultHomeTeam,
            typedOpponent || defaultAwayTeam,
            { own: !!typedTeam, opponent: !!typedOpponent },
          );
        } catch (err) {
          request.log.warn(err, "Could not put the recording on a match");
        }
      }

      // The match's teams, or the ones typed in the app
      const homeTeam = match?.ownTeam.name ?? (typedTeam || defaultHomeTeam);
      const awayTeam = match?.opponent.name ?? (typedOpponent || defaultAwayTeam);

      streamMeta.set(streamId, {
        name: displayName,
        createdAt: info.createdAt,
        deviceId,
        partNumber: 1,
        periodNumber: 1,
        completedParts: [],
        ...(match && { matchId: match.id }),
        homeTeam,
        awayTeam,
        cameraSeenAt: Date.now(),
      });
      saveStreamMetaSoon(minio, request.log);

      // The camera's announced match has started. Every status after this
      // follows the stream itself (ABL-051).
      streamStartedBy(await broadcasterOf(request), match?.id);

      // Create VOD entry with the same teams
      const vodEntry: VodEntry = {
        id: streamId,
        matchTitle: `${homeTeam} vs ${awayTeam}`,
        location: match ? match.venue ?? "" : clubManifest.venue,
        homeTeam,
        awayTeam,
        matchDate: match?.date ?? clubDate(),
        cameraName: name.trim(),
        hlsUrl: `/api/vod/${streamId}/playlist.m3u8`,
        createdAt: info.createdAt,
        ...(match && { matchId: match.id }),
      };

      minio.addVodEntry(vodEntry).catch((err) => {
        request.log.error(err, "Failed to save VOD entry");
      });

      return reply.code(201).send({ ...info, homeTeam, awayTeam, ...(match && { matchId: match.id }) });
    } catch (err) {
      request.log.error(err, "Failed to create stream");
      return reply.code(500).send({
        error: "stream_creation_failed",
        message: "Kunde inte skapa strömmen. Försök igen.",
      });
    }
  });

  // PATCH /api/streams/:id/pause — Pause a live stream.
  // Body { type: "period" | "timeout" } is optional; older cameras send none and
  // get a period break, which is what every pause used to be.
  app.patch<{ Params: { id: string }; Body: { type?: unknown } | undefined }>("/api/streams/:id/pause", async (request, reply) => {
    if (!(await requireBroadcasterAuth(request, reply))) return;

    const { id } = request.params;
    const meta = streamMeta.get(id);

    const requestedType = request.body?.type ?? "period";
    if (!PAUSE_TYPES.includes(requestedType as PauseType)) {
      return reply.code(400).send({ error: "invalid_pause_type", message: "Okänd paustyp" });
    }
    const pauseType = requestedType as PauseType;

    if (!meta) {
      return reply.code(404).send({ error: "not_found", message: "Strömmen hittades inte" });
    }
    if (meta.stoppedAt) {
      return reply.code(409).send({ error: "already_stopped", message: "Strömmen är redan stoppad" });
    }
    if (meta.pausedAt) {
      return reply.code(409).send({ error: "already_paused", message: "Strömmen är redan pausad" });
    }
    noteCamera(meta);

    // Stop collecting segments and build part manifest BEFORE killing Restreamer
    const pauseCollector = collectors.get(id);
    if (pauseCollector) {
      await pauseCollector.pause();
      collectors.delete(id);
    }

    meta.pausedAt = new Date().toISOString();
    meta.pauseType = pauseType;
    meta.completedParts.push(meta.partNumber);
    // The pause segments only say "pause N"; the replay needs to know which kind it was.
    meta.pauses = [...(meta.pauses ?? []), { n: meta.partNumber, type: pauseType }];
    saveStreamMetaSoon(minio, request.log);
    minio.updateVodEntry(id, { pauses: meta.pauses }).catch((err) => {
      request.log.error(err, `Failed to save pause type for ${id}`);
    });

    // Upload pause marker segments (fire-and-forget, with logging)
    const pauseNumber = meta.partNumber;
    uploadPauseSegments(minio, id, pauseNumber).catch((err) => {
      request.log.error(err, `Failed to upload pause segments for ${id}`);
    });

    // The Restreamer process is kept through the pause (ABL-005). The camera
    // disconnects, the process waits for it, and resuming only has to point it
    // at the next part — nothing has to be built up again.
    oscManager.streamPaused();

    return reply.code(200).send({ status: "paused", pauseType, pausedAt: meta.pausedAt, period: meta.periodNumber });
  });

  // PATCH /api/streams/:id/resume — Resume a paused stream
  app.patch<{ Params: { id: string } }>("/api/streams/:id/resume", async (request, reply) => {
    if (!(await requireBroadcasterAuth(request, reply))) return;

    const { id } = request.params;
    const meta = streamMeta.get(id);

    if (!meta) {
      return reply.code(404).send({ error: "not_found", message: "Strömmen hittades inte" });
    }
    if (!meta.pausedAt) {
      return reply.code(409).send({ error: "not_paused", message: "Strömmen är inte pausad" });
    }
    if (meta.stoppedAt) {
      return reply.code(409).send({ error: "already_stopped", message: "Strömmen är redan stoppad" });
    }

    // Ensure Restreamer is running. The health poll restarts a lost instance on
    // its own while a stream is paused; this covers a resume that beats it there.
    const oscState = oscManager.getState();
    const oscInfo = oscManager.getInfo();
    if (oscState !== "running" || !oscInfo) {
      if (oscState === "stopped") {
        oscManager.ensureRunning().catch((err) => {
          request.log.error(err, "Background Restreamer start failed");
        });
      }
      return reply.code(409).send({
        error: "restreamer_not_ready",
        message: "Sändningsmotorn är inte redo. Försök igen.",
      });
    }
    restreamer.rtmpHost = oscInfo.rtmpHost;
    noteCamera(meta);

    try {
      await resumePaused(id, meta, request.log);
      return reply.code(200).send({
        status: "resumed",
        rtmpUrl: restreamer.rtmpUrl(id),
        partNumber: meta.partNumber,
        period: meta.periodNumber,
      });
    } catch (err) {
      request.log.error(err, "Failed to create Restreamer process on resume");
      return reply.code(500).send({
        error: "resume_failed",
        message: "Kunde inte återuppta strömmen. Försök igen.",
      });
    }
  });

  // GET /api/streams — List active + recently stopped streams
  app.get("/api/streams", async (_request, reply) => {
    if (!requireViewerAuth(_request, reply)) return;

    const restreamerState = oscManager.getState();
    const restreamerAvailable = restreamerState === "running" || restreamerState === "stopping";

    // Helper: build list from metadata only (when Restreamer is unavailable)
    function metadataOnlyStreams(): StreamPublicInfo[] {
      const streams: StreamPublicInfo[] = [];
      const now = Date.now();
      for (const [streamId, meta] of streamMeta) {
        if (meta.stoppedAt) {
          if (now - new Date(meta.stoppedAt).getTime() > config.STOPPED_TTL_MS) continue;
          streams.push({
            id: streamId,
            name: meta.name,
            hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
            createdAt: meta.createdAt,
            status: "stopped",
            ...ofMatch(meta),
            viewers: 0,
          });
        } else if (meta.pausedAt) {
          streams.push({
            id: streamId,
            name: meta.name,
            hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
            dvrUrl: dvrUrl(streamId),
            createdAt: meta.createdAt,
            status: "paused",
            ...matchInfo(meta, "paused"),
            viewers: getViewerCount(streamId),
          });
        } else {
          // Active metadata but Restreamer unreachable — show as "waiting" (not "live")
          streams.push({
            id: streamId,
            name: meta.name,
            hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
            dvrUrl: dvrUrl(streamId),
            createdAt: meta.createdAt,
            status: "waiting",
            ...matchInfo(meta, "waiting"),
            viewers: getViewerCount(streamId),
          });
        }
      }
      return streams;
    }

    // If Restreamer is not running, return metadata-only list
    if (!restreamerAvailable) {
      return reply.send(withLivePictures(metadataOnlyStreams()));
    }

    try {
      const processes = await restreamer.listManagedProcesses();
      const activeIds = new Set<string>();

      // Active streams (from Restreamer) — check HLS manifest to determine live status
      const streams: StreamPublicInfo[] = await Promise.all(
        processes.map(async (p) => {
          const streamId = p.config.id.replace(config.PROCESS_PREFIX, "");
          activeIds.add(streamId);
          const meta = streamMeta.get(streamId);
          if (meta?.stoppedAt) {
            meta.stoppedAt = undefined;
          }

          // Check BOTH Restreamer process state AND HLS manifest.
          // A process in "failed" state is not producing HLS, regardless of wasLive.
          const processExec = p.state?.exec;
          const processIsHealthy = processExec === "running";
          const partNum = meta?.partNumber ?? 1;
          const hlsLive = processIsHealthy ? await restreamer.isHlsLive(streamId, partNum) : false;

          // Track whether stream was ever live
          if (hlsLive && meta) markLive(streamId, meta, _request.log);

          // If process is in a failed/finished state (no RTMP input), override
          // wasLive to prevent the optimistic "live" status for dead streams.
          // Only "running" processes can be truly live.
          const effectiveMeta = (!processIsHealthy && meta?.wasLive)
            ? { ...meta, wasLive: false }
            : meta;

          const status = determineStreamStatus(hlsLive, effectiveMeta);

          // NOTE: We intentionally do NOT auto-stop streams here.
          // The cleanup timer (every 60s) handles stopping by checking the
          // actual Restreamer process state instead.

          return {
            id: streamId,
            name: meta?.name || streamId,
            hlsUrl: restreamer.hlsUrl(streamId, partNum),
            dvrUrl: dvrUrl(streamId),
            createdAt: meta?.createdAt || "",
            status,
            ...matchInfo(meta, status),
            viewers: getViewerCount(streamId),
          };
        })
      );

      // Stopped streams (metadata with stoppedAt, within TTL)
      const now = Date.now();
      for (const [streamId, meta] of streamMeta) {
        if (activeIds.has(streamId) || !meta.stoppedAt) continue;
        if (now - new Date(meta.stoppedAt).getTime() > config.STOPPED_TTL_MS) continue;
        streams.push({
          id: streamId,
          name: meta.name,
          hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
          createdAt: meta.createdAt,
          status: "stopped",
          ...ofMatch(meta),
          viewers: 0,
        });
      }

      // Paused streams (metadata with pausedAt, no active Restreamer process)
      for (const [streamId, meta] of streamMeta) {
        if (activeIds.has(streamId) || !meta.pausedAt || meta.stoppedAt) continue;
        streams.push({
          id: streamId,
          name: meta.name,
          hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
          dvrUrl: dvrUrl(streamId),
          createdAt: meta.createdAt,
          status: "paused",
          ...matchInfo(meta, "paused"),
          viewers: getViewerCount(streamId),
        });
      }

      // Waiting streams (metadata exists, no Restreamer process yet, not stopped/paused)
      // This catches newly created streams where the process hasn't appeared in
      // listManagedProcesses() yet (race condition / API lag).
      for (const [streamId, meta] of streamMeta) {
        if (activeIds.has(streamId) || meta.stoppedAt || meta.pausedAt) continue;
        // Stream has metadata but no process — show as "waiting"
        streams.push({
          id: streamId,
          name: meta.name,
          hlsUrl: restreamer.hlsUrl(streamId, meta.partNumber),
          dvrUrl: dvrUrl(streamId),
          createdAt: meta.createdAt,
          status: "waiting",
          ...matchInfo(meta, "waiting"),
          viewers: getViewerCount(streamId),
        });
      }

      return reply.send(withLivePictures(streams));
    } catch (err) {
      // Restreamer API failed (crashed/503/504) — fall back to metadata
      _request.log.error(err, "Restreamer API unavailable, falling back to cached metadata");
      return reply.send(withLivePictures(metadataOnlyStreams()));
    }
  });

  // GET /api/streams/:id — Get a specific stream
  app.get<{ Params: { id: string } }>(
    "/api/streams/:id",
    async (request, reply) => {
      if (!(await requireViewerOrBroadcasterAuth(request, reply))) return;

      const { id } = request.params;
      const meta = streamMeta.get(id);

      // The camera polls its own stream: that is how cleanup knows it is
      // still there while it reconnects (STREAM_IDLE_LIMIT_MS).
      if (typeof request.headers["x-device-token"] === "string") noteCamera(meta);

      const partNum = meta?.partNumber ?? 1;

      // Check if stopped (within TTL)
      if (meta?.stoppedAt) {
        const age = Date.now() - new Date(meta.stoppedAt).getTime();
        if (age <= config.STOPPED_TTL_MS) {
          return reply.send({
            id,
            name: meta.name,
            hlsUrl: restreamer.hlsUrl(id, partNum),
            createdAt: meta.createdAt,
            status: "stopped",
            ...ofMatch(meta),
            viewers: 0,
          } satisfies StreamPublicInfo);
        }
        return reply.code(404).send({ error: "Stream not found" });
      }

      // Check if paused
      if (meta?.pausedAt && !meta.stoppedAt) {
        return reply.send({
          id,
          name: meta.name,
          hlsUrl: restreamer.hlsUrl(id, partNum),
          dvrUrl: dvrUrl(id),
          createdAt: meta.createdAt,
          status: "paused",
          ...matchInfo(meta, "paused"),
          viewers: getViewerCount(id),
        } satisfies StreamPublicInfo);
      }

      // Try Restreamer — but fall back to metadata if Restreamer is unavailable.
      // A Restreamer API failure must NEVER cause a 500 that kills the frontend player.
      try {
        const process = await restreamer.getProcess(id);
        if (!process) {
          // Process not found in Restreamer — but if metadata exists (not stopped, not paused),
          // the stream was recently created and the process hasn't registered yet.
          // Return "waiting" instead of 404 to prevent the frontend from closing the player.
          if (meta && !meta.stoppedAt && !meta.pausedAt) {
            return reply.send({
              id,
              name: meta.name,
              hlsUrl: restreamer.hlsUrl(id, partNum),
              dvrUrl: dvrUrl(id),
              createdAt: meta.createdAt,
              status: "waiting",
              ...matchInfo(meta, "waiting"),
              viewers: getViewerCount(id),
            } satisfies StreamPublicInfo);
          }
          return reply.code(404).send({ error: "Stream not found" });
        }

        // Check BOTH process state AND HLS manifest
        const processExec = process.state?.exec;
        const processIsHealthy = processExec === "running";
        const hlsLive = processIsHealthy ? await restreamer.isHlsLive(id, partNum) : false;

        // Track wasLive for accurate status
        if (hlsLive && meta) markLive(id, meta, request.log);

        // If process is failed (no RTMP input), override wasLive to prevent
        // the optimistic "live" status for dead streams.
        const effectiveMeta = (!processIsHealthy && meta?.wasLive)
          ? { ...meta, wasLive: false }
          : meta;

        const status = determineStreamStatus(hlsLive, effectiveMeta);

        // NOTE: No auto-stop here. The cleanup timer handles marking streams
        // as stopped based on the actual Restreamer process state.

        const info: StreamPublicInfo = {
          id,
          name: meta?.name || id,
          hlsUrl: restreamer.hlsUrl(id, partNum),
          dvrUrl: dvrUrl(id),
          createdAt: meta?.createdAt || "",
          status,
          ...matchInfo(meta, status),
          viewers: getViewerCount(id),
        };

        return reply.send(info);
      } catch (err) {
        // Restreamer API failed — fall back to metadata to keep the player alive.
        // The stream is probably still running; we just can't confirm HLS status right now.
        request.log.warn(err, `Restreamer API error for stream ${id}, falling back to metadata`);

        if (meta && !meta.stoppedAt && !meta.pausedAt) {
          // Use last known status: if wasLive, report "live" (optimistic)
          const fallbackStatus = determineStreamStatus(false, meta);
          return reply.send({
            id,
            name: meta.name,
            hlsUrl: restreamer.hlsUrl(id, partNum),
            dvrUrl: dvrUrl(id),
            createdAt: meta.createdAt,
            status: fallbackStatus,
            ...matchInfo(meta, fallbackStatus),
            viewers: getViewerCount(id),
          } satisfies StreamPublicInfo);
        }

        // No metadata — truly unknown stream
        return reply.code(404).send({ error: "Stream not found" });
      }
    }
  );

  // DELETE /api/streams/:id — Stop stream (keep metadata for TTL)
  app.delete<{ Params: { id: string } }>(
    "/api/streams/:id",
    async (request, reply) => {
      if (!(await requireBroadcasterAuth(request, reply))) return;

      const { id } = request.params;

      const meta = streamMeta.get(id);
      // A stop that arrives again (the app retrying after a timeout) must not
      // count the stream out twice or stitch it again.
      if (meta?.stoppedAt) return reply.code(204).send();

      const wasPaused = !!meta?.pausedAt;
      if (wasPaused) {
        oscManager.pausedStreamEnded();
      } else {
        oscManager.streamEnded();
      }

      // The collector's last poll needs the process, so it goes first
      if (meta) {
        await endStream(id, meta, request.log);
      } else {
        viewers.delete(id);
      }

      // Delete the Restreamer process in the background (fire-and-forget).
      // The cleanup timer will catch any stragglers.
      restreamer.deleteProcess(id).catch((err) => {
        request.log.warn(err, `Could not delete Restreamer process for ${id} (may already be stopped)`);
      });

      return reply.code(204).send();
    }
  );

  // POST /api/streams/:id/view — Register viewer heartbeat (no auth)
  app.post<{ Params: { id: string } }>(
    "/api/streams/:id/view",
    async (request, reply) => {
      const { id } = request.params;
      const ip = request.ip || "unknown";
      registerViewer(id, ip);
      return reply.code(204).send();
    }
  );

  // --- Auto-cleanup of stale streams ---
  async function cleanupStaleStreams(): Promise<void> {
    // Skip cleanup if Restreamer is not running
    if (oscManager.getState() !== "running") {
      // Still clean up expired metadata
      const now = Date.now();
      for (const [streamId, meta] of streamMeta) {
        if (meta.stoppedAt && now - new Date(meta.stoppedAt).getTime() > config.STOPPED_TTL_MS) {
          streamMeta.delete(streamId);
          clipsByStream.delete(streamId);
          forgetLivePicture(streamId);
        }
      }
      return;
    }

    try {
      const processes = await restreamer.listManagedProcesses();
      let activeCount = 0;

      for (const p of processes) {
        const state = p.state?.exec;
        const streamId = p.config.id.replace(config.PROCESS_PREFIX, "");
        const meta = streamMeta.get(streamId);
        // Use backend metadata age, falling back to Restreamer process created_at.
        // Without this fallback, orphaned processes (metadata lost after backend
        // redeploy) would never be cleaned up since ageMs would be 0.
        const createdAtMs = meta
          ? new Date(meta.createdAt).getTime()
          : (p.created_at ? p.created_at * 1000 : Date.now());
        const ageMs = Date.now() - createdAtMs;

        // A process nobody owns any more: its stream is gone from memory (and
        // was not restored at startup), or was stopped and the delete in the
        // stop route did not get through. Either way it only costs money.
        const orphaned = !meta && ageMs > 10 * 60 * 1000;
        const leftOver = meta?.stoppedAt && Date.now() - new Date(meta.stoppedAt).getTime() > 2 * 60 * 1000;
        if (orphaned || leftOver) {
          app.log.info(`Removing process of ${orphaned ? "unknown" : "stopped"} stream ${streamId} (state: ${state})`);
          await restreamer.deleteProcess(streamId);
          continue;
        }

        // Paused streams keep their process through the pause, waiting for the
        // camera to come back. It is not active, and it must not be cleaned up.
        if (meta?.pausedAt && !meta.stoppedAt) continue;

        if (state === "running") {
          if (meta) meta.lastRunningAt = Date.now();
          activeCount++;
          continue;
        }

        // Not running: with reconnect on, the process sits between retries
        // while no camera sends. That is normal during a network drop, so the
        // stream ends only when it has been quiet — no running process and no
        // camera asking — for STREAM_IDLE_LIMIT_MS, counted from its last sign
        // of life rather than from when it was created.
        const quietMs = meta ? Date.now() - lastSignOfLife(meta) : ageMs;
        if (quietMs > STREAM_IDLE_LIMIT_MS) {
          app.log.info(`Ending abandoned stream ${streamId} (state: ${state}, quiet for ${Math.round(quietMs / 1000)}s)`);
          if (meta && !meta.stoppedAt) {
            // Collect and stitch while the process is still there
            await endStream(streamId, meta, app.log);
          }
          viewers.delete(streamId);
          await restreamer.deleteProcess(streamId);
        } else {
          // Still active: the camera may be on its way back
          activeCount++;
        }
      }

      // Sync the manager's active stream count with reality
      oscManager.syncActiveCount(activeCount);

      // Remove stopped metadata older than TTL
      const now = Date.now();
      for (const [streamId, meta] of streamMeta) {
        if (meta.stoppedAt && now - new Date(meta.stoppedAt).getTime() > config.STOPPED_TTL_MS) {
          streamMeta.delete(streamId);
          clipsByStream.delete(streamId);
          forgetLivePicture(streamId);
        }
      }
    } catch (err) {
      app.log.error(err, "Cleanup error");
    }
  }

  setInterval(cleanupStaleStreams, 60_000);

  // --- Finalize orphaned VOD entries ---
  // Entries without stoppedAt that are older than 1 hour are likely from
  // crashed streams or backend restarts. Mark them as finished.
  async function finalizeOrphanedVods(): Promise<void> {
    try {
      const entries = await minio.readVodIndex();
      const now = Date.now();
      const ONE_HOUR = 60 * 60 * 1000;

      for (const entry of entries) {
        if (entry.stoppedAt) continue;
        const ageMs = now - new Date(entry.createdAt).getTime();
        if (ageMs < ONE_HOUR) continue;

        // A stream this server still runs is a long match, not an orphan:
        // its stop, or cleanup, finishes it.
        const meta = streamMeta.get(entry.id);
        if (meta && !meta.stoppedAt) continue;

        // This entry is orphaned — mark as finalized so it appears in VOD list.
        // Duration is unknown, so leave durationSeconds undefined (passes the VOD filter).
        // Updated under the index lock, so a concurrent stop is not overwritten.
        await minio.updateVodEntry(entry.id, { stoppedAt: entry.createdAt });
        if (meta && meta.partNumber >= 1) {
          const parts = buildPartList(meta.completedParts, meta.partNumber);
          stitchPlaylist(minio, entry.id, parts).catch((err) => {
            app.log.error(err, `Failed to stitch orphaned playlist for ${entry.id}`);
          });
        }
        app.log.info(`Finalized orphaned VOD entry ${entry.id} (age: ${Math.round(ageMs / 60000)} min)`);
      }
    } catch (err) {
      app.log.error(err, "VOD orphan cleanup error");
    }
  }

  // Run orphan cleanup on startup (after 10s delay) and then every 30 minutes
  setTimeout(finalizeOrphanedVods, 10_000);
  setInterval(finalizeOrphanedVods, 30 * 60 * 1000);
}
