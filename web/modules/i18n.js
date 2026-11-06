// === Language: Swedish or English (issue #30) ===
// Every word the site shows lives in web/i18n/<area>.js, Swedish and English
// side by side. Code asks for text with t("area.key"); static HTML marks its
// text with data-i18n attributes, filled in by applyStatic() at startup.
//
// The language is chosen once per page load. Switching stores the choice and
// reloads, so no module has to re-render text it has already drawn.

import strings from "../i18n/index.js";

const STORAGE_KEY = "courtside:lang";
const LANGS = ["sv", "en"];

function detect() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch {}
  // First visit: Swedish for anyone who reads Swedish, English for the rest.
  const prefs = navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language || ""];
  return prefs.some((l) => /^sv\b/i.test(l)) ? "sv" : "en";
}

/** "sv" or "en" — fixed for the lifetime of the page */
export const lang = detect();

/** Locale for toLocaleString and friends */
export function locale() {
  return lang === "en" ? "en-GB" : "sv-SE";
}

/**
 * Text for a key such as "vod.highlights". `vars` fills {name} placeholders,
 * or is passed to the entry when the entry is a function (plurals). A key
 * missing in English falls back to Swedish; a key missing everywhere is shown
 * as is, so the gap is visible rather than blank.
 */
export function t(key, vars) {
  const dot = key.indexOf(".");
  const table = strings[key.slice(0, dot)];
  const k = key.slice(dot + 1);
  let s = table && (table[lang]?.[k] ?? table.sv?.[k]);
  if (s === undefined) {
    console.warn("[i18n] missing text:", key);
    return key;
  }
  if (typeof s === "function") return s(vars || {});
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  return s;
}

/**
 * Fill in text marked in HTML:
 *   data-i18n="area.key"              → textContent
 *   data-i18n-html="area.key"         → innerHTML (our own strings only)
 *   data-i18n-attr="aria-label:area.key;placeholder:area.other"
 */
export function applyStatic(root = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  root.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    el.dataset.i18nAttr.split(";").forEach((pair) => {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
  initLangSwitch(root);
}

/** Store a language and reload the page in it */
export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {}
  location.reload();
}

/** SV/EN buttons, marked data-lang-switch: each offers the other language */
function initLangSwitch(root) {
  const other = lang === "sv" ? "en" : "sv";
  root.querySelectorAll("[data-lang-switch]").forEach((btn) => {
    btn.innerHTML = `<span aria-hidden="true">${t("common.langFlag")}</span> ${other.toUpperCase()}`;
    btn.lang = other;
    btn.setAttribute("aria-label", t("common.langSwitch"));
    btn.title = t("common.langName");
    btn.addEventListener("click", () => setLang(other));
  });
}

/**
 * API requests carry the chosen language, so error messages from the server
 * come back in it. Wraps fetch once for the whole page; requests to other
 * hosts keep the browser's own header.
 */
export function sendLanguageToApi(apiUrl) {
  const base = new URL(apiUrl || "/", location.href).origin;
  const plain = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const url = new URL(isRequest ? input.url : String(input), location.href);
    if (url.origin !== base) return plain(input, init);
    const headers = new Headers(init.headers || (isRequest ? input.headers : undefined));
    if (!headers.has("Accept-Language")) headers.set("Accept-Language", lang);
    return plain(input, { ...init, headers });
  };
}
