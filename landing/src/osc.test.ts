import { describe, expect, it } from "vitest";
import { whenListed } from "./osc.js";

describe("whenListed", () => {
  it("waits until a new instance can be looked up", async () => {
    let lookups = 0;
    await whenListed(async () => (++lookups < 3 ? undefined : { name: "x" }), "x", 1000, 1);
    expect(lookups).toBe(3);
  });

  it("treats a failing lookup as not there yet", async () => {
    let lookups = 0;
    await whenListed(async () => {
      if (++lookups < 2) throw new Error("Instance x of service minio-minio not found");
      return { name: "x" };
    }, "x", 1000, 1);
    expect(lookups).toBe(2);
  });

  it("gives up after the deadline", async () => {
    await expect(whenListed(async () => undefined, "minio-minio x", 20, 1)).rejects.toThrow(/never showed up/);
  });
});
