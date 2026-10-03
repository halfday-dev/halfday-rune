import { describe, it, expect } from "vitest";
import { Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { parseAgeHeader, isScryptWrapped, isEncryptedOnlyToIdentity } from "../src/crypto";
import {
  wrapMobileKey,
  buildMobileKey,
  unwrapMobileKey,
  WrongPassphraseError,
  InvalidWrappedIdentityError,
} from "../src/crypto";

const PW = "correct horse battery staple 1234";

async function rawWrap(text: string): Promise<Uint8Array> {
  const enc = new Encrypter();
  enc.setPassphrase(PW);
  enc.setScryptWorkFactor(16);
  return enc.encrypt(text);
}

describe("wrapMobileKey / unwrapMobileKey", () => {
  it("round-trips the identical identity", async () => {
    const id = await generateIdentity();
    const w = await wrapMobileKey(id, [], PW, 16);
    expect((await unwrapMobileKey(w, PW)).identity).toBe(id);
  });

  it("output is an age file with a scrypt stanza and no secret in clear", async () => {
    const id = await generateIdentity();
    const w = await wrapMobileKey(id, [], PW, 16);
    const head = new TextDecoder().decode(w.slice(0, 80));
    expect(head).toContain("age-encryption.org/v1");
    expect(head).toContain("-> scrypt");
    expect(new TextDecoder("latin1").decode(w)).not.toContain("AGE-SECRET-KEY");
  });

  it("wrong passphrase throws the fixed WrongPassphraseError", async () => {
    const id = await generateIdentity();
    const w = await wrapMobileKey(id, [], PW, 16);
    const err = await unwrapMobileKey(w, PW + "x").catch((e) => e);
    expect(err).toBeInstanceOf(WrongPassphraseError);
    expect(err.message).toBe("Wrong passphrase");
    expect(err.message).not.toContain(PW);
  });

  it("malformed or damaged wrapped input throws InvalidWrappedIdentityError", async () => {
    const id = await generateIdentity();
    const w = await wrapMobileKey(id, [], PW, 16);
    await expect(unwrapMobileKey(new Uint8Array([1, 2, 3]), PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
    await expect(unwrapMobileKey(new Uint8Array(), PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
    await expect(unwrapMobileKey(w.slice(0, w.length - 3), PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
    const flipped = w.slice();
    flipped[flipped.length - 1] ^= 1;
    await expect(unwrapMobileKey(flipped, PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
  });

  it("accepts logN 16-19 only (default 18)", async () => {
    const id = await generateIdentity();
    for (const bad of [15, 20, 21, 0, -1, 16.5, NaN]) {
      await expect(wrapMobileKey(id, [], PW, bad)).rejects.toBeInstanceOf(RangeError);
    }
    await expect(wrapMobileKey(id, [], PW, 16)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("refuses to wrap something that is not a well-formed identity", async () => {
    await expect(wrapMobileKey("hello", PW, 16)).rejects.toThrow();
    await expect(wrapMobileKey("AGE-SECRET-KEY-1QQQQ", PW, 16)).rejects.toThrow();
    await expect(wrapMobileKey(await generateIdentity(), "", 16)).rejects.toThrow();
  });

  it("validates the unwrapped result: a correctly-opened non-identity is rejected", async () => {
    const enc = new Encrypter();
    enc.setPassphrase(PW);
    enc.setScryptWorkFactor(16);
    const notId = await enc.encrypt("just some text, not a key");
    await expect(unwrapMobileKey(notId, PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
    const enc2 = new Encrypter();
    enc2.setPassphrase(PW);
    enc2.setScryptWorkFactor(16);
    const badSum = await enc2.encrypt("AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ");
    await expect(unwrapMobileKey(badSum, PW)).rejects.toBeInstanceOf(
      InvalidWrappedIdentityError
    );
  });

  it("old bare-identity files are rejected with the re-create message", async () => {
    const id = await generateIdentity();
    const w = await rawWrap(id + "\n");
    const err = await unwrapMobileKey(w, PW).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidWrappedIdentityError);
    expect(err.message).toContain("Create mobile unlock copy");
  });

  it("round-trips 3 recipients in order, deduped, own recipient included", async () => {
    const id = await generateIdentity();
    const own = await identityToRecipient(id);
    const r2 = await identityToRecipient(await generateIdentity());
    const r3 = await identityToRecipient(await generateIdentity());
    const w = await wrapMobileKey(id, [r2, own, r2, r3], PW, 16);
    const k = await unwrapMobileKey(w, PW);
    expect(k.identity).toBe(id);
    expect(k.recipients).toEqual([r2, own, r3]);
    expect(new TextDecoder("latin1").decode(w)).not.toContain("age1");
  });

  it("adds the identity's own recipient when the list lacks it", async () => {
    const id = await generateIdentity();
    const own = await identityToRecipient(id);
    const r2 = await identityToRecipient(await generateIdentity());
    const built = await buildMobileKey(id, [r2]);
    expect(built.addedOwn).toBe(true);
    expect(built.recipients).toEqual([r2, own]);
    expect((await buildMobileKey(id, [own, r2])).addedOwn).toBe(false);
    const k = await unwrapMobileKey(await wrapMobileKey(id, [r2], PW, 16), PW);
    expect(k.recipients).toContain(own);
  });

  it("refuses to wrap malformed recipients", async () => {
    const id = await generateIdentity();
    const good = await identityToRecipient(await generateIdentity());
    for (const bad of ["", "age1abc", good.slice(0, -1) + (good.endsWith("q") ? "p" : "q"), "ssh-ed25519 AAAA", good + "\nrecipient: " + good]) {
      await expect(wrapMobileKey(id, [bad], PW, 16), bad).rejects.toThrow();
    }
  });

  it("rejects unknown versions, tampered payloads and malformed lines on unwrap", async () => {
    const id = await generateIdentity();
    const own = await identityToRecipient(id);
    const other = await identityToRecipient(await generateIdentity());
    const body = (h: string, ...rest: string[]) => [h, `identity: ${id}`, ...rest].join("\n") + "\n";
    const bad: Record<string, string> = {
      v2: body("rune-mobile-key v2", `recipient: ${own}`),
      noHeader: `identity: ${id}\nrecipient: ${own}\n`,
      noRecipients: body("rune-mobile-key v1"),
      malformedRecipient: body("rune-mobile-key v1", `recipient: ${own}`, "recipient: age1xyz"),
      unknownLine: body("rune-mobile-key v1", `recipient: ${own}`, "extra: 1"),
      duplicate: body("rune-mobile-key v1", `recipient: ${own}`, `recipient: ${own}`),
      ownMissing: body("rune-mobile-key v1", `recipient: ${other}`),
      badIdentity: `rune-mobile-key v1\nidentity: AGE-SECRET-KEY-1QQQQ\nrecipient: ${own}\n`,
    };
    for (const [name, text] of Object.entries(bad)) {
      const err = await unwrapMobileKey(await rawWrap(text), PW).catch((e) => e);
      expect(err, name).toBeInstanceOf(InvalidWrappedIdentityError);
    }
  });

  it("a flipped byte in the wrapped file fails (recipients are integrity protected)", async () => {
    const id = await generateIdentity();
    const other = await identityToRecipient(await generateIdentity());
    const w = await wrapMobileKey(id, [other], PW, 16);
    const c = w.slice();
    c[Math.floor(c.length / 2) + 20] ^= 1;
    await expect(unwrapMobileKey(c, PW)).rejects.toBeInstanceOf(InvalidWrappedIdentityError);
  });

  it("refuses a hostile work factor in the header before running scrypt", async () => {
    const id = await generateIdentity();
    const w = await wrapMobileKey(id, [], PW, 16);
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
      const err = await unwrapMobileKey(patch(bad), PW).catch((e) => e);
      expect(err, bad).toBeInstanceOf(InvalidWrappedIdentityError);
    }
    // 19 is inside the cap, so it gets past it and fails later (wrong derived key)
    const e19 = await unwrapMobileKey(patch("19"), PW).catch((e) => e);
    expect(e19).not.toBeInstanceOf(InvalidWrappedIdentityError);
  });

  it("a logN 19 file we write can be opened", async () => {
    const id = await generateIdentity();
    const w = await wrapMobileKey(id, [], PW, 19);
    expect((await unwrapMobileKey(w, PW)).identity).toBe(id);
  }, 60_000);

  it("refuses a header with a non-scrypt or multiple stanzas", async () => {
    const id = await generateIdentity();
    const enc = new Encrypter();
    enc.addRecipient(await (await import("age-encryption")).identityToRecipient(id));
    const x = await enc.encrypt("x");
    await expect(unwrapMobileKey(x, PW)).rejects.toBeInstanceOf(InvalidWrappedIdentityError);
  });
});

describe("header helpers", () => {
  it("parseAgeHeader / isScryptWrapped", async () => {
    const id = await generateIdentity();
    const w = await wrapMobileKey(id, [], PW, 16);
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
    const w = await wrapMobileKey(id, [], PW, 16);
    expect(await isEncryptedOnlyToIdentity(id, w)).toBe(false);
  });
});
