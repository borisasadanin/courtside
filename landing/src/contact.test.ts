import { describe, expect, it } from "vitest";
import { check, compose, contact, limiter, Mail, smtpFromEnv } from "./contact.js";

const now = 1_000_000;
const form = (extra: Record<string, unknown> = {}) => ({
  name: "Anna Andersson", email: "anna@example.se", club: "Älta IF",
  message: "Vi vill sända våra matcher i vår.", website: "", t: now - 10_000, lang: "sv", ...extra,
});

describe("check", () => {
  it("accepts a filled-in form", () => {
    expect(check(form(), now)).toEqual({ ok: true, msg: { name: "Anna Andersson", email: "anna@example.se", club: "Älta IF", message: "Vi vill sända våra matcher i vår.", lang: "sv" } });
  });

  it("says which field is missing", () => {
    expect(check(form({ name: " " }), now)).toEqual({ ok: false, problem: "name" });
    expect(check(form({ email: "anna" }), now)).toEqual({ ok: false, problem: "email" });
    expect(check(form({ email: "anna@example" }), now)).toEqual({ ok: false, problem: "email" });
    expect(check(form({ message: "Hej" }), now)).toEqual({ ok: false, problem: "message" });
  });

  it("takes the honeypot and a form sent too fast for a bot", () => {
    expect(check(form({ website: "http://spam.example" }), now)).toEqual({ ok: false, bot: true });
    expect(check(form({ t: now - 500 }), now)).toEqual({ ok: false, bot: true });
    expect(check(form({ t: undefined }), now)).toEqual({ ok: false, bot: true });
  });

  it("keeps header fields on one line", () => {
    const c = check(form({ name: "Anna\r\nBcc: x@example.se", club: "A\nB" }), now);
    expect(c.ok && c.msg.name).toBe("Anna Bcc: x@example.se");
    expect(c.ok && c.msg.club).toBe("A B");
  });
});

describe("compose", () => {
  it("replies to the visitor and names the club in the subject", () => {
    const m = compose({ name: "Anna", email: "anna@example.se", club: "Älta IF", message: "Hej hej hej hej", lang: "en" });
    expect(m.subject).toBe("Courtside: Anna (Älta IF)");
    expect(m.replyTo).toEqual({ name: "Anna", address: "anna@example.se" });
    expect(m.text).toContain("Sida: engelska");
    expect(m.text).toContain("Hej hej hej hej");
  });
});

describe("limiter", () => {
  it("lets a visitor send a few, then waits out the window", () => {
    const allow = limiter(2, 100, 1000);
    expect([allow("a", 0), allow("a", 1), allow("a", 2)]).toEqual([true, true, false]);
    expect(allow("b", 3)).toBe(true);
    expect(allow("a", 1001)).toBe(true);
  });

  it("caps everyone together", () => {
    const allow = limiter(10, 2, 1000);
    expect([allow("a", 0), allow("b", 0), allow("c", 0)]).toEqual([true, true, false]);
  });
});

describe("contact", () => {
  const body = () => form({ t: Date.now() - 10_000 });

  it("sends the message", async () => {
    const sent: Mail[] = [];
    const r = await contact(async (m) => { sent.push(m); })(body(), "1.2.3.4");
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(sent).toHaveLength(1);
  });

  it("tells a bot all went well but sends nothing", async () => {
    const sent: Mail[] = [];
    const r = await contact(async (m) => { sent.push(m); })(form({ website: "x", t: Date.now() - 10_000 }), "1.2.3.4");
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("answers 503 without mail configured, 429 when limited and 502 when sending fails", async () => {
    expect((await contact(undefined)(body(), "ip")).status).toBe(503);
    expect((await contact(async () => {}, () => false)(body(), "ip")).status).toBe(429);
    expect(await contact(async () => { throw new Error("smtp"); })(body(), "ip")).toEqual({ status: 502, body: { error: "failed" } });
  });
});

describe("smtpFromEnv", () => {
  it("needs a server and a recipient", () => {
    expect(smtpFromEnv({})).toBeUndefined();
    expect(smtpFromEnv({ SMTP_HOST: "smtp.example.se" })).toBeUndefined();
    expect(smtpFromEnv({ SMTP_HOST: "smtp.example.se", CONTACT_TO: "me@example.se" })).toBeTypeOf("function");
  });
});
