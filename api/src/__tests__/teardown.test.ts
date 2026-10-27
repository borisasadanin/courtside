import { describe, expect, it } from "vitest";
import { clubOf } from "../teardown.js";

describe("clubOf", () => {
  it("reads the short name from the installer's process prefix", () => {
    expect(clubOf("myclub-")).toBe("myclub");
  });
  it("refuses anything the installer would not have made", () => {
    expect(clubOf("cs-")).toBeUndefined();
    expect(clubOf("myclub")).toBeUndefined();
    expect(clubOf("My-")).toBeUndefined();
  });
});
