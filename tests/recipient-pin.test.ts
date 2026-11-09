/**
 * Recipient pin (#2, gabbro#110 F5): the owner-confirmed set is checked on
 * every unlock and every encrypt, and any difference fails closed.
 * Throwaway identities only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { wrapMobileKey } from "../src/crypto";
import { FileKeySource, PassphraseKeySource } from "../src/keysource";
import {
  assertPinned,
  checkPin,
  effectiveSet,
  makePin,
  PIN_NOT_CONFIRMED_MESSAGE,
  PIN_UNVERIFIED_MESSAGE,
  RecipientPinError,
  type PinStore,
  type RecipientPin,
} from "../src/recipient-pin";

const PW = "a long random passphrase 98765";
const PATH = "_rune/identity.age";

let identity: string;
let own: string;
let other: string;
let attacker: string;
beforeEach(async () => {
  identity = await generateIdentity();
  own = await identityToRecipient(identity);
  other = await identityToRecipient(await generateIdentity());
  attacker = await identityToRecipient(await generateIdentity());
});

function store(initial: unknown = undefined, confirm = true) {
  const s = {
    pin: initial,
    saves: [] as RecipientPin[],
    asked: [] as string[][],
    get: () => s.pin,
    save: async (p: RecipientPin) => {
      s.pin = p;
      s.saves.push(p);
    },
    confirmFirst: vi.fn(async (r: string[]) => (s.asked.push(r), confirm)),
  };
  return s as typeof s & PinStore;
}

describe("makePin / checkPin", () => {
  it("pins the sorted set with the own recipient added, and verifies it", async () => {
    const pin = await makePin(identity, [other]);
    expect(pin.recipients).toEqual([own, other].sort());
    expect(pin.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(await checkPin(pin, identity, [other, own])).toEqual({ status: "ok" });
    expect(await checkPin(pin, identity, [other])).toEqual({ status: "ok" });
  });

  it("never stores the identity", async () => {
    const pin = await makePin(identity, [other]);
    expect(JSON.stringify(pin)).not.toContain("AGE-SECRET-KEY");
  });

  it("reports an added key as changed, with the key", async () => {
    const pin = await makePin(identity, [other]);
    expect(await checkPin(pin, identity, [other, attacker])).toEqual({
      status: "changed",
      added: [attacker],
      removed: [],
    });
  });

  it("reports a removed key as changed", async () => {
    const pin = await makePin(identity, [other]);
    expect(await checkPin(pin, identity, [])).toEqual({
      status: "changed",
      added: [],
      removed: [other],
    });
  });

  it("a pin rewritten to include another key without the identity does not verify", async () => {
    const pin = await makePin(identity, [other]);
    const forged = { ...pin, recipients: [...pin.recipients, attacker].sort() };
    expect(await checkPin(forged, identity, [other, attacker])).toEqual({ status: "unverified" });
  });

  it("a pin made with another identity does not verify", async () => {
    const pin = await makePin(await generateIdentity(), [own, other]);
    expect(await checkPin(pin, identity, [other])).toEqual({ status: "unverified" });
  });

  it("malformed pins do not verify; absent is missing", async () => {
    expect(await checkPin(undefined, identity, [other])).toEqual({ status: "missing" });
    expect(await checkPin(null, identity, [other])).toEqual({ status: "missing" });
    for (const bad of ["x", 1, {}, { recipients: "a", mac: "b" }, { recipients: [own], mac: "zz" }]) {
      expect(await checkPin(bad, identity, [other])).toEqual({ status: "unverified" });
    }
  });

  it("effectiveSet dedupes, trims and sorts", async () => {
    expect(await effectiveSet(identity, [` ${other} `, other, own])).toEqual([own, other].sort());
  });
});

describe("assertPinned", () => {
  it("passes on the confirmed set without asking", async () => {
    const s = store(await makePin(identity, [other]));
    await assertPinned(s, identity, [other]);
    expect(s.confirmFirst).not.toHaveBeenCalled();
    expect(s.saves).toEqual([]);
  });

  it("an added key fails closed with the count, never asks inline, saves nothing", async () => {
    const s = store(await makePin(identity, [other]));
    const err = await assertPinned(s, identity, [other, attacker]).catch((e) => e);
    expect(err).toBeInstanceOf(RecipientPinError);
    expect(err.message).toMatch(/\+1 added, −0 removed/);
    expect(err.message).toMatch(/Confirm recipient set/);
    expect(s.confirmFirst).not.toHaveBeenCalled();
    expect(s.saves).toEqual([]);
  });

  it("an unverifiable pin fails closed and is not replaced", async () => {
    const pin = await makePin(identity, [other]);
    const s = store({ ...pin, mac: "0".repeat(64) });
    await expect(assertPinned(s, identity, [other])).rejects.toThrow(PIN_UNVERIFIED_MESSAGE);
    expect(s.confirmFirst).not.toHaveBeenCalled();
    expect(s.saves).toEqual([]);
  });

  it("no pin: asks with the full set and saves it once confirmed (trust on first use)", async () => {
    const s = store(undefined, true);
    await assertPinned(s, identity, [other]);
    expect(s.asked).toEqual([[own, other].sort()]);
    expect(s.saves).toHaveLength(1);
    expect(await checkPin(s.pin, identity, [other])).toEqual({ status: "ok" });
  });

  it("no pin and the owner declines: refuses and saves nothing", async () => {
    const s = store(undefined, false);
    await expect(assertPinned(s, identity, [other])).rejects.toThrow(PIN_NOT_CONFIRMED_MESSAGE);
    expect(s.saves).toEqual([]);
  });
});

describe("FileKeySource with a pin", () => {
  function node(recipients: string[]) {
    return {
      readIdentity: vi.fn(() => identity),
      readRecipients: vi.fn(() => [...recipients]),
    };
  }
  const loader = (n: ReturnType<typeof node>) =>
    (async () => n) as unknown as typeof import("../src/node-loader").loadCryptoNode;
  const paths = () => ({ identityPath: "/id", recipientsPath: "/r" });

  it("a key appended to recipients.txt stops every encrypt with a clear message", async () => {
    const s = store(await makePin(identity, [other]));
    const n = node([other, attacker]);
    const ks = new FileKeySource(paths, loader(n), s);
    await expect(ks.getRecipients()).rejects.toThrow(/\+1 added/);
    expect(s.saves).toEqual([]);
  });

  it("returns the file's list when it matches the pin", async () => {
    const s = store(await makePin(identity, [other]));
    const ks = new FileKeySource(paths, loader(node([other])), s);
    expect(await ks.getRecipients()).toEqual([other]);
  });

  it("readUnpinned reads both files without consulting the pin", async () => {
    const s = store(await makePin(identity, [other]));
    const ks = new FileKeySource(paths, loader(node([other, attacker])), s);
    expect(await ks.readUnpinned()).toEqual({ identity, recipients: [other, attacker] });
  });
});

describe("PassphraseKeySource with a pin", () => {
  async function make(copyRecipients: string[], s: PinStore, wrapId = identity) {
    const wrapped = await wrapMobileKey(wrapId, copyRecipients, PW, 16);
    const errors: unknown[] = [];
    const ks = new PassphraseKeySource({
      adapter: {
        exists: async (p) => p === PATH,
        readBinary: async () => wrapped.slice().buffer as ArrayBuffer,
      },
      getSettings: () => ({ mobileKeyPath: PATH, autoLockMinutes: 0, backgroundLockGraceSeconds: 60 }),
      prompt: async (attempt) => {
        try {
          await attempt(PW);
          return true;
        } catch (e) {
          errors.push(e);
          return false;
        }
      },
      pin: s,
    });
    return { ks, errors };
  }

  it("unlocks a copy that matches the pin", async () => {
    const s = store(await makePin(identity, [other]));
    const { ks } = await make([other], s);
    expect(await ks.getIdentity()).toBe(identity);
    expect(await ks.getRecipients()).toEqual([other, own]);
  });

  it("refuses to unlock a copy whose list differs from the pin (an older copy swapped in) and never holds the key", async () => {
    const s = store(await makePin(identity, [other]));
    const { ks, errors } = await make([other, attacker], s);
    await expect(ks.getIdentity()).rejects.toThrow();
    expect(ks.isUnlocked()).toBe(false);
    expect(errors[0]).toBeInstanceOf(RecipientPinError);
    expect((errors[0] as Error).message).toMatch(/\+1 added/);
  });

  it("refuses a copy made with another identity under the same passphrase (the pin does not verify)", async () => {
    const s = store(await makePin(identity, [other]));
    const { ks, errors } = await make([other, own], s, await generateIdentity());
    await expect(ks.getIdentity()).rejects.toThrow();
    expect(ks.isUnlocked()).toBe(false);
    expect((errors[0] as Error).message).toBe(PIN_UNVERIFIED_MESSAGE);
  });

  it("no pin: the first unlock asks, and declining leaves it locked", async () => {
    const s = store(undefined, false);
    const { ks } = await make([other], s);
    await expect(ks.getIdentity()).rejects.toThrow();
    expect(ks.isUnlocked()).toBe(false);
    expect(s.asked).toEqual([[own, other].sort()]);
    expect(s.saves).toEqual([]);
  });

  it("re-checks on every encrypt: a pin changed while unlocked stops getRecipients", async () => {
    const s = store(await makePin(identity, [other]));
    const { ks } = await make([other], s);
    await ks.getIdentity();
    s.pin = await makePin(identity, []);
    await expect(ks.getRecipients()).rejects.toThrow(RecipientPinError);
  });
});
