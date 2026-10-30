/**
 * The release this installation runs: the repository root's package.json,
 * whose version is bumped in the commit each vX.Y.Z tag points to.
 */
import { readFileSync } from "node:fs";

export const VERSION = (() => {
  try {
    // ../../ from api/src and from api/dist alike.
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "unknown";
  }
})();
