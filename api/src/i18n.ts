/**
 * Swedish or English, for the text the API sends a person (issue #30).
 *
 * The website sends `Accept-Language: sv` or `en` with every call, and a
 * browser reaching the API directly sends its own. English when the first
 * language asked for is English, Swedish otherwise.
 *
 * The camera app is Swedish only, but it has no localisations, so iOS asks
 * for its development language, English. A request from the camera is
 * Swedish whatever its header says.
 *
 * Codes such as `error: "not_paired"` are for programs and stay as they are.
 */
export type Lang = "sv" | "en";

/** One message in both languages. */
export interface Text {
  sv: string;
  en: string;
}

type RequestLike = { headers: Record<string, string | string[] | undefined> };

/** The camera's own headers, or failing those (pairing sends neither) a native iOS client. */
function fromCamera(headers: RequestLike["headers"]): boolean {
  return !!headers["x-device-token"] || !!headers["x-courtside-app-version"] || /\bCFNetwork\//.test(String(headers["user-agent"] ?? ""));
}

export function requestLang(request: RequestLike): Lang {
  if (fromCamera(request.headers)) return "sv";
  const first = String(request.headers["accept-language"] ?? "").split(",")[0].split(";")[0].trim().toLowerCase();
  return first === "en" || first.startsWith("en-") ? "en" : "sv";
}

/** The message in the language the request asks for. */
export function say(request: RequestLike, text: Text): string {
  return text[requestLang(request)];
}

/**
 * Link previews are fetched by chat apps, which send no language of ours: the
 * shared link says it instead, `?lang=en`. Without it, Swedish, as links
 * shared before there was English.
 */
export function linkLang(lang: unknown): Lang {
  return lang === "en" ? "en" : "sv";
}
