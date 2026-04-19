/**
 * Vitest for the pure crypto helpers. Runs in Node — no Obsidian needed.
 * Scoped for v0.1: exercise the age-encryption package end-to-end and
 * verify the file-reading helpers.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateIdentity,
  identityToRecipient,
} from "age-encryption";
import {
  decryptToString,
  encrypt,
  expandHome,
  readIdentity,
  readRecipient,
  roundTrip,
} from "../src/crypto";

describe("expandHome", () => {
  it("expands ~/foo to $HOME/foo", () => {
    expect(expandHome("~/foo")).toBe(path.join(os.homedir(), "foo"));
  });

  it("expands bare ~ to $HOME", () => {
    expect(expandHome("~")).toBe(os.homedir());
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandHome("/tmp/x")).toBe("/tmp/x");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandHome("./x")).toBe("./x");
  });
});

describe("roundTrip (X25519)", () => {
  it("round-trips a short ASCII string", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext = "hello halfday-rune";
    const decoded = await roundTrip(recipient, identity, plaintext);
    expect(decoded).toBe(plaintext);
  });

  it("round-trips unicode", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext = "hello — ñ 日本 🧿";
    const decoded = await roundTrip(recipient, identity, plaintext);
    expect(decoded).toBe(plaintext);
  });

  it("round-trips a medium-sized buffer (~10 KB of text)", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext = "line of text.\n".repeat(1000);
    const decoded = await roundTrip(recipient, identity, plaintext);
    expect(decoded).toBe(plaintext);
  });

  it("fails to decrypt with a wrong identity", async () => {
    const id1 = await generateIdentity();
    const recipient1 = await identityToRecipient(id1);
    const id2 = await generateIdentity();
    await expect(
      roundTrip(recipient1, id2, "secret")
    ).rejects.toThrow();
  });
});

describe("encrypt + decryptToString (v0.2 primitives)", () => {
  it("round-trips a short ASCII string through split primitives", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext = "v0.2 split primitives ok";
    const ct = await encrypt(recipient, plaintext);
    expect(ct).toBeInstanceOf(Uint8Array);
    expect(ct.byteLength).toBeGreaterThan(0);
    const decoded = await decryptToString(identity, ct);
    expect(decoded).toBe(plaintext);
  });

  it("produces a non-trivial ciphertext (larger than plaintext UTF-8 bytes)", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext = "tiny";
    const ct = await encrypt(recipient, plaintext);
    // age header + HMAC + framing overhead is always > a few bytes
    expect(ct.byteLength).toBeGreaterThan(plaintext.length);
  });

  it("round-trips unicode + large buffer via split primitives", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext =
      "# journal entry\n\nhello — ñ 日本 🧿\n" + "line of text.\n".repeat(1000);
    const ct = await encrypt(recipient, plaintext);
    const decoded = await decryptToString(identity, ct);
    expect(decoded).toBe(plaintext);
  });

  it("decryptToString with wrong identity throws", async () => {
    const id1 = await generateIdentity();
    const recipient1 = await identityToRecipient(id1);
    const id2 = await generateIdentity();
    const ct = await encrypt(recipient1, "secret");
    await expect(decryptToString(id2, ct)).rejects.toThrow();
  });
});

describe("readRecipient / readIdentity", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(
      os.tmpdir(),
      `halfday-rune-test-${process.pid}-${Date.now()}`
    );
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it("readRecipient picks the first age1 line", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    fs.writeFileSync(tmpFile, `# halfday vault recipient\n${recipient}\n`);
    expect(readRecipient(tmpFile)).toBe(recipient);
  });

  it("readIdentity picks the first AGE-SECRET-KEY-1 line", async () => {
    const identity = await generateIdentity();
    fs.writeFileSync(
      tmpFile,
      `# created: 2026-04-18T00:00:00Z\n# public key: age1abc\n${identity}\n`
    );
    expect(readIdentity(tmpFile)).toBe(identity);
  });

  it("readRecipient throws if no age1 line present", () => {
    fs.writeFileSync(tmpFile, "# nothing to see here\nsome-garbage\n");
    expect(() => readRecipient(tmpFile)).toThrow(/no age1/);
  });

  it("readIdentity throws if no AGE-SECRET-KEY-1 line present", () => {
    fs.writeFileSync(tmpFile, "# public key: age1abc\n");
    expect(() => readIdentity(tmpFile)).toThrow(/no AGE-SECRET-KEY-1/);
  });
});

describe("readRecipient + readIdentity → roundTrip (integration)", () => {
  it("reads keys from disk and round-trips", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halfday-rune-int-"));
    const recPath = path.join(tmpDir, "vault.recipient");
    const idPath = path.join(tmpDir, "vault.identity");
    fs.writeFileSync(recPath, `${recipient}\n`);
    fs.writeFileSync(
      idPath,
      `# created: 2026-04-18T00:00:00Z\n# public key: ${recipient}\n${identity}\n`
    );
    try {
      const r = readRecipient(recPath);
      const i = readIdentity(idPath);
      const decoded = await roundTrip(r, i, "integration hello");
      expect(decoded).toBe("integration hello");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
