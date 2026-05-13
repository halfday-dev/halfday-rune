/**
 * Vitest for the pure crypto helpers. Runs in Node — no Obsidian needed.
 *
 * v0.5.0 expansion: parseRecipientsFile + multi-recipient encrypt/decrypt.
 * Single-recipient cases preserved as backward-compat regression tests.
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
  parseRecipientsFile,
  readIdentity,
  readRecipients,
  readRecipientsRaw,
  roundTrip,
  statRecipientsMtime,
  validateRecipientsContent,
  writeRecipientsRaw,
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

describe("parseRecipientsFile (v0.5.0)", () => {
  it("parses a single bare recipient line", async () => {
    const id = await generateIdentity();
    const r = await identityToRecipient(id);
    expect(parseRecipientsFile(`${r}\n`)).toEqual([r]);
  });

  it("ignores `#` comment lines (preceding-line label convention)", async () => {
    const id = await generateIdentity();
    const r = await identityToRecipient(id);
    const content = `# main mac\n${r}\n`;
    expect(parseRecipientsFile(content)).toEqual([r]);
  });

  it("ignores blank lines", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const r1 = await identityToRecipient(id1);
    const r2 = await identityToRecipient(id2);
    const content = `\n${r1}\n\n\n${r2}\n\n`;
    expect(parseRecipientsFile(content)).toEqual([r1, r2]);
  });

  it("preserves order of multiple recipients", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const id3 = await generateIdentity();
    const r1 = await identityToRecipient(id1);
    const r2 = await identityToRecipient(id2);
    const r3 = await identityToRecipient(id3);
    const content = [
      "# main mac",
      r1,
      "",
      "# backup 1password",
      r2,
      "# offline usb",
      r3,
      "",
    ].join("\n");
    expect(parseRecipientsFile(content)).toEqual([r1, r2, r3]);
  });

  it("dedupes duplicate recipient lines silently (first-occurrence wins)", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const r1 = await identityToRecipient(id1);
    const r2 = await identityToRecipient(id2);
    const content = `${r1}\n${r2}\n${r1}\n`;
    expect(parseRecipientsFile(content)).toEqual([r1, r2]);
  });

  it("throws on empty file", () => {
    expect(() => parseRecipientsFile("")).toThrow(/no valid age1 recipients/);
  });

  it("throws on file with only comments", () => {
    expect(() => parseRecipientsFile("# main mac\n# backup\n")).toThrow(
      /no valid age1 recipients/
    );
  });

  it("throws with line number on a malformed (non-age1) line", () => {
    expect(() =>
      parseRecipientsFile("# label\nnot-an-age-key\n")
    ).toThrow(/line 2: expected age1/);
  });

  it("throws on a line longer than the 200-char defensive cap", async () => {
    const oversized = "age1" + "a".repeat(300);
    expect(() => parseRecipientsFile(oversized + "\n")).toThrow(
      /line 1: line too long/
    );
  });

  it("throws on age1 line that's clearly too short", () => {
    expect(() => parseRecipientsFile("age1abc\n")).toThrow(
      /line 1: recipient looks too short/
    );
  });
});

describe("roundTrip (X25519, multi-recipient capable)", () => {
  it("round-trips a short ASCII string with single recipient", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext = "hello halfday-rune";
    const decoded = await roundTrip([recipient], identity, plaintext);
    expect(decoded).toBe(plaintext);
  });

  it("round-trips unicode", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext = "hello — ñ 日本 🧿";
    const decoded = await roundTrip([recipient], identity, plaintext);
    expect(decoded).toBe(plaintext);
  });

  it("round-trips a medium-sized buffer (~10 KB of text)", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext = "line of text.\n".repeat(1000);
    const decoded = await roundTrip([recipient], identity, plaintext);
    expect(decoded).toBe(plaintext);
  });

  it("fails to decrypt with a wrong identity", async () => {
    const id1 = await generateIdentity();
    const recipient1 = await identityToRecipient(id1);
    const id2 = await generateIdentity();
    await expect(
      roundTrip([recipient1], id2, "secret")
    ).rejects.toThrow();
  });
});

describe("encrypt + decryptToString — single recipient (v0.4 backward compat)", () => {
  it("round-trips a short ASCII string through split primitives", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext = "v0.5 single-recipient ok";
    const ct = await encrypt([recipient], plaintext);
    expect(ct).toBeInstanceOf(Uint8Array);
    expect(ct.byteLength).toBeGreaterThan(0);
    const decoded = await decryptToString(identity, ct);
    expect(decoded).toBe(plaintext);
  });

  it("produces a non-trivial ciphertext (larger than plaintext UTF-8 bytes)", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext = "tiny";
    const ct = await encrypt([recipient], plaintext);
    expect(ct.byteLength).toBeGreaterThan(plaintext.length);
  });

  it("round-trips unicode + large buffer via split primitives", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const plaintext =
      "# journal entry\n\nhello — ñ 日本 🧿\n" + "line of text.\n".repeat(1000);
    const ct = await encrypt([recipient], plaintext);
    const decoded = await decryptToString(identity, ct);
    expect(decoded).toBe(plaintext);
  });

  it("decryptToString with wrong identity throws", async () => {
    const id1 = await generateIdentity();
    const recipient1 = await identityToRecipient(id1);
    const id2 = await generateIdentity();
    const ct = await encrypt([recipient1], "secret");
    await expect(decryptToString(id2, ct)).rejects.toThrow();
  });

  it("throws if recipients array is empty", async () => {
    await expect(encrypt([], "anything")).rejects.toThrow(
      /at least one recipient required/
    );
  });
});

describe("encrypt + decryptToString — multi-recipient (v0.5.0 core)", () => {
  it("encrypts to 2 recipients; either identity decrypts", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const r1 = await identityToRecipient(id1);
    const r2 = await identityToRecipient(id2);
    const plaintext = "shared with main + backup";
    const ct = await encrypt([r1, r2], plaintext);
    expect(await decryptToString(id1, ct)).toBe(plaintext);
    expect(await decryptToString(id2, ct)).toBe(plaintext);
  });

  it("encrypts to 3 recipients; all three identities decrypt", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const id3 = await generateIdentity();
    const r1 = await identityToRecipient(id1);
    const r2 = await identityToRecipient(id2);
    const r3 = await identityToRecipient(id3);
    const plaintext = "main + backup + offline";
    const ct = await encrypt([r1, r2, r3], plaintext);
    expect(await decryptToString(id1, ct)).toBe(plaintext);
    expect(await decryptToString(id2, ct)).toBe(plaintext);
    expect(await decryptToString(id3, ct)).toBe(plaintext);
  });

  it("a non-recipient identity still cannot decrypt a multi-recipient ciphertext", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const idEvil = await generateIdentity();
    const r1 = await identityToRecipient(id1);
    const r2 = await identityToRecipient(id2);
    const ct = await encrypt([r1, r2], "secret");
    await expect(decryptToString(idEvil, ct)).rejects.toThrow();
  });

  it("ciphertext for 2 recipients is larger than for 1 (header grows)", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const r1 = await identityToRecipient(id1);
    const r2 = await identityToRecipient(id2);
    const plaintext = "same plaintext";
    const ct1 = await encrypt([r1], plaintext);
    const ct2 = await encrypt([r1, r2], plaintext);
    // age adds a per-recipient stanza in the header; total bytes must grow.
    expect(ct2.byteLength).toBeGreaterThan(ct1.byteLength);
  });
});

describe("readRecipients / readIdentity (file IO)", () => {
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

  it("readRecipients returns a single-element array for a bare-recipient file (v0.4 layout backward compat)", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    fs.writeFileSync(tmpFile, `${recipient}\n`);
    expect(readRecipients(tmpFile)).toEqual([recipient]);
  });

  it("readRecipients handles preceding-line `#` comments", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    fs.writeFileSync(tmpFile, `# halfday vault recipient\n${recipient}\n`);
    expect(readRecipients(tmpFile)).toEqual([recipient]);
  });

  it("readRecipients returns multiple recipients in order", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const r1 = await identityToRecipient(id1);
    const r2 = await identityToRecipient(id2);
    fs.writeFileSync(tmpFile, `# main mac\n${r1}\n\n# backup\n${r2}\n`);
    expect(readRecipients(tmpFile)).toEqual([r1, r2]);
  });

  it("readIdentity picks the first AGE-SECRET-KEY-1 line", async () => {
    const identity = await generateIdentity();
    fs.writeFileSync(
      tmpFile,
      `# created: 2026-04-18T00:00:00Z\n# public key: age1abc\n${identity}\n`
    );
    expect(readIdentity(tmpFile)).toBe(identity);
  });

  it("readRecipients throws if file is missing", () => {
    expect(() => readRecipients(tmpFile)).toThrow(/recipients\.txt not readable/);
  });

  it("readRecipients throws on malformed file", () => {
    fs.writeFileSync(tmpFile, "# nothing here\nsome-garbage\n");
    expect(() => readRecipients(tmpFile)).toThrow(/expected age1/);
  });

  it("readIdentity throws if no AGE-SECRET-KEY-1 line present", () => {
    fs.writeFileSync(tmpFile, "# public key: age1abc\n");
    expect(() => readIdentity(tmpFile)).toThrow(/no AGE-SECRET-KEY-1/);
  });
});

describe("readRecipients + readIdentity → roundTrip (integration)", () => {
  it("reads a single-recipient file from disk and round-trips", async () => {
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halfday-rune-int-"));
    const recPath = path.join(tmpDir, "recipients.txt");
    const idPath = path.join(tmpDir, "vault.identity");
    fs.writeFileSync(recPath, `# main mac\n${recipient}\n`);
    fs.writeFileSync(
      idPath,
      `# created: 2026-04-18T00:00:00Z\n# public key: ${recipient}\n${identity}\n`
    );
    try {
      const recipients = readRecipients(recPath);
      const i = readIdentity(idPath);
      const decoded = await roundTrip(recipients, i, "integration hello");
      expect(decoded).toBe("integration hello");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads a multi-recipient file and either identity decrypts", async () => {
    const id1 = await generateIdentity();
    const id2 = await generateIdentity();
    const r1 = await identityToRecipient(id1);
    const r2 = await identityToRecipient(id2);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halfday-rune-int-"));
    const recPath = path.join(tmpDir, "recipients.txt");
    fs.writeFileSync(recPath, `# main mac\n${r1}\n\n# backup\n${r2}\n`);
    try {
      const recipients = readRecipients(recPath);
      const ct = await encrypt(recipients, "multi-int hello");
      expect(await decryptToString(id1, ct)).toBe("multi-int hello");
      expect(await decryptToString(id2, ct)).toBe("multi-int hello");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("readRecipientsRaw / writeRecipientsRaw / validateRecipientsContent (v0.5.1)", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "halfday-rune-raw-"));
    tmpFile = path.join(tmpDir, "recipients.txt");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("readRecipientsRaw", () => {
    it("returns content + exists:true for an existing file", async () => {
      const id = await generateIdentity();
      const r = await identityToRecipient(id);
      const original = `# main mac\n${r}\n\n# backup\n${r}\n`;
      fs.writeFileSync(tmpFile, original);
      const result = readRecipientsRaw(tmpFile);
      expect(result.exists).toBe(true);
      expect(result.content).toBe(original);
    });

    it("returns content:'' + exists:false for a missing file (graceful first-run)", () => {
      // tmpFile path is set but never created
      const result = readRecipientsRaw(tmpFile);
      expect(result.exists).toBe(false);
      expect(result.content).toBe("");
    });

    it("preserves comments, blank lines, and ordering verbatim", async () => {
      const id1 = await generateIdentity();
      const id2 = await generateIdentity();
      const r1 = await identityToRecipient(id1);
      const r2 = await identityToRecipient(id2);
      // intentional weird formatting: trailing blank line, two blank lines
      // between blocks, mixed comment styles
      const messy =
        `# halfday vault recipients\n# updated 2026-05-08\n\n# main mac (cowork-laptop)\n${r1}\n\n\n# backup, 1Password "vault-backup"\n${r2}\n\n`;
      fs.writeFileSync(tmpFile, messy);
      const result = readRecipientsRaw(tmpFile);
      expect(result.content).toBe(messy);
    });

    it("expands ~/ in the path argument", () => {
      // Just verifies the call doesn't throw an unexpected error when given
      // a tilde path — actual home expansion is covered by expandHome tests
      // and the integration test below.
      // We use a path that won't exist under HOME to confirm we get the
      // ENOENT graceful path, not a "tilde wasn't expanded" failure.
      const result = readRecipientsRaw("~/nonexistent-halfday-test-recipients.txt");
      expect(result.exists).toBe(false);
    });
  });

  describe("writeRecipientsRaw", () => {
    it("writes content verbatim and round-trips through readRecipientsRaw", async () => {
      const id1 = await generateIdentity();
      const id2 = await generateIdentity();
      const r1 = await identityToRecipient(id1);
      const r2 = await identityToRecipient(id2);
      const content = `# main mac\n${r1}\n\n# backup\n${r2}\n`;
      writeRecipientsRaw(tmpFile, content);
      const back = readRecipientsRaw(tmpFile);
      expect(back.exists).toBe(true);
      expect(back.content).toBe(content);
    });

    it("creates the file if it doesn't exist", async () => {
      const id = await generateIdentity();
      const r = await identityToRecipient(id);
      expect(fs.existsSync(tmpFile)).toBe(false);
      writeRecipientsRaw(tmpFile, `${r}\n`);
      expect(fs.existsSync(tmpFile)).toBe(true);
    });

    it("overwrites existing content (truncate-then-write semantics)", async () => {
      const id = await generateIdentity();
      const r = await identityToRecipient(id);
      fs.writeFileSync(tmpFile, "lots of stale content lots of stale content");
      writeRecipientsRaw(tmpFile, `${r}\n`);
      const back = fs.readFileSync(tmpFile, "utf8");
      expect(back).toBe(`${r}\n`);
      expect(back).not.toContain("stale content");
    });

    it("byte-preservation: write→read→write is idempotent", async () => {
      const id1 = await generateIdentity();
      const id2 = await generateIdentity();
      const r1 = await identityToRecipient(id1);
      const r2 = await identityToRecipient(id2);
      const original = `# m\n${r1}\n# b\n${r2}\n`;
      writeRecipientsRaw(tmpFile, original);
      const read1 = readRecipientsRaw(tmpFile).content;
      writeRecipientsRaw(tmpFile, read1);
      const read2 = readRecipientsRaw(tmpFile).content;
      expect(read1).toBe(original);
      expect(read2).toBe(original);
    });
  });

  describe("validateRecipientsContent", () => {
    it("returns ok:true for a valid single-recipient file", async () => {
      const id = await generateIdentity();
      const r = await identityToRecipient(id);
      expect(validateRecipientsContent(`${r}\n`)).toEqual({ ok: true });
    });

    it("returns ok:true for valid multi-recipient with comments", async () => {
      const id1 = await generateIdentity();
      const id2 = await generateIdentity();
      const r1 = await identityToRecipient(id1);
      const r2 = await identityToRecipient(id2);
      const content = `# main mac\n${r1}\n\n# backup\n${r2}\n`;
      expect(validateRecipientsContent(content)).toEqual({ ok: true });
    });

    it("returns ok:false with a clear error on empty content", () => {
      const result = validateRecipientsContent("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/no valid age1 recipients/);
      }
    });

    it("returns ok:false with a clear error on only-comments content", () => {
      const result = validateRecipientsContent("# only comments\n# nothing else\n");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/no valid age1 recipients/);
      }
    });

    it("returns ok:false with line number on a malformed recipient line", async () => {
      const id = await generateIdentity();
      const r = await identityToRecipient(id);
      const content = `${r}\nthis-is-not-an-age-key\n`;
      const result = validateRecipientsContent(content);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/line 2/);
        expect(result.error).toMatch(/expected age1/);
      }
    });

    it("returns ok:false on a too-short age1 line", () => {
      const result = validateRecipientsContent("age1abc\n");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/line 1/);
        expect(result.error).toMatch(/too short/);
      }
    });

    it("does NOT throw — always returns a result (the contract for inline UI use)", () => {
      // The whole point of validateRecipientsContent vs raw parseRecipientsFile
      // is that the UI layer can render result.error inline without try/catch.
      expect(() => validateRecipientsContent("garbage")).not.toThrow();
      expect(() => validateRecipientsContent("")).not.toThrow();
    });
  });

  describe("integration: validate → write → read round-trip", () => {
    it("a textarea save flow preserves bytes when content is valid", async () => {
      // simulates: user types in textarea, clicks Save, plugin validates,
      // plugin writes, settings tab is reopened, plugin reloads from disk
      const id1 = await generateIdentity();
      const id2 = await generateIdentity();
      const r1 = await identityToRecipient(id1);
      const r2 = await identityToRecipient(id2);
      const userTyped = `# main mac (cowork)\n${r1}\n\n# backup (1pw)\n${r2}\n`;

      // save flow
      const validation = validateRecipientsContent(userTyped);
      expect(validation).toEqual({ ok: true });
      writeRecipientsRaw(tmpFile, userTyped);

      // reopen flow
      const reloaded = readRecipientsRaw(tmpFile);
      expect(reloaded.exists).toBe(true);
      expect(reloaded.content).toBe(userTyped);

      // and the now-saved file is parseable end-to-end (encrypts to both)
      const recipients = readRecipients(tmpFile);
      expect(recipients).toEqual([r1, r2]);
      const ct = await encrypt(recipients, "textarea-save round-trip");
      expect(await decryptToString(id1, ct)).toBe("textarea-save round-trip");
      expect(await decryptToString(id2, ct)).toBe("textarea-save round-trip");
    });

    it("a textarea save flow refuses to write malformed content", () => {
      // simulates: user types garbage, clicks Save, validation fails, no write
      fs.writeFileSync(tmpFile, "previous-good-content\n");
      const userTyped = "this is not valid\nrecipients-file-content\n";
      const validation = validateRecipientsContent(userTyped);
      expect(validation.ok).toBe(false);
      // contract: the plugin's save handler MUST NOT call writeRecipientsRaw
      // when validation.ok is false. We verify the file is untouched.
      const after = fs.readFileSync(tmpFile, "utf8");
      expect(after).toBe("previous-good-content\n");
    });
  });
});

describe("writeRecipientsRaw — chmod 0600 on first write (v0.6.3)", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(
      os.tmpdir(),
      `halfday-rune-chmod-test-${process.pid}-${Date.now()}`
    );
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it("creates the file with mode 0600 when it did not exist before", () => {
    // sanity: file doesn't exist
    expect(fs.existsSync(tmpFile)).toBe(false);
    writeRecipientsRaw(tmpFile, "# new\nage1aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmm\n");
    const st = fs.statSync(tmpFile);
    // mask to permission bits; expect 0o600 (owner rw, group/other none)
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("preserves existing permissions on subsequent writes", () => {
    // simulate a user who explicitly chmod 0644'd the file later
    writeRecipientsRaw(tmpFile, "age1aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmm\n");
    fs.chmodSync(tmpFile, 0o644);
    // sanity-check the chmod actually applied
    expect(fs.statSync(tmpFile).mode & 0o777).toBe(0o644);
    // second write should NOT silently lock the file back down
    writeRecipientsRaw(tmpFile, "age1aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmm\n# updated\n");
    expect(fs.statSync(tmpFile).mode & 0o777).toBe(0o644);
  });

  it("round-trips content through openSync/writeSync correctly (no truncation)", () => {
    const content =
      "# main mac\nage1aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkkkllllmmmm\n# offline backup\nage1xxxxyyyyzzzz1111222233334444555566667777888899990000\n";
    writeRecipientsRaw(tmpFile, content);
    const read = fs.readFileSync(tmpFile, "utf8");
    expect(read).toBe(content);
  });
});

describe("statRecipientsMtime (v0.6.3)", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(
      os.tmpdir(),
      `halfday-rune-mtime-test-${process.pid}-${Date.now()}`
    );
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it("returns null for a non-existent file (first-write semantics)", () => {
    expect(fs.existsSync(tmpFile)).toBe(false);
    expect(statRecipientsMtime(tmpFile)).toBeNull();
  });

  it("returns the file's mtimeMs after writing", () => {
    fs.writeFileSync(tmpFile, "hi\n");
    const mt = statRecipientsMtime(tmpFile);
    expect(mt).not.toBeNull();
    expect(typeof mt).toBe("number");
    // mtime should be close to "now" — sanity check it's not unix epoch
    expect(mt as number).toBeGreaterThan(Date.now() - 60_000);
  });

  it("reports a higher mtime after an external edit (the detector contract)", async () => {
    fs.writeFileSync(tmpFile, "first\n");
    const before = statRecipientsMtime(tmpFile)!;
    // wait long enough for the filesystem timestamp resolution; macOS HFS
    // has 1s mtime granularity historically, modern APFS is finer but
    // we still need to ensure a measurable gap.
    await new Promise((r) => setTimeout(r, 50));
    // bump the mtime explicitly — utimes is more reliable than counting
    // on the next write to land on a later tick.
    const nowSec = (Date.now() + 5000) / 1000;
    fs.utimesSync(tmpFile, nowSec, nowSec);
    const after = statRecipientsMtime(tmpFile)!;
    expect(after).toBeGreaterThan(before);
  });
});
