/**
 * Swedish or English (issue #30).
 *
 * The website asks for its language on every call; anyone else gets Swedish
 * unless English comes first. The camera app is Swedish only, and iOS asks
 * for English on its behalf, so it must get Swedish whatever it says.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { linkLang, requestLang, say } from "../i18n.js";
import { requireAdminAuth } from "../auth.js";
import authRoutes from "../routes/auth-routes.js";
import { mutableConfig } from "../config.js";

const asking = (headers: Record<string, string>) => requestLang({ headers });

describe("requestLang", () => {
  it("is Swedish without a header", () => {
    expect(asking({})).toBe("sv");
  });

  it("follows the website's header", () => {
    expect(asking({ "accept-language": "sv" })).toBe("sv");
    expect(asking({ "accept-language": "en" })).toBe("en");
  });

  it("goes by the first language a browser asks for", () => {
    expect(asking({ "accept-language": "en-GB,en;q=0.9,sv;q=0.8" })).toBe("en");
    expect(asking({ "accept-language": "EN-us" })).toBe("en");
    expect(asking({ "accept-language": "sv-SE,sv;q=0.9,en;q=0.8" })).toBe("sv");
    expect(asking({ "accept-language": "de-DE,en;q=0.9" })).toBe("sv");
    expect(asking({ "accept-language": "english" })).toBe("sv");
  });

  it("keeps the camera app Swedish, whatever iOS asks for", () => {
    const ios = { "accept-language": "en-GB,en;q=0.9", "user-agent": "CourtsideCamera/5 CFNetwork/1568.100.1 Darwin/24.0.0" };
    expect(asking(ios)).toBe("sv");
    expect(asking({ "accept-language": "en", "x-device-token": "token" })).toBe("sv");
    expect(asking({ "accept-language": "en", "x-courtside-app-version": "1.3.0" })).toBe("sv");
  });

  it("picks the message in that language", () => {
    const text = { sv: "Fel kod", en: "Wrong code" };
    expect(say({ headers: {} }, text)).toBe("Fel kod");
    expect(say({ headers: { "accept-language": "en" } }, text)).toBe("Wrong code");
  });
});

describe("linkLang", () => {
  it("is English only for ?lang=en", () => {
    expect(linkLang("en")).toBe("en");
    expect(linkLang(undefined)).toBe("sv");
    expect(linkLang("sv")).toBe("sv");
    expect(linkLang(["en", "en"])).toBe("sv");
  });
});

describe("messages from the routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(rateLimit, { global: false, max: 1000 });
    await app.register(authRoutes);
    app.get("/admin-only", async (request, reply) => {
      if (!requireAdminAuth(request, reply)) return;
      return { ok: true };
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mutableConfig.ADMIN_PIN = "123456";
    mutableConfig.VIEWER_PIN = "5678";
  });

  it("answer a wrong code in Swedish, or in English when asked", async () => {
    const wrong = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/auth/admin", payload: { pin: "000000" }, headers });

    const sv = await wrong({});
    expect(sv.statusCode).toBe(401);
    expect(sv.json()).toEqual({ error: "Fel admin-kod" });

    const en = await wrong({ "accept-language": "en" });
    expect(en.statusCode).toBe(401);
    expect(en.json()).toEqual({ error: "Wrong admin code" });
  });

  it("say why the admin view is closed in either language", async () => {
    expect((await app.inject({ url: "/admin-only" })).json().error).toBe("Admin-åtkomst krävs");
    expect((await app.inject({ url: "/admin-only", headers: { "accept-language": "en" } })).json().error).toBe(
      "Admin access required",
    );
  });
});
