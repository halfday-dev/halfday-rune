import { describe, it, expect } from "vitest";
import { Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { unwrapIdentity } from "../src/crypto";
import {
  createMobileCopy,
  effectiveMobileKeyPath,
  validateMobileKeyPath,
  validatePassphrasePair,
  MobileCopyError,
  MOBILE_COPY_FAILED_MESSAGE,
  inspectMobileKeyTarget,
  MOBILE_COPY_NOT_WRAPPED_MESSAGE,
  type VaultAdapterLike,
} from "../src/mobile-copy";

const PW = "a long random passphrase 98765";
const P = "_rune/identity.age";

class FakeAdapter implements VaultAdapterLike {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  removed: string[] = [];
  failWrite = false;
  corruptRead = false;
  async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
  async mkdir(p: string) { this.dirs.add(p); }
  async readBinary(p: string) {
    const f = this.files.get(p);
    if (!f) throw new Error("ENOENT");
    const c = f.slice();
    if (this.corruptRead) c[c.length - 1] ^= 1;
    return c.buffer as ArrayBuffer;
  }
  async writeBinary(p: string, d: ArrayBuffer) {
    if (this.failWrite) throw new Error("disk full");
    this.files.set(p, new Uint8Array(d.slice(0)));
  }
  async remove(p: string) { this.removed.push(p); this.files.delete(p); }
}

describe("validateMobileKeyPath", () => {
  it("accepts vault-relative .age paths", () => {
    for (const ok of ["_rune/identity.age", "a/b/key.age", "k.age", "x/Key.AGE"]) {
      expect(validateMobileKeyPath(ok).ok, ok).toBe(true);
    }
  });
  it("rejects everything else", () => {
    for (const bad of [
      "", "/abs/k.age", "~/k.age", "C:/k.age", "../k.age", "a/../k.age", "a/./k.age",
      "a//k.age", "a\\k.age", ".obsidian/k.age", ".Obsidian/x/k.age", "a/key.txt",
      "a/.age", "a/", "a/k.age\n",
    ]) {
      expect(validateMobileKeyPath(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("falls back to the default for an invalid setting", () => {
    expect(effectiveMobileKeyPath("../x.age")).toBe("_rune/identity.age");
    expect(effectiveMobileKeyPath(undefined)).toBe("_rune/identity.age");
    expect(effectiveMobileKeyPath("a/k.age")).toBe("a/k.age");
  });
});

describe("validatePassphrasePair", () => {
  it("needs 20+ characters and a match", () => {
    expect(validatePassphrasePair("short", "short").ok).toBe(false);
    expect(validatePassphrasePair("x".repeat(19), "x".repeat(19)).ok).toBe(false);
    expect(validatePassphrasePair("x".repeat(20), "x".repeat(21)).ok).toBe(false);
    expect(validatePassphrasePair("x".repeat(20), "x".repeat(20)).ok).toBe(true);
  });
});

describe("createMobileCopy", () => {
  it("creates the folder, writes, verifies, and the file unwraps", async () => {
    const a = new FakeAdapter();
    const id = await generateIdentity();
    await createMobileCopy(a, P, id, PW, 16);
    expect(a.dirs.has("_rune")).toBe(true);
    expect(await unwrapIdentity(a.files.get(P)!, PW)).toBe(id);
  });

  it("replaces an existing file", async () => {
    const a = new FakeAdapter();
    const id = await generateIdentity();
    await createMobileCopy(a, P, id, PW, 16);
    await createMobileCopy(a, P, id, PW + "2", 16);
    expect(await unwrapIdentity(a.files.get(P)!, PW + "2")).toBe(id);
  });

  it("refuses to overwrite an ordinary encrypted note, writing nothing", async () => {
    const a = new FakeAdapter();
    const id = await generateIdentity();
    const e = new Encrypter();
    e.addRecipient(await identityToRecipient(id));
    const note = await e.encrypt("a journal entry");
    a.files.set(P, note.slice());
    a.dirs.add("_rune");
    const err = await createMobileCopy(a, P, id, PW, 16).catch((x) => x);
    expect(err).toBeInstanceOf(MobileCopyError);
    expect(err.message).toBe(MOBILE_COPY_NOT_WRAPPED_MESSAGE);
    expect([...a.files.get(P)!]).toEqual([...note]);
    expect(a.removed).toEqual([]);
    // plain garbage is refused too
    a.files.set(P, new Uint8Array([1, 2, 3]));
    await expect(createMobileCopy(a, P, id, PW, 16)).rejects.toThrow(/not an unlock file|not a rune unlock/);
    expect([...a.files.get(P)!]).toEqual([1, 2, 3]);
  });

  it("inspectMobileKeyTarget: missing / wrapped / not-wrapped", async () => {
    const a = new FakeAdapter();
    const id = await generateIdentity();
    expect(await inspectMobileKeyTarget(a, P)).toBe("missing");
    await createMobileCopy(a, P, id, PW, 16);
    expect(await inspectMobileKeyTarget(a, P)).toBe("wrapped");
    const e = new Encrypter();
    e.addRecipient(await identityToRecipient(id));
    a.files.set("n.age", await e.encrypt("x"));
    expect(await inspectMobileKeyTarget(a, "n.age")).toBe("not-wrapped");
  });

  it("a failed write on a new file leaves nothing behind, fixed message", async () => {
    const a = new FakeAdapter();
    a.failWrite = true;
    const err = await createMobileCopy(a, P, await generateIdentity(), PW, 16).catch((e) => e);
    expect(err).toBeInstanceOf(MobileCopyError);
    expect(err.message).toBe(MOBILE_COPY_FAILED_MESSAGE);
    expect(a.files.size).toBe(0);
  });

  it("a failed verify restores the previous file byte for byte and never deletes it", async () => {
    const a = new FakeAdapter();
    const old = new Uint8Array([9, 8, 7, 6]);
    a.files.set(P, old.slice());
    a.dirs.add("_rune");
    // corrupt the read-back only after the write: first read (previous) is clean
    let reads = 0;
    const orig = a.readBinary.bind(a);
    a.readBinary = async (p) => { reads++; a.corruptRead = reads > 1; return orig(p); };
    const err = await createMobileCopy(a, P, await generateIdentity(), PW, 16).catch((e) => e);
    expect(err).toBeInstanceOf(MobileCopyError);
    expect([...a.files.get(P)!]).toEqual([...old]);
    expect(a.removed).toEqual([]);
  });

  it("failed verify on a new file removes only the file it created", async () => {
    const a = new FakeAdapter();
    a.corruptRead = true;
    await expect(createMobileCopy(a, P, await generateIdentity(), PW, 16)).rejects.toBeInstanceOf(MobileCopyError);
    expect(a.files.has(P)).toBe(false);
    expect(a.removed).toEqual([P]);
  });

  it("rejects a bad path or bad identity without touching the vault, and never echoes secrets", async () => {
    const a = new FakeAdapter();
    const id = await generateIdentity();
    await expect(createMobileCopy(a, "../x.age", id, PW, 16)).rejects.toBeInstanceOf(MobileCopyError);
    const err = await createMobileCopy(a, P, "not an identity", PW, 16).catch((e) => e);
    expect(err).toBeInstanceOf(MobileCopyError);
    expect(err.message).not.toContain(PW);
    expect(a.files.size + a.dirs.size).toBe(0);
  });
});
