import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createViewerToken,
  createAdminToken,
  isValidViewerToken,
  isValidAdminToken,
} from "../auth.js";
import { mutableConfig } from "../config.js";

describe("auth token management", () => {
  beforeEach(() => {
    mutableConfig.ADMIN_PIN = "1234";
    mutableConfig.VIEWER_PIN = "5678";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createViewerToken / isValidViewerToken", () => {
    it("validates a freshly created token", () => {
      expect(isValidViewerToken(createViewerToken())).toBe(true);
    });

    it("rejects an unknown token", () => {
      expect(isValidViewerToken("not-a-real-token")).toBe(false);
    });

    it("rejects an expired token", () => {
      const token = createViewerToken();
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      expect(isValidViewerToken(token)).toBe(false);
    });

    it("rejects a token with a stretched expiry", () => {
      const [role, exp, nonce, sig] = createViewerToken().split(".");
      expect(isValidViewerToken(`${role}.${Number(exp) + 1}.${nonce}.${sig}`)).toBe(false);
    });

    it("stops working when the viewer PIN changes", () => {
      const token = createViewerToken();
      mutableConfig.VIEWER_PIN = "8765";
      expect(isValidViewerToken(token)).toBe(false);
    });
  });

  describe("createAdminToken / isValidAdminToken", () => {
    it("validates a freshly created token", () => {
      expect(isValidAdminToken(createAdminToken())).toBe(true);
    });

    it("rejects an unknown token", () => {
      expect(isValidAdminToken("fake-admin-token")).toBe(false);
    });

    it("rejects an expired token", () => {
      const token = createAdminToken();
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      expect(isValidAdminToken(token)).toBe(false);
    });

    it("does not accept a viewer token as admin", () => {
      expect(isValidAdminToken(createViewerToken())).toBe(false);
    });

    it("stops working when the admin PIN changes", () => {
      const token = createAdminToken();
      mutableConfig.ADMIN_PIN = "4321";
      expect(isValidAdminToken(token)).toBe(false);
    });
  });

  describe("restart", () => {
    it("keeps a session valid across a restart", async () => {
      const token = createAdminToken();
      vi.resetModules();
      const fresh = await import("../auth.js");
      expect(fresh.isValidAdminToken(token)).toBe(true);
    });
  });

  describe("token uniqueness", () => {
    it("creates unique tokens each time", () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 50; i++) {
        tokens.add(createViewerToken());
      }
      expect(tokens.size).toBe(50);
    });
  });
});
