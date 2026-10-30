import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { createHash } from "crypto";

function hash(file) {
  const h = createHash("md5").update(readFileSync(file)).digest("hex").slice(0, 8);
  return h;
}

// Polyfill for Promise.allSettled (missing in Chrome < 76)
const polyfill = `if(!Promise.allSettled){Promise.allSettled=function(e){return Promise.all(Array.from(e).map(function(p){return Promise.resolve(p).then(function(v){return{status:"fulfilled",value:v}},function(r){return{status:"rejected",reason:r}})}))}}`;

// Clean & create dist.  Without the clean, hashed assets from earlier builds
// pile up and get published alongside the current ones.
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/assets", { recursive: true });

// 1. Bundle main entry (player.js) → IIFE, ES2015
await esbuild.build({
  entryPoints: ["player.js"],
  bundle: true,
  format: "iife",
  target: "es2015",
  outfile: "dist/assets/bundle.js",
  minify: true,
  sourcemap: false,
  banner: { js: polyfill },
});

// 2. Bundle clip entry (clip.js) → IIFE, ES2015
await esbuild.build({
  entryPoints: ["clip.js"],
  bundle: true,
  format: "iife",
  target: "es2015",
  outfile: "dist/assets/clip-bundle.js",
  minify: true,
  sourcemap: false,
});

// 3. Copy static assets
cpSync("style.css", "dist/assets/style.css");
cpSync("icon.png", "dist/assets/icon.png");
cpSync("courtside.png", "dist/assets/courtside.png");
// Served as-is and never bundled, so a club can repoint the backend without
// rebuilding. Deliberately unhashed.
cpSync("runtime-config.js", "dist/runtime-config.js");
try { cpSync("background.jpg", "dist/assets/background.jpg"); } catch {}

// 4. Generate hashed filenames for cache busting
const bundleHash = hash("dist/assets/bundle.js");
const clipHash = hash("dist/assets/clip-bundle.js");
const cssHash = hash("dist/assets/style.css");
const iconHash = hash("dist/assets/icon.png");
const courtsideHash = hash("dist/assets/courtside.png");

cpSync("dist/assets/bundle.js", `dist/assets/bundle-${bundleHash}.js`);
cpSync("dist/assets/clip-bundle.js", `dist/assets/clip-${clipHash}.js`);
cpSync("dist/assets/style.css", `dist/assets/style-${cssHash}.css`);
cpSync("dist/assets/icon.png", `dist/assets/icon-${iconHash}.png`);
cpSync("dist/assets/courtside.png", `dist/assets/courtside-${courtsideHash}.png`);
try {
  const bgHash = hash("dist/assets/background.jpg");
  cpSync("dist/assets/background.jpg", `dist/assets/background-${bgHash}.jpg`);
} catch {}

// 5. Process HTML files — replace asset references
function processHtml(src, dest, scriptFile) {
  let html = readFileSync(src, "utf-8");

  // Replace icon references
  html = html.replace(/(?:src|href)="icon\.png"/g, (m) =>
    m.replace("icon.png", `assets/icon-${iconHash}.png`)
  );
  html = html.replace(/src="courtside\.png"/g, `src="assets/courtside-${courtsideHash}.png"`);
  // Point og:image at the hashed asset. The absolute URL is filled in at
  // runtime from the club manifest — the build cannot know which domain this
  // installation will be served from.
  html = html.replace(
    /<meta property="og:image" content="[^"]*">/,
    `<meta property="og:image" content="/assets/icon-${iconHash}.png">`
  );

  // Replace stylesheet
  html = html.replace(
    /<link rel="stylesheet" href="style\.css">/,
    `<link rel="stylesheet" href="/assets/style-${cssHash}.css">`
  );

  // Replace script tag — use plain <script> (no type="module")
  html = html.replace(
    /<script type="module" src="[^"]*"><\/script>/,
    `<script src="/assets/${scriptFile}"></script>`
  );

  writeFileSync(dest, html);
}

processHtml("index.html", "dist/index.html", `bundle-${bundleHash}.js`);
processHtml("clip.html", "dist/clip.html", `clip-${clipHash}.js`);

// 6. Fix background image reference in CSS
{
  let css = readFileSync("dist/assets/style.css", "utf-8");
  // A club that supplies background.jpg gets it hashed and wired up; without
  // one, nothing references it.
  try {
    const bgHash = hash("dist/assets/background.jpg");
    css = `:root { --empty-bg: url("background-${bgHash}.jpg"); }\n` + css;
  } catch {}
  writeFileSync(`dist/assets/style-${cssHash}.css`, css);
}

console.log("Build complete!");
console.log(`  dist/index.html`);
console.log(`  dist/clip.html`);
console.log(`  dist/assets/bundle-${bundleHash}.js`);
console.log(`  dist/assets/clip-${clipHash}.js`);
console.log(`  dist/assets/style-${cssHash}.css`);
