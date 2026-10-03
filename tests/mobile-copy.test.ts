import { describe, it, expect } from "vitest";
import { Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { unwrapMobileKey } from "../src/crypto";
import {
  createMobileCopy,
  effectiveMobileKeyPath,
  validateMobileKeyPath,
  validatePassphrasePair,
  MobileCopyError,
  MOBILE_COPY_FAILED_MESSAGE,
  inspectMobileKeyTarget,
  mobileCopySummary,
  mobileCopyWarning,
  recipientsFingerprint,
  fingerprintSidecarPath,
  STALE_COPY_WARNING,
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
    await createMobileCopy(a, P, id, [], PW, 16);
    expect(a.dirs.has("_rune")).toBe(true);
    expect((await unwrapMobileKey(a.files.get(P)!, PW)).identity).toBe(id);
  });

  it("stores the full recipients list and reports a +N / -M change", async () => {
    const a = new FakeAdapter();
    const id = await generateIdentity();
    const r2 = await identityToRecipient(await generateIdentity());
    const r3 = await identityToRecipient(await generateIdentity());
    const first = await createMobileCopy(a, P, id, [r2], PW, 16);
    expect(first.addedOwnRecipient).toBe(true);
    expect(first.changes).toBeNull();
    const own = await identityToRecipient(id);
    expect((await unwrapMobileKey(a.files.get(P)!, PW)).recipients).toEqual([r2, own]);
    const second = await createMobileCopy(a, P, id, [own, r3], PW, 16);
    expect(second.addedOwnRecipient).toBe(false);
    expect(second.changes).toEqual({ added: 1, removed: 1 });
    expect(mobileCopySummary(second)).toContain("recipients updated: +1 / \u22121");
    const same = await createMobileCopy(a, P, id, [own, r3], PW, 16);
    expect(same.changes).toEqual({ added: 0, removed: 0 });
    expect(mobileCopySummary(same)).toBe("");
    // a different passphrase cannot open the old file: no diff, still succeeds
    const other = await createMobileCopy(a, P, id, [own], PW + "2", 16);
    expect(other.changes).toBeNull();
  });

  it("replaces an existing file", async () => {
    const a = new FakeAdapter();
    const id = await generateIdentity();
    await createMobileCopy(a, P, id, [], PW, 16);
    await createMobileCopy(a, P, id, [], PW + "2", 16);
    expect((await unwrapMobileKey(a.files.get(P)!, PW + "2")).identity).toBe(id);
  });

  it("refuses to overwrite an ordinary encrypted note, writing nothing", async () => {
    const a = new FakeAdapter();
    const id = await generateIdentity();
    const e = new Encrypter();
    e.addRecipient(await identityToRecipient(id));
    const note = await e.encrypt("a journal entry");
    a.files.set(P, note.slice());
    a.dirs.add("_rune");
    const err = await createMobileCopy(a, P, id, [], PW, 16).catch((x) => x);
    expect(err).toBeInstanceOf(MobileCopyError);
    expect(err.message).toBe(MOBILE_COPY_NOT_WRAPPED_MESSAGE);
    expect([...a.files.get(P)!]).toEqual([...note]);
    expect(a.removed).toEqual([]);
    // plain garbage is refused too
    a.files.set(P, new Uint8Array([1, 2, 3]));
    await expect(createMobileCopy(a, P, id, [], PW, 16)).rejects.toThrow(/not an unlock file|not a rune unlock/);
    expect([...a.files.get(P)!]).toEqual([1, 2, 3]);
  });

  it("inspectMobileKeyTarget: missing / wrapped / not-wrapped", async () => {
    const a = new FakeAdapter();
    const id = await generateIdentity();
    expect(await inspectMobileKeyTarget(a, P)).toBe("missing");
    await createMobileCopy(a, P, id, [], PW, 16);
    expect(await inspectMobileKeyTarget(a, P)).toBe("wrapped");
    const e = new Encrypter();
    e.addRecipient(await identityToRecipient(id));
    a.files.set("n.age", await e.encrypt("x"));
    expect(await inspectMobileKeyTarget(a, "n.age")).toBe("not-wrapped");
  });

  it("a failed write on a new file leaves nothing behind, fixed message", async () => {
    const a = new FakeAdapter();
    a.failWrite = true;
    const err = await createMobileCopy(a, P, await generateIdentity(), [], PW, 16).catch((e) => e);
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
    const err = await createMobileCopy(a, P, await generateIdentity(), [], PW, 16).catch((e) => e);
    expect(err).toBeInstanceOf(MobileCopyError);
    expect([...a.files.get(P)!]).toEqual([...old]);
    expect(a.removed).toEqual([]);
  });

  it("failed verify on a new file removes only the file it created", async () => {
    const a = new FakeAdapter();
    a.corruptRead = true;
    await expect(createMobileCopy(a, P, await generateIdentity(), [], PW, 16)).rejects.toBeInstanceOf(MobileCopyError);
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

describe("stale-copy fingerprint sidecar", () => {
  it("is written beside the wrapped file; order and dupes do not matter", async () => {
    expect(fingerprintSidecarPath(P)).toBe("_rune/identity.recipients.sha256");
    const a = await identityToRecipient(await generateIdentity());
    const b = await identityToRecipient(await generateIdentity());
    expect(await recipientsFingerprint([a, b])).toBe(await recipientsFingerprint([b, a, a]));
    expect(await recipientsFingerprint([a])).not.toBe(await recipientsFingerprint([a, b]));
    expect(await recipientsFingerprint([a])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("no warning when fresh; warns after a swap, when the sidecar is missing or edited; none without an unlock file", async () => {
    const ad = new FakeAdapter();
    const id = await generateIdentity();
    const own = await identityToRecipient(id);
    const old = await identityToRecipient(await generateIdentity());
    const fresh = await identityToRecipient(await generateIdentity());
    expect(await mobileCopyWarning(ad, P, [own, old])).toBeNull(); // no unlock file
    await createMobileCopy(ad, P, id, [old], PW, 16);
    expect(ad.files.has("_rune/identity.recipients.sha256")).toBe(true);
    expect(await mobileCopyWarning(ad, P, [old, own])).toBeNull();
    expect(await mobileCopyWarning(ad, P, [fresh, own])).toBe(STALE_COPY_WARNING);
    ad.files.set("_rune/identity.recipients.sha256", new TextEncoder().encode("deadbeef\n"));
    expect(await mobileCopyWarning(ad, P, [old, own])).toBe(STALE_COPY_WARNING);
    ad.files.delete("_rune/identity.recipients.sha256");
    expect(await mobileCopyWarning(ad, P, [old, own])).toBe(STALE_COPY_WARNING);
    // the sidecar never changes what is wrapped
    expect((await unwrapMobileKey(ad.files.get(P)!, PW)).recipients).toEqual([old, own]);
  });

  it("a failed sidecar write rolls the whole copy back", async () => {
    const ad = new FakeAdapter();
    const id = await generateIdentity();
    await createMobileCopy(ad, P, id, [], PW, 16);
    const before = ad.files.get(P)!.slice();
    const sideBefore = ad.files.get("_rune/identity.recipients.sha256")!.slice();
    const orig = ad.writeBinary.bind(ad);
    ad.writeBinary = async (p, d) => {
      if (p.endsWith(".sha256")) throw new Error("disk full");
      return orig(p, d);
    };
    const other = await identityToRecipient(await generateIdentity());
    await expect(createMobileCopy(ad, P, id, [other], PW, 16)).rejects.toBeInstanceOf(MobileCopyError);
    expect([...ad.files.get(P)!]).toEqual([...before]);
    expect([...ad.files.get("_rune/identity.recipients.sha256")!]).toEqual([...sideBefore]);
  });
});

describe("malformed recipient message", () => {
  it("names the position and writes nothing", async () => {
    const ad = new FakeAdapter();
    const id = await generateIdentity();
    const good = await identityToRecipient(await generateIdentity());
    const err = await createMobileCopy(ad, P, id, [good, "age1plugin1abc"], PW, 16).catch((e) => e);
    expect(err).toBeInstanceOf(MobileCopyError);
    expect(err.message).toContain("Recipient 2");
    expect(err.message).toContain("not a plain age1 key");
    expect(ad.files.size).toBe(0);
  });
});
