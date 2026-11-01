export interface StreamInfo {
  id: string;
  name: string;
  rtmpUrl: string;
  hlsUrl: string;
  createdAt: string;
  /** The teams as the recording's card shows them, so the camera asks for the result with the same names. */
  homeTeam?: string;
  awayTeam?: string;
  /** The match the recording belongs to (ABL-048). */
  matchId?: string;
}

export interface StreamPublicInfo {
  id: string;
  name: string;
  hlsUrl: string;
  /** DVR playlist URL — serves all collected segments for catch-up playback */
  dvrUrl?: string;
  createdAt: string;
  status: "live" | "waiting" | "stopped" | "paused";
  /** Set only when status is "paused" */
  pauseType?: "period" | "timeout";
  /** Current match period (1-based) */
  period?: number;
  viewers: number;
  /** A recent frame of the stream, behind the viewer PIN (ABL-045). */
  posterUrl?: string;
  /** The match the stream belongs to (ABL-048). Missing on streams started before it. */
  matchId?: string;
}

export interface CreateStreamBody {
  name: string;
  deviceId?: string;
  opponent?: string;
  team?: string;
  /** A match from the schedule (ABL-048). Its teams and venue then win over team and opponent. */
  matchId?: string;
}

export interface RestreamerProcess {
  id: string;
  reference: string;
  created_at?: number; // Unix timestamp (seconds) from Restreamer
  config: {
    id: string;
    input: { id: string; address: string; options: string[] }[];
    output: { id: string; address: string; options: string[] }[];
    autostart: boolean;
    reconnect: boolean;
    reconnect_delay_seconds: number;
    stale_timeout_seconds: number;
  };
  state?: {
    exec: string; // "running" | "finished" | "failed"
    runtime_seconds: number;
  };
  metadata?: Record<string, unknown>;
}

export interface HighlightClip {
  id: string;
  streamId: string;
  hlsUrl: string;
  mp4Url?: string;
  thumbnailUrl?: string;
  durationSeconds: number;
  createdAt: string;
  label?: string;
  /**
   * The clip's first segment, named as in the match recording (e.g. "p2_abc_00123.ts"),
   * so the replay can mark where the clip starts. Missing on clips made before ABL-046.
   */
  startSegment?: string;
}

/** A pause in a recording. `n` names its segments in the stitched playlist: pause{n}_seg_*.ts. */
export interface RecordedPause {
  n: number;
  type: "period" | "timeout";
}

/**
 * The final score of a recorded match. `home` is the club's own team
 * (`homeTeam`) and `away` the opponent, wherever the match was played.
 */
export interface MatchResult {
  home: number;
  away: number;
  /** Who set it: the camera right after the match, or the admin afterwards. */
  setBy: "camera" | "admin";
  setAt: string;
}

export interface VodEntry {
  id: string;
  matchTitle: string;
  location: string;
  homeTeam: string;
  awayTeam: string;
  matchDate: string;
  cameraName: string;
  hlsUrl: string;
  createdAt: string;
  stoppedAt?: string;
  durationSeconds?: number;
  result?: MatchResult;
  /** The highlight the admin chose as the match's cover (ABL-045). */
  coverClipId?: string;
  /** A frame of the recording is stored as <id>/cover.jpg (ABL-045). */
  frameCover?: boolean;
  /** Every pause in order, so the replay can tell period breaks from timeouts. Missing on older recordings. */
  pauses?: RecordedPause[];
  /** The match in the schedule (ABL-048). Missing on recordings made before it. */
  matchId?: string;
}
