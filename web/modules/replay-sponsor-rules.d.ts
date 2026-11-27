// Types for replay-sponsor-rules.js, for the API's tests that run it.

export const SKIP_AFTER_S: number;

export function skipShown(at: { skippable?: boolean; started?: boolean; currentTime: number }): boolean;
