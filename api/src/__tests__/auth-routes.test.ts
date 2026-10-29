/**
 * Signing in with a code. The admin code must work whether or not watching
 * needs a code of its own.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import authRoutes from "../routes/auth-routes.js";
import { mutableConfig } from "../config.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(rateLimit, { global: false, max: 1000 });
  await app.register(authRoutes);
});

afterAll(async () => {
  await app.close();
});

function verify(pin?: string) {
  return app.inject({ method: "POST", url: "/api/auth/verify", payload: pin ? { pin } : {} });
}

describe("POST /api/auth/verify", () => {
  describe("with a viewer code", () => {
    beforeEach(() => {
      mutableConfig.ADMIN_PIN = "123456";
      mutableConfig.VIEWER_PIN = "5678";
    });

    it("lets the admin in as admin", async () => {
      const res = await verify("123456");
      expect(res.json().role).toBe("admin");
      expect(res.json().adminToken).toBeTruthy();
    });

    it("lets a viewer in as viewer", async () => {
      expect((await verify("5678")).json().role).toBe("viewer");
    });

    it("turns a wrong code away", async () => {
      expect((await verify("0000")).statusCode).toBe(401);
    });
  });

  describe("when watching needs no code", () => {
    beforeEach(() => {
      mutableConfig.ADMIN_PIN = "123456";
      mutableConfig.VIEWER_PIN = "";
    });

    it("still lets the admin in as admin", async () => {
      const res = await verify("123456");
      expect(res.statusCode).toBe(200);
      expect(res.json().role).toBe("admin");
    });

    it("says a mistyped admin code is wrong", async () => {
      expect((await verify("654321")).statusCode).toBe(401);
    });

    it("lets anyone watch without a code", async () => {
      expect((await verify()).json().role).toBe("viewer");
    });
  });

  it("never treats an empty admin code as a match", async () => {
    mutableConfig.ADMIN_PIN = "";
    mutableConfig.VIEWER_PIN = "";
    expect((await verify()).json().role).toBe("viewer");
  });
});
