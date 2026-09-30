/**
 * Config contract: an installation must supply its own identity and secrets.
 *
 * These tests exist to keep built-in defaults from creeping back in.  A default
 * API key or PIN in the source would be shared by every club that deploys the
 * kit, which is the same as having no secret at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** The variables an installation cannot start without. */
const REQUIRED = [
  "API_KEY",
  "ADMIN_PIN",
  "OSC_ACCESS_TOKEN",
  "OSC_TENANT",
  "MINIO_ENDPOINT",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
] as const;

describe("config validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.API_KEY = "test-key";
    process.env.ADMIN_PIN = "1234";
    process.env.VIEWER_PIN = "5678";
    process.env.OSC_ACCESS_TOKEN = "test-pat";
    process.env.OSC_TENANT = "testtenant";
    process.env.MINIO_ENDPOINT = "https://minio.example.com";
    process.env.MINIO_ACCESS_KEY = "minioaccess";
    process.env.MINIO_SECRET_KEY = "miniosecret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  for (const name of REQUIRED) {
    it(`exits when ${name} is missing`, async () => {
      delete process.env[name];
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        import("../config.js").then((m) => m.validateConfig())
      ).rejects.toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(name));
    });
  }

  it("reports every missing variable at once, not just the first", async () => {
    delete process.env.API_KEY;
    delete process.env.MINIO_SECRET_KEY;
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      import("../config.js").then((m) => m.validateConfig())
    ).rejects.toThrow("process.exit called");

    const message = errorSpy.mock.calls[0][0] as string;
    expect(message).toContain("API_KEY");
    expect(message).toContain("MINIO_SECRET_KEY");
  });

  it("carries no built-in credentials", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../config.ts", import.meta.url), "utf-8")
    );
    // Credentials must never appear as literals with a fallback.
    expect(source).not.toMatch(/API_KEY\s*=\s*process\.env\.\w+\s*\|\|\s*"[^"]+"/);
    expect(source).not.toMatch(/ADMIN_PIN\s*=\s*process\.env\.\w+\s*\|\|\s*"[^"]+"/);
    expect(source).not.toMatch(/MINIO_SECRET_KEY\s*=\s*process\.env\.\w+\s*\|\|\s*"[^"]+"/);
    // And no tenant may be hardcoded.
    expect(source).not.toContain("borispriv");
  });

  it("allows an open installation but warns about it", async () => {
    delete process.env.VIEWER_PIN;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await import("../config.js");
    mod.validateConfig();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mod.config.VIEWER_PIN).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("VIEWER_PIN"));
  });

  it("derives the Restreamer URL from tenant, instance and region", async () => {
    process.env.OSC_TENANT = "myclub";
    process.env.OSC_INSTANCE_NAME = "restreamer";
    process.env.OSC_REGION = "prod-se";
    delete process.env.RESTREAMER_URL;

    const mod = await import("../config.js");
    expect(mod.config.RESTREAMER_URL).toBe(
      "https://myclub-restreamer.datarhei-restreamer.auto.prod-se.osaas.io"
    );
  });

  it("lets an explicit RESTREAMER_URL win over the derived one", async () => {
    process.env.RESTREAMER_URL = "https://restreamer.internal";
    const mod = await import("../config.js");
    expect(mod.config.RESTREAMER_URL).toBe("https://restreamer.internal");
  });

  it("parses CORS_ORIGINS into a trimmed list", async () => {
    process.env.CORS_ORIGINS = "https://a.example.com, https://b.example.com/ ,";
    const mod = await import("../config.js");
    expect(mod.config.CORS_ORIGINS).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("passes validation when everything required is set", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    const mod = await import("../config.js");
    mod.validateConfig();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mod.config.API_KEY).toBe("test-key");
    expect(mod.config.MINIO_ACCESS_KEY).toBe("minioaccess");
  });
});
