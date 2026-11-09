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
  copyOlderMessage,
  effectiveSet,
  evaluatePin,
  makePin,
  pinChangedMessage,
  pinRemovedMessage,
  PIN_NOT_CONFIRMED_MESSAGE,
  PIN_UNVERIFIED_MESSAGE,
  RecipientPinError,
  nextSeq,
  parseDeviceRecord,
  verifiedPin,
  type DeviceRecord,
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

/** A device record holding `recipients` at `seq` (makePin defaults to seq 1). */
const rec = (recipients: string[], seq = 1): DeviceRecord => ({ kind: "ok", recipients, seq });

/**
 * In-memory PinStore. `record`: this device's local record (default: none; a
 * plain list means that list at seq 1). save() and adopt() move the record,
 * as the plugin does.
 */
function store(
  initial: unknown = undefined,
  confirm = true,
  record: DeviceRecord | string[] | null = null
) {
  const s = {
    pin: initial,
    rec: (record === null ? { kind: "none" } : Array.isArray(record) ? rec(record) : record) as DeviceRecord,
    blockedMsg: null as string | null,
    saves: [] as RecipientPin[],
    adopted: [] as RecipientPin[],
    asked: [] as string[][],
    owns: [] as string[],
    get: () => s.pin,
    record: () => s.rec,
    blocked: () => s.blockedMsg,
    adopt: (p: RecipientPin) => {
      s.adopted.push(p);
      s.rec = rec(p.recipients, p.seq ?? 0);
    },
    save: async (p: RecipientPin) => {
      s.pin = p;
      s.rec = rec(p.recipients, p.seq ?? 0);
      s.saves.push(p);
    },
    confirmFirst: vi.fn(
      async (r: string[], own: string) => (s.asked.push(r), s.owns.push(own), confirm)
    ),
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
    const pin = await makePin(identity, [other]);
    const s = store(pin, true, pin.recipients);
    await assertPinned(s, identity, [other]);
    expect(s.confirmFirst).not.toHaveBeenCalled();
    expect(s.saves).toEqual([]);
  });

  it("a valid pin on a device with no record (synced from another device) is recorded here", async () => {
    const pin = await makePin(identity, [other]);
    const s = store(pin);
    await assertPinned(s, identity, [other]);
    expect(s.confirmFirst).not.toHaveBeenCalled();
    expect(s.rec).toEqual(rec(pin.recipients, 1));
  });

  it("F1: record present, pin deleted: refused as removed, never first use", async () => {
    const s = store(undefined, true, [own, other].sort());
    const err = await assertPinned(s, identity, [other, attacker]).catch((e) => e);
    expect(err).toBeInstanceOf(RecipientPinError);
    expect(err.message).toBe(pinRemovedMessage(1, 0));
    expect(s.confirmFirst).not.toHaveBeenCalled();
    expect(s.saves).toEqual([]);
  });

  it("F1: record present, pin forged: refused as removed", async () => {
    const pin = await makePin(identity, [other]);
    const s = store({ ...pin, mac: "0".repeat(64) }, true, pin.recipients);
    await expect(assertPinned(s, identity, [other])).rejects.toThrow(/removed or replaced/);
    expect(s.confirmFirst).not.toHaveBeenCalled();
  });

  it("F1: an older, genuine pin restored over the recorded one is refused, even though it verifies", async () => {
    const old = await makePin(identity, [other, attacker]);
    const s = store(old, true, await effectiveSet(identity, [other]));
    await expect(assertPinned(s, identity, [other, attacker])).rejects.toThrow(/removed or replaced/);
    expect(s.saves).toEqual([]);
  });

  it("F1: evaluatePin reports a removed pin's difference against the record", async () => {
    expect(await evaluatePin(undefined, rec([own, other].sort()), identity, [attacker])).toEqual({
      status: "removed",
      added: [attacker],
      removed: [other],
    });
  });

  it("a blocked store refuses before comparing anything", async () => {
    const pin = await makePin(identity, [other]);
    const s = store(pin, true, pin.recipients);
    s.blockedMsg = "blocked for a reason";
    await expect(assertPinned(s, identity, [other])).rejects.toThrow("blocked for a reason");
  });

  it("F6: an unlock copy with only extra keys is called an old copy; a file, or a copy missing keys, is not", async () => {
    const pin = await makePin(identity, [other]);
    const s = store(pin, true, pin.recipients);
    await expect(assertPinned(s, identity, [other, attacker], "copy")).rejects.toThrow(copyOlderMessage(1));
    await expect(assertPinned(s, identity, [other, attacker], "file")).rejects.toThrow(pinChangedMessage(1, 0));
    await expect(assertPinned(s, identity, [attacker], "copy")).rejects.toThrow(pinChangedMessage(1, 1));
  });

  it("F5: first use passes the identity's own recipient to the prompt", async () => {
    const s = store(undefined, true);
    await assertPinned(s, identity, [other]);
    expect(s.owns).toEqual([own]);
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
    expect((errors[0] as Error).message).toBe(copyOlderMessage(1));
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

/** A pin as builds before seq made it: the MAC covers the list only. */
async function legacyPin(id: string, recipients: string[]): Promise<RecipientPin> {
  const set = await effectiveSet(id, recipients);
  const raw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("halfday-rune recipient pin v1\n" + id.trim())
  );
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(set.join("\n")));
  return { recipients: set, mac: [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("") };
}

describe("fix round 2: N1 seq", () => {
  it("seq is covered by the MAC: changing it, or stripping it, breaks verification", async () => {
    const pin = await makePin(identity, [other], 3);
    expect(await verifiedPin(pin, identity)).toEqual({ recipients: pin.recipients, seq: 3 });
    expect(await verifiedPin({ ...pin, seq: 9 }, identity)).toBeNull();
    const { seq: _drop, ...stripped } = pin;
    expect(await verifiedPin(stripped, identity)).toBeNull();
    expect(await verifiedPin({ ...pin, seq: -1 }, identity)).toBeNull();
    expect(await verifiedPin({ ...pin, seq: 1.5 }, identity)).toBeNull();
  });

  it("a pin from before seq verifies as seq 0", async () => {
    const pin = await legacyPin(identity, [other]);
    expect(await verifiedPin(pin, identity)).toEqual({ recipients: pin.recipients, seq: 0 });
  });

  it("nextSeq is above both the record and the verified pin; a forged pin's seq is ignored", async () => {
    expect(await nextSeq(await makePin(identity, [other], 4), rec([own], 2), identity)).toBe(5);
    expect(await nextSeq(await makePin(identity, [other], 1), rec([own], 7), identity)).toBe(8);
    expect(await nextSeq(undefined, { kind: "none" }, identity)).toBe(1);
    const forged = { ...(await makePin(identity, [other], 1)), seq: 1_000_000 };
    expect(await nextSeq(forged, rec([own], 2), identity)).toBe(3);
  });

  it("a verified pin newer than the record is adopted, then compared as usual", async () => {
    const pin = await makePin(identity, [other], 2);
    expect(await evaluatePin(pin, rec([own, attacker].sort(), 1), identity, [other])).toEqual({
      status: "ok",
      adopt: true,
    });
    expect(await evaluatePin(pin, rec([own], 1), identity, [other, attacker])).toEqual({
      status: "changed",
      added: [attacker],
      removed: [],
      adopt: true,
    });
  });

  it("an older genuine pin (lower seq than the record) is a rollback: removed", async () => {
    const old = await makePin(identity, [other, attacker], 2);
    const s = store(old, true, rec(await effectiveSet(identity, [other]), 3));
    await expect(assertPinned(s, identity, [other, attacker])).rejects.toThrow(/removed or replaced/);
    expect(s.adopted).toEqual([]);
    expect(s.confirmFirst).not.toHaveBeenCalled();
  });

  it("the same seq with a different set is removed", async () => {
    const pin = await makePin(identity, [other, attacker], 2);
    expect((await evaluatePin(pin, rec(await effectiveSet(identity, [other]), 2), identity, [other, attacker])).status).toBe("removed");
  });

  /** Two devices sharing one synced pin (data.json), each with its own record. */
  async function twoDevices(initialSet: string[]) {
    const shared = { pin: (await makePin(identity, initialSet, 1)) as unknown };
    const device = () => {
      const s = store(undefined, false, rec(shared.pin ? (shared.pin as RecipientPin).recipients : [], 1));
      s.get = () => shared.pin;
      s.save = async (p: RecipientPin) => {
        shared.pin = p;
        s.rec = rec(p.recipients, p.seq ?? 0);
        s.saves.push(p);
      };
      return s;
    };
    const confirmOn = async (d: ReturnType<typeof device>, recipients: string[]) =>
      d.save(await makePin(identity, recipients, await nextSeq(shared.pin, d.rec, identity)));
    return { shared, mac: device(), phone: device(), confirmOn };
  }

  it("P4a: the Mac narrows the set, the phone gets a fresh copy: accepted, and the phone's record moves on", async () => {
    const t = await twoDevices([own, other]);
    await t.confirmOn(t.mac, [own]);
    await assertPinned(t.phone, identity, [own], "copy");
    expect(t.phone.rec).toEqual(rec([own], 2));
  });

  it("P4b: the Mac adds a key, the phone gets the matching copy: accepted; a phone with the old copy is told it lacks a key", async () => {
    const t = await twoDevices([own]);
    await t.confirmOn(t.mac, [own, other]);
    await expect(assertPinned(t.phone, identity, [own], "copy")).rejects.toThrow(pinChangedMessage(0, 1));
    await assertPinned(t.phone, identity, [own, other], "copy");
    expect(t.phone.rec).toEqual(rec([own, other].sort(), 2));
  });

  it("P4c: a confirm on the phone does not flip the Mac (no ping-pong)", async () => {
    const t = await twoDevices([own, other]);
    await t.confirmOn(t.mac, [own]);
    await assertPinned(t.phone, identity, [own], "copy");
    await t.confirmOn(t.phone, [own]); // the owner confirms again on the phone
    await assertPinned(t.mac, identity, [own]);
    await assertPinned(t.phone, identity, [own], "copy");
    await assertPinned(t.mac, identity, [own]);
    expect(t.mac.rec).toEqual(rec([own], 3));
    expect(t.phone.rec).toEqual(rec([own], 3));
  });

  it("F6/P6: the Mac removes K, the phone still has a copy with K: newer pin adopted, 'older copy' refusal, and K stays new", async () => {
    const t = await twoDevices([own, other]); // other = K
    await t.confirmOn(t.mac, [own]);
    await expect(assertPinned(t.phone, identity, [own, other], "copy")).rejects.toThrow(copyOlderMessage(1));
    expect(t.phone.rec).toEqual(rec([own], 2));
    // what Confirm on the phone would see: K added against the newer set, never silently re-added
    expect(await evaluatePin(t.shared.pin, t.phone.rec, identity, [own, other])).toEqual({
      status: "changed",
      added: [other],
      removed: [],
    });
  });
});

describe("fix round 2: corrupt record", () => {
  it("parses only a non-empty list of strings with an optional non-negative integer seq", () => {
    expect(parseDeviceRecord(null).record).toEqual({ kind: "none" });
    expect(parseDeviceRecord(undefined).record).toEqual({ kind: "none" });
    expect(parseDeviceRecord({ recipients: null, keyMode: "file" })).toEqual({ record: { kind: "none" }, keyMode: "file" });
    expect(parseDeviceRecord({ recipients: ["age1b", "age1a"], keyMode: "passphrase" })).toEqual({
      record: { kind: "ok", recipients: ["age1a", "age1b"], seq: 0 },
      keyMode: "passphrase",
    });
    expect(parseDeviceRecord({ recipients: ["age1a"], seq: 4 }).record).toEqual({ kind: "ok", recipients: ["age1a"], seq: 4 });
    for (const bad of [
      "garbage",
      42,
      ["age1a"],
      {},
      { recipients: [1, 2] },
      { recipients: "age1a" },
      { recipients: [] },
      { recipients: [""] },
      { recipients: { 0: "age1a" } },
      { recipients: ["age1a"], seq: -1 },
      { recipients: ["age1a"], seq: "3" },
    ]) {
      expect(parseDeviceRecord(bad).record).toEqual({ kind: "corrupt" });
    }
  });

  it("a corrupt record fails closed as removed, never first use", async () => {
    const s = store(undefined, true, { kind: "corrupt" });
    await expect(assertPinned(s, identity, [other])).rejects.toThrow(/removed or replaced/);
    expect(s.confirmFirst).not.toHaveBeenCalled();
    const s2 = store(await makePin(identity, [other]), true, { kind: "corrupt" });
    await expect(assertPinned(s2, identity, [other])).rejects.toThrow(/removed or replaced/);
  });
});
