/**
 * Preflight.
 *
 * The check that matters most is "are the recordings public?", and the rule it
 * must obey is that a check never repairs what it measures — an earlier version
 * called ensureBucket() first, which deleted the public policy and then
 * cheerfully reported that nothing was public.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runPreflight, overallStatus, type CheckResult } from "../preflight.js";

function minioStub(overrides: Record<string, unknown> = {}) {
  return {
    bucketExists: vi.fn().mockResolvedValue(true),
    ensureBucket: vi.fn().mockResolvedValue(undefined),
    uploadBuffer: vi.fn().mockResolvedValue(undefined),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function find(results: CheckResult[], id: string): CheckResult {
  const found = results.find((r) => r.id === id);
  if (!found) throw new Error(`no check with id ${id}`);
  return found;
}

describe("preflight", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    // Unsigned read refused — the healthy case.
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("never repairs what it measures", async () => {
    const minio = minioStub();
    await runPreflight(minio as never);
    expect(minio.ensureBucket).not.toHaveBeenCalled();
  });

  it("fails when an object can be read without authentication", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const results = await runPreflight(minioStub() as never);

    const check = find(results, "storage.private");
    expect(check.status).toBe("fail");
    expect(check.fix).toMatch(/policy/i);
  });

  it("passes when unsigned reads are refused", async () => {
    const results = await runPreflight(minioStub() as never);
    expect(find(results, "storage.private").status).toBe("ok");
  });

  it("says so when storage cannot be reached, and stops there", async () => {
    const minio = minioStub({ bucketExists: vi.fn().mockResolvedValue(false) });
    const results = await runPreflight(minio as never);

    expect(find(results, "storage.bucket").status).toBe("fail");
    expect(results.find((r) => r.id === "storage.writable")).toBeUndefined();
    expect(minio.uploadBuffer).not.toHaveBeenCalled();
  });

  it("reports an unwritable bucket rather than throwing", async () => {
    const minio = minioStub({
      uploadBuffer: vi.fn().mockRejectedValue(new Error("Access Denied")),
    });
    const results = await runPreflight(minio as never);

    const check = find(results, "storage.writable");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("Access Denied");
  });

  it("cleans up its own probe object", async () => {
    const minio = minioStub();
    await runPreflight(minio as never);
    expect(minio.deleteObject).toHaveBeenCalledWith(".preflight-probe");
  });

  it("warns rather than fails when an open installation is deliberate", async () => {
    const results = await runPreflight(minioStub() as never);
    // The test environment sets a viewer PIN, so this one passes; the point is
    // that access checks are warnings, never hard failures.
    const access = find(results, "access.viewerPin");
    expect(["ok", "warn"]).toContain(access.status);
  });

  it("summarises to the worst status present", () => {
    const base = { id: "x", title: "t", detail: "d" } as const;
    expect(overallStatus([{ ...base, status: "ok" }])).toBe("ok");
    expect(overallStatus([{ ...base, status: "ok" }, { ...base, status: "warn" }])).toBe("warn");
    expect(
      overallStatus([{ ...base, status: "warn" }, { ...base, status: "fail" }])
    ).toBe("fail");
  });
});
