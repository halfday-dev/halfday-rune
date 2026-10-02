/**
 * Regression: .age files written by the v0.6.x encrypt() must keep
 * decrypting, byte for byte, through the public decrypt path. The files in
 * tests/fixtures/regression/ were produced ONCE by the unrefactored code
 * with throwaway identities (see tests/fixtures/generate-regression.ts);
 * they are committed and are the source of truth. Never touches ~/.age or
 * a real vault.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { decryptToString } from "../src/crypto";

const dir = path.join(__dirname, "fixtures", "regression");
const readIdent = (name: string) =>
  fs
    .readFileSync(path.join(dir, name), "utf8")
    .split("\n")
    .find((l) => l.startsWith("AGE-SECRET-KEY-1"))!;
const readAge = (name: string) => new Uint8Array(fs.readFileSync(path.join(dir, name)));

// Expected plaintext is written out here independently of the generator.
const UNICODE =
  "emoji 🌿🔐👩‍👩‍👧 / combining é ä ñ / CJK 日本語のテキスト 漢字 한국어\n";
const TEN_KB = Array.from(
  { length: 150 },
  (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog 0123456789`
).join("\n");

describe("regression fixtures (v0.6.8 encrypt output)", () => {
  const test = readIdent("test.identity");
  const second = readIdent("second.identity");

  it("empty string", async () => {
    expect(await decryptToString(test, readAge("empty.age"))).toBe("");
  });

  it("unicode text (emoji, combining marks, CJK)", async () => {
    expect(await decryptToString(test, readAge("unicode.age"))).toBe(UNICODE);
  });

  it("~10 KB text", async () => {
    expect(TEN_KB.length).toBeGreaterThan(9000);
    expect(await decryptToString(test, readAge("10kb.age"))).toBe(TEN_KB);
  });

  it("two recipients: either identity decrypts", async () => {
    const want = "encrypted to two recipients\n";
    expect(await decryptToString(test, readAge("two-recipients.age"))).toBe(want);
    expect(await decryptToString(second, readAge("two-recipients.age"))).toBe(want);
  });

  it("a single-recipient file rejects the wrong identity", async () => {
    await expect(decryptToString(second, readAge("empty.age"))).rejects.toThrow();
  });
});
