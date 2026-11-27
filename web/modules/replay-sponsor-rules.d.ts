// Types for replay-sponsor-rules.js, for the API's tests that run it.

export const SKIP_AFTER_S: number;
export const MAX_PLAY_STEP_S: number;

export interface Fragment { start: number; duration: number; uri?: string; file?: string }
export interface PauseInfo { n: number; type?: string }
export interface PauseSpan { n: number; start: number; end: number; type: string }
export interface BreakSpan { n: number; start: number; end: number; surface: "p1" | "p2" | "p3" | "ot"; key: string }

export function skipShown(at: { skippable?: boolean; started?: boolean; currentTime: number }): boolean;
export function replayStartClipsDue(startAt?: number | null): boolean;
export function fileName(uri: string): string;
export function pauseSpans(frags: Fragment[], pauses: PauseInfo[] | undefined): PauseSpan[];
export function breakSurface(index: number): BreakSpan["surface"];
export function periodBreakSpans(frags: Fragment[], pauses: PauseInfo[] | undefined): BreakSpan[];
export function crossedBreak(
  breaks: BreakSpan[],
  from: number,
  to: number,
  opts?: { seeking?: boolean; played?: Set<string> },
): BreakSpan | null;
