/**
 * The contact form.  A visitor's message is mailed to whoever runs this page,
 * with the visitor as Reply-To, so an answer goes straight back to them.
 *
 * Configured from the environment.  Without SMTP_HOST and CONTACT_TO the form
 * answers 503 and the page points to e-mail instead.
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
 *   EMAIL_FROM   the sender; default SMTP_USER
 *   CONTACT_TO   where messages go
 */

import nodemailer from "nodemailer";

export interface Message {
  name: string;
  email: string;
  club: string;
  message: string;
  lang: "sv" | "en";
}

export interface Mail {
  subject: string;
  text: string;
  replyTo: { name: string; address: string };
}

/** What the page shows: a field to fix, or why nothing was sent. */
export type Problem = "name" | "email" | "message" | "rate" | "unavailable" | "failed";

/** A form filled in faster than this was filled in by a script. */
const MIN_FILL_MS = 3000;
/** Per visitor, and for everyone together, so a flood cannot fill the inbox. */
const PER_IP = 5;
const IN_TOTAL = 60;
const WINDOW_MS = 60 * 60_000;

const EMAIL = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]{2,}$/;

/** One line of text, at most `max` characters. */
const line = (v: unknown, max: number) => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

export type Checked = { ok: true; msg: Message } | { ok: false; problem: Problem } | { ok: false; bot: true };

export function check(body: unknown, now = Date.now()): Checked {
  const b = (body ?? {}) as Record<string, unknown>;
  // A field people never see, and a form sent the moment it appeared: a bot,
  // which is told all went well so it does not try again.
  if (line(b.website, 200)) return { ok: false, bot: true };
  const shown = Number(b.t);
  if (!Number.isFinite(shown) || now - shown < MIN_FILL_MS) return { ok: false, bot: true };

  const name = line(b.name, 100);
  const email = line(b.email, 200);
  const club = line(b.club, 120);
  const message = String(b.message ?? "").replace(/\r\n?/g, "\n").trim().slice(0, 5000);
  if (!name) return { ok: false, problem: "name" };
  if (!EMAIL.test(email)) return { ok: false, problem: "email" };
  if (message.length < 10) return { ok: false, problem: "message" };
  return { ok: true, msg: { name, email, club, message, lang: b.lang === "en" ? "en" : "sv" } };
}

export function compose(m: Message): Mail {
  return {
    subject: `Courtside: ${m.name}${m.club ? ` (${m.club})` : ""}`,
    text: [
      `Från: ${m.name} <${m.email}>`,
      `Förening: ${m.club || "–"}`,
      `Sida: ${m.lang === "en" ? "engelska" : "svenska"}`,
      "",
      m.message,
      "",
      "Svara på det här mejlet så går svaret till avsändaren.",
    ].join("\n"),
    replyTo: { name: m.name, address: m.email },
  };
}

/** Remembers recent messages per visitor and in total. */
export function limiter(perIp = PER_IP, inTotal = IN_TOTAL, windowMs = WINDOW_MS) {
  const seen = new Map<string, number[]>();
  let all: number[] = [];
  return (ip: string, now = Date.now()): boolean => {
    const recent = (seen.get(ip) ?? []).filter((t) => now - t < windowMs);
    all = all.filter((t) => now - t < windowMs);
    if (recent.length >= perIp || all.length >= inTotal) {
      seen.set(ip, recent);
      return false;
    }
    recent.push(now);
    all.push(now);
    seen.set(ip, recent);
    // Forget visitors whose window has passed, so the map does not grow forever.
    if (seen.size > 1000) for (const [k, v] of seen) if (!v.some((t) => now - t < windowMs)) seen.delete(k);
    return true;
  };
}

export type Send = (mail: Mail) => Promise<void>;

/** Sends with SMTP from the environment, or undefined if it is not configured. */
export function smtpFromEnv(env = process.env): Send | undefined {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, EMAIL_FROM, CONTACT_TO } = env;
  if (!SMTP_HOST || !CONTACT_TO) return undefined;
  const port = Number(SMTP_PORT || 587);
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: SMTP_SECURE ? SMTP_SECURE === "true" : port === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  const from = EMAIL_FROM || SMTP_USER;
  return async (mail) => {
    await transport.sendMail({ from: { name: "Courtside", address: from! }, to: CONTACT_TO, ...mail });
  };
}

/** The whole request: what to answer, and with which status. */
export function contact(send: Send | undefined, allow = limiter(), onError: (err: unknown) => void = () => {}) {
  return async (body: unknown, ip: string): Promise<{ status: number; body: { ok: true } | { error: Problem } }> => {
    const c = check(body);
    if (!c.ok && "bot" in c) return { status: 200, body: { ok: true } };
    if (!c.ok) return { status: 400, body: { error: c.problem } };
    if (!send) return { status: 503, body: { error: "unavailable" } };
    if (!allow(ip)) return { status: 429, body: { error: "rate" } };
    try {
      await send(compose(c.msg));
      return { status: 200, body: { ok: true } };
    } catch (err) {
      onError(err);
      return { status: 502, body: { error: "failed" } };
    }
  };
}
