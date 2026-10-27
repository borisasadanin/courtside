// Writes the landing page in every language: public/index.html (Swedish) and
// public/en/index.html (English). Run with `npm run pages` after editing
// page.mjs, strings.mjs or films.html, and commit the output.
import { mkdirSync, writeFileSync } from "node:fs";
import { page } from "./page.mjs";
import { sv, en } from "./strings.mjs";

const out = new URL("../public/", import.meta.url);
for (const t of [sv, en]) {
  const dir = new URL(t.path.slice(1), out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("index.html", dir), page(t));
  console.log(`wrote ${t.path}index.html`);
}
