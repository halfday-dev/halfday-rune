import { describe, it, expect } from "vitest";
import { Encrypter, generateIdentity } from "age-encryption";
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

  it("accepts logN 16-20 only", async () => {
    const id = await generateIdentity();
    for (const bad of [15, 21, 0, -1, 16.5, NaN]) {
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
    enc.setScryptWorkFactor(10);
    const notId = await enc.encrypt("just some text, not a key");
    await expect(unwrapIdentity(notId, PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
    const enc2 = new Encrypter();
    enc2.setPassphrase(PW);
    enc2.setScryptWorkFactor(10);
    const badSum = await enc2.encrypt("AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ");
    await expect(unwrapIdentity(badSum, PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
  });

  it("tolerates a trailing newline in the wrapped plaintext", async () => {
    const id = await generateIdentity();
    const enc = new Encrypter();
    enc.setPassphrase(PW);
    enc.setScryptWorkFactor(10);
    const w = await enc.encrypt(id + "\n");
    expect(await unwrapIdentity(w, PW)).toBe(id);
  });
});
