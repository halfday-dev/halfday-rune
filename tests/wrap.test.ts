import { describe, it, expect } from "vitest";
import { Encrypter, generateIdentity } from "age-encryption";
import { parseAgeHeader, isScryptWrapped, isEncryptedOnlyToIdentity } from "../src/crypto";
import {
  wrapIdentity,
  unwrapIdentity,
  WrongPassphraseError,
  InvalidWrappedIdentityError,
} from "../src/crypto";

const PW = "correct horse battery staple 1234";

describe("wrapIdentity / unwrapIdentity", () => {
  it("round-trips the identical identity", async () => {
    const id = await generateIdentity();
    const w = await wrapIdentity(id, PW, 16);
    expect(await unwrapIdentity(w, PW)).toBe(id);
  });

  it("output is an age file with a scrypt stanza and no secret in clear", async () => {
    const id = await generateIdentity();
    const w = await wrapIdentity(id, PW, 16);
    const head = new TextDecoder().decode(w.slice(0, 80));
    expect(head).toContain("age-encryption.org/v1");
    expect(head).toContain("-> scrypt");
    expect(new TextDecoder("latin1").decode(w)).not.toContain("AGE-SECRET-KEY");
  });

  it("wrong passphrase throws the fixed WrongPassphraseError", async () => {
    const id = await generateIdentity();
    const w = await wrapIdentity(id, PW, 16);
    const err = await unwrapIdentity(w, PW + "x").catch((e) => e);
    expect(err).toBeInstanceOf(WrongPassphraseError);
    expect(err.message).toBe("Wrong passphrase");
    expect(err.message).not.toContain(PW);
  });

  it("malformed or damaged wrapped input throws InvalidWrappedIdentityError", async () => {
    const id = await generateIdentity();
    const w = await wrapIdentity(id, PW, 16);
    await expect(unwrapIdentity(new Uint8Array([1, 2, 3]), PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
    await expect(unwrapIdentity(new Uint8Array(), PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
    await expect(unwrapIdentity(w.slice(0, w.length - 3), PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
    const flipped = w.slice();
    flipped[flipped.length - 1] ^= 1;
    await expect(unwrapIdentity(flipped, PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
  });

  it("accepts logN 16-19 only (default 18)", async () => {
    const id = await generateIdentity();
    for (const bad of [15, 20, 21, 0, -1, 16.5, NaN]) {
      await expect(wrapIdentity(id, PW, bad)).rejects.toBeInstanceOf(RangeError);
    }
    await expect(wrapIdentity(id, PW, 16)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("refuses to wrap something that is not a well-formed identity", async () => {
    await expect(wrapIdentity("hello", PW, 16)).rejects.toThrow();
    await expect(wrapIdentity("AGE-SECRET-KEY-1QQQQ", PW, 16)).rejects.toThrow();
    await expect(wrapIdentity(await generateIdentity(), "", 16)).rejects.toThrow();
  });

  it("validates the unwrapped result: a correctly-opened non-identity is rejected", async () => {
    const enc = new Encrypter();
    enc.setPassphrase(PW);
    enc.setScryptWorkFactor(16);
    const notId = await enc.encrypt("just some text, not a key");
    await expect(unwrapIdentity(notId, PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
    const enc2 = new Encrypter();
    enc2.setPassphrase(PW);
    enc2.setScryptWorkFactor(16);
    const badSum = await enc2.encrypt("AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ");
    await expect(unwrapIdentity(badSum, PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
  });

  it("tolerates a trailing newline in the wrapped plaintext", async () => {
    const id = await generateIdentity();
    const enc = new Encrypter();
    enc.setPassphrase(PW);
    enc.setScryptWorkFactor(16);
    const w = await enc.encrypt(id + "\n");
    expect(await unwrapIdentity(w, PW)).toBe(id);
  });

  it("refuses a hostile work factor in the header before running scrypt", async () => {
    const id = await generateIdentity();
    const w = await wrapIdentity(id, PW, 16);
    const text = new TextDecoder("latin1").decode(w);
    const at = text.indexOf("-> scrypt ");
    const eol = text.indexOf("\n", at);
    expect(text.slice(eol - 2, eol)).toBe("16");
    const patch = (digits: string) => {
      const c = w.slice();
      c[eol - 2] = digits.charCodeAt(0);
      c[eol - 1] = digits.charCodeAt(1);
      return c;
    };
    for (const bad of ["20", "22", "15", "10", "99"]) {
      const err = await unwrapIdentity(patch(bad), PW).catch((e) => e);
      expect(err, bad).toBeInstanceOf(InvalidWrappedIdentityError);
    }
    // 19 is inside the cap, so it gets past it and fails later (wrong derived key)
    const e19 = await unwrapIdentity(patch("19"), PW).catch((e) => e);
    expect(e19).not.toBeInstanceOf(InvalidWrappedIdentityError);
  });

  it("a logN 19 file we write can be opened", async () => {
    const id = await generateIdentity();
    const w = await wrapIdentity(id, PW, 19);
    expect(await unwrapIdentity(w, PW)).toBe(id);
  }, 60_000);

  it("refuses a header with a non-scrypt or multiple stanzas", async () => {
    const id = await generateIdentity();
    const enc = new Encrypter();
    enc.addRecipient(await (await import("age-encryption")).identityToRecipient(id));
    const x = await enc.encrypt("x");
    await expect(unwrapIdentity(x, PW)).rejects.toBeInstanceOf(InvalidWrappedIdentityError);
  });
});

describe("header helpers", () => {
  it("parseAgeHeader / isScryptWrapped", async () => {
    const id = await generateIdentity();
    const w = await wrapIdentity(id, PW, 16);
    const st = parseAgeHeader(w);
    expect(st).toHaveLength(1);
    expect(st[0].type).toBe("scrypt");
    expect(isScryptWrapped(w)).toBe(true);
    expect(isScryptWrapped(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("isEncryptedOnlyToIdentity: one own X25519 stanza only", async () => {
    const { identityToRecipient } = await import("age-encryption");
    const id = await generateIdentity();
    const other = await generateIdentity();
    const mk = async (rs: string[]) => {
      const e = new Encrypter();
      rs.forEach((r) => e.addRecipient(r));
      return e.encrypt("note");
    };
    const mine = await identityToRecipient(id);
    const theirs = await identityToRecipient(other);
    expect(await isEncryptedOnlyToIdentity(id, await mk([mine]))).toBe(true);
    expect(await isEncryptedOnlyToIdentity(id, await mk([mine, theirs]))).toBe(false);
    expect(await isEncryptedOnlyToIdentity(id, await mk([theirs]))).toBe(false);
    expect(await isEncryptedOnlyToIdentity(id, new Uint8Array([1]))).toBe(false);
    const w = await wrapIdentity(id, PW, 16);
    expect(await isEncryptedOnlyToIdentity(id, w)).toBe(false);
  });
});
