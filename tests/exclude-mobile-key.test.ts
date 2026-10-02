import { describe, it, expect, vi } from "vitest";
import { isExcludedPath, foldPath } from "../src/path-fold";
import { rotateVault } from "../src/rotate";

const mkFile = (p: string) => ({ path: p, name: p.split("/").pop()!, extension: "age" });

describe("isExcludedPath", () => {
  it("folds case and Unicode form", () => {
    expect(isExcludedPath("_Rune/IDENTITY.age", ["_rune/identity.age"])).toBe(true);
    expect(foldPath("e\u0301")).toBe(foldPath("\u00e9"));
    expect(isExcludedPath("a/\u00e9.age", ["a/e\u0301.age"])).toBe(true);
    expect(isExcludedPath("_rune/other.age", ["_rune/identity.age"])).toBe(false);
  });
});

describe("rotate leaves the wrapped identity file alone", () => {
  it("never reads or writes the excluded path", async () => {
    const touched: string[] = [];
    const vault = {
      readBinary: async (f: { path: string }) => (touched.push(f.path), new ArrayBuffer(4)),
      modifyBinary: async (f: { path: string }) => void touched.push("W:" + f.path),
    };
    const files = [mkFile("a.md.age"), mkFile("_Rune/Identity.age")];
    const r = await rotateVault(
      {
        vault: vault as never,
        crypto: {
          encrypt: async () => new Uint8Array([1, 2, 3, 4]),
          decryptToString: vi.fn(async () => "x"),
        },
      } as never,
      { ageFiles: files as never, identity: "AGE-SECRET-KEY-1X", recipients: ["age1x"], excludePaths: ["_rune/identity.age"] }
    );
    expect(touched.some((t) => t.toLowerCase().includes("_rune"))).toBe(false);
    expect(r.rotated.length + r.skipped.length).toBe(1);
  });
});
