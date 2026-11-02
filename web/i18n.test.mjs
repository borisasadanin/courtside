// Checks that the site can be shown in Swedish and English (issue #30):
//  - every text table has the same keys in both languages, with the same
//    {placeholders};
//  - every key the code and HTML ask for exists;
//  - no Swedish is left in the code or HTML outside the text tables.
// Run with `npm test` in web/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const tablesDir = join(root, "i18n");

// The Courtside site: the main page, the clip page and their modules.
const sources = [
  ...readdirSync(root).filter((f) => /\.(html|js)$/.test(f) && f !== "vite.config.js"),
  ...readdirSync(join(root, "modules")).filter((f) => f.endsWith(".js")).map((f) => `modules/${f}`),
].map((f) => ({ file: f, text: readFileSync(join(root, f), "utf8") }));

const tables = {};
for (const f of readdirSync(tablesDir).filter((f) => f.endsWith(".js") && f !== "index.js")) {
  tables[f.replace(/\.js$/, "")] = (await import(pathToFileURL(join(tablesDir, f)))).default;
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("the text tables are all registered in i18n/index.js", async () => {
  const index = (await import(pathToFileURL(join(tablesDir, "index.js")))).default;
  assert.deepEqual(Object.keys(index).sort(), Object.keys(tables).sort());
});

test("Swedish and English have the same keys and placeholders", () => {
  for (const [area, { sv, en }] of Object.entries(tables)) {
    assert.ok(sv && en, `${area}: needs both sv and en`);
    assert.deepEqual(Object.keys(en).sort(), Object.keys(sv).sort(), `${area}: keys differ between sv and en`);
    for (const key of Object.keys(sv)) {
      assert.equal(typeof en[key], typeof sv[key], `${area}.${key}: one is a function, the other not`);
      if (typeof sv[key] === "string") {
        assert.deepEqual(placeholders(en[key]), placeholders(sv[key]), `${area}.${key}: placeholders differ`);
      }
    }
  }
});

test("every key the site asks for exists", () => {
  const used = [];
  for (const { file, text } of sources.map((s) => ({ ...s, text: withoutComments(s.file, s.text) }))) {
    for (const m of text.matchAll(/\bt\(\s*["'`]([\w-]+\.[\w.-]+)["'`]/g)) used.push([file, m[1]]);
    for (const m of text.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) used.push([file, m[1]]);
    for (const m of text.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(";")) used.push([file, pair.split(":")[1].trim()]);
    }
  }
  const missing = used.filter(([, key]) => {
    const dot = key.indexOf(".");
    return !(key.slice(dot + 1) in (tables[key.slice(0, dot)]?.sv || {}));
  });
  assert.equal(missing.length, 0, `Missing keys:\n${missing.map(([f, k]) => `${f}: ${k}`).join("\n")}`);
});

// Swedish words without å, ä or ö that often show up in the site's text.
const SWEDISH_WORDS =
  /\b(och|inte|ingen|inga|eller|alla|kan|sparar|spara|sparat|visa|dela|kopiera|avbryt|hantera|matcher|matchen|repriser|reprisen|kameror|kameran|inspelningar|inspelningen|spela|ladda|logga|hemma|borta|idag|imorgon|igen|sekunder|minuter|klart|tittare|tittarna|klippet|laget|lagen)\b/i;

/** Source without comments, so examples in comments are not taken for real text */
function withoutComments(file, text) {
  if (file.endsWith(".html")) return text.replace(/<!--[\s\S]*?-->/g, "");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""))
    .replace(/(^|[^:\\'"`])\/\/.*$/gm, "$1");
}

/** The text a visitor can read, with comments and marked (translated) text removed */
function visibleText(file, text) {
  // A line marked i18n-ignore (usually in a comment) is data, not text we show.
  text = withoutComments(file, text.replace(/^.*i18n-ignore.*$/gm, ""));
  if (file.endsWith(".html")) {
    return text
      .replace(/<style[\s\S]*?<\/style>/g, "")
      // Elements whose text comes from a table keep the Swedish as a fallback.
      .replace(/<(\w+)\b([^>]*\bdata-i18n(?:-html)?="[^"]+"[^>]*)>[\s\S]*?<\/\1>/g, "<$1$2></$1>")
      .replace(/<[^>]*\bdata-i18n-attr="([^"]+)"[^>]*>/g, (tag, spec) =>
        spec.split(";").reduce((t, pair) => t.replace(new RegExp(`\\s${pair.split(":")[0].trim()}="[^"]*"`), ""), tag)
      );
  }
  return text;
}

/** String literals in JS; the visible text of an HTML page */
function strings(file, text) {
  if (file.endsWith(".html")) return text.replace(/<[^>]*>/g, "\n").split("\n");
  return [...text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]);
}

test("no Swedish is left outside the text tables", () => {
  const found = [];
  for (const { file, text } of sources) {
    const visible = visibleText(file, text);
    visible.split("\n").forEach((line, i) => {
      if (/[åäöÅÄÖ]/.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
    });
    for (const s of strings(file, visible)) {
      if (!/[åäöÅÄÖ]/.test(s) && SWEDISH_WORDS.test(s)) found.push(`${file}: "${s.trim()}"`);
    }
  }
  assert.equal(found.length, 0, `Swedish outside the text tables:\n${found.join("\n")}`);
});
