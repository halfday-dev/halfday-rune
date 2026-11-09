/**
 * Recipient pin: the exact set of keys the owner confirmed rune may encrypt
 * to. Every unlock and every encrypt checks the current set against it and
 * fails closed on any difference, so a key appended to recipients.txt (or an
 * older unlock copy swapped in) is refused, never silently used.
 *
 * Where it lives: plugin data (data.json), as the sorted list, a confirmation
 * counter `seq`, and an HMAC over both keyed from the age identity. data.json
 * is writable by any same-user process, so the list alone would be no
 * stronger than recipients.txt; the MAC means a valid pin can only be made by
 * something holding the identity, the same secret the pin protects. Once the
 * identity file is deleted, that is only rune itself, after the owner
 * unlocked with the passphrase.
 *
 * A pin that is simply gone must not read as "first use": deleting it (or
 * all of data.json) and restoring an older genuine unlock copy would then
 * take one click to re-pin an old set. So each device also keeps a local
 * record (Obsidian's per-vault local storage, never synced) of the newest
 * confirmation it has seen (set + seq) and its key mode. With a record:
 *   - a missing or unverifiable pin, or a corrupt record: "removed";
 *   - a verified pin with a LOWER seq than the record: a rollback, "removed";
 *   - the same seq: must be the same set, else "removed";
 *   - a HIGHER seq: a newer confirmation made on another device. It is
 *     adopted (the record moves forward) and the sets are compared as usual,
 *     so a change made on the Mac is not an attack on the phone.
 * First use is offered only when there is no record at all. What remains:
 * removing the record as well brings first use back, and a device that has
 * not yet seen a confirmation can be handed an older genuine pin that is
 * still newer than its record.
 *
 * Every confirm writes seq = max(record seq, verified pin seq) + 1. Pins from
 * before seq existed verify with the old MAC and count as seq 0.
 *
 * The set compared is the recipients plus the identity's own recipient,
 * sorted and deduped, so desktop (recipients.txt) and the unlock copy (which
 * always carries the own recipient) pin the same set.
 *
 * Pure: no Node or Obsidian imports. The identity is used only to derive the
 * MAC key and is never stored or put in a message.
 */

import { identityToRecipient } from "age-encryption";

export interface RecipientPin {
  /** Sorted, deduped; includes the identity's own recipient. */
  recipients: string[];
  /** Confirmation counter, +1 on every confirm. Absent on pins from before it: 0. */
  seq?: number;
  /** Hex HMAC-SHA256 over seq and the list, keyed from the identity. */
  mac: string;
}

/** This device's local record of the newest confirmation it has seen. */
export type DeviceRecord =
  | { kind: "none" }
  /** A record exists but does not parse: fails closed, never first use. */
  | { kind: "corrupt" }
  | { kind: "ok"; recipients: string[]; seq: number };

/** Reads and writes the pin and asks the owner on first use. */
export interface PinStore {
  get(): unknown;
  /** Saves the pin and this device's local record of it. */
  save(pin: RecipientPin): Promise<void>;
  /** This device's local record. */
  record(): DeviceRecord;
  /** Move the local record to a verified pin (a newer confirmation from elsewhere). */
  adopt(pin: RecipientPin): void;
  /** A fixed refusal that applies before any set is compared, else null. */
  blocked?(): string | null;
  /**
   * Trust on first use: show `recipients` (the full set, count and
   * fingerprint; `own` is the identity's own recipient) and resolve true only
   * if the owner confirms them.
   */
  confirmFirst(recipients: string[], own: string): Promise<boolean>;
}

export type PinCheck =
  | { status: "ok" }
  | { status: "missing" }
  /** The pin is not valid for this identity (edited, or a different key). */
  | { status: "unverified" }
  /** The pin is valid but the set differs. */
  | { status: "changed"; added: string[]; removed: string[] }
  /**
   * This device has a record, and the pin is missing, does not verify, is
   * older than the record, or the record is corrupt. added / removed are
   * against the record (against nothing when it is corrupt).
   */
  | { status: "removed"; added: string[]; removed: string[] };

/** evaluatePin's answer: `adopt` means the pin is newer than the record and verified. */
export type PinEvaluation = PinCheck & { adopt?: boolean };

const MAC_CONTEXT = "halfday-rune recipient pin v1\n";

const enc = (s: string) => new TextEncoder().encode(s);
const toHex = (b: ArrayBuffer): string =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

function fromHex(s: string) {
  if (!/^[0-9a-f]{64}$/.test(s)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const isSeq = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** The set rune compares: recipients plus the identity's own, sorted, deduped. */
export async function effectiveSet(
  identity: string,
  recipients: readonly string[]
): Promise<string[]> {
  const own = await identityToRecipient(identity.trim());
  return [...new Set([...recipients.map((r) => r.trim()), own])].sort();
}

async function macKey(identity: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc(MAC_CONTEXT + identity.trim()));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** What the MAC covers. A pin without seq (older builds) covers the list only. */
const macMessage = (set: readonly string[], seq: number | undefined): string =>
  (seq === undefined ? "" : `seq ${seq}\n`) + set.join("\n");

export async function makePin(
  identity: string,
  recipients: readonly string[],
  seq: number = 1
): Promise<RecipientPin> {
  if (!isSeq(seq)) throw new RangeError("seq must be a non-negative integer");
  const set = await effectiveSet(identity, recipients);
  const mac = await crypto.subtle.sign(
    "HMAC",
    await macKey(identity, "sign"),
    enc(macMessage(set, seq))
  );
  return { recipients: set, seq, mac: toHex(mac) };
}

function isPinShape(p: unknown): p is RecipientPin {
  const o = p as Partial<RecipientPin> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    Array.isArray(o.recipients) &&
    o.recipients.every((r) => typeof r === "string") &&
    typeof o.mac === "string" &&
    (o.seq === undefined || isSeq(o.seq))
  );
}

/** The pin's set and seq when it verifies for this identity, else null. */
export async function verifiedPin(
  pin: unknown,
  identity: string
): Promise<{ recipients: string[]; seq: number } | null> {
  if (!isPinShape(pin)) return null;
  const mac = fromHex(pin.mac);
  if (!mac) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await macKey(identity, "verify"),
    mac,
    enc(macMessage(pin.recipients, pin.seq))
  );
  return valid ? { recipients: pin.recipients, seq: pin.seq ?? 0 } : null;
}

const diffAgainst = (set: readonly string[], base: readonly string[]) => ({
  added: set.filter((r) => !base.includes(r)),
  removed: base.filter((r) => !set.includes(r)),
});

function compare(set: readonly string[], pinned: readonly string[]): PinCheck {
  const d = diffAgainst(set, pinned);
  if (d.added.length === 0 && d.removed.length === 0) return { status: "ok" };
  return { status: "changed", ...d };
}

export async function checkPin(
  pin: unknown,
  identity: string,
  recipients: readonly string[]
): Promise<PinCheck> {
  if (pin === undefined || pin === null) return { status: "missing" };
  const v = await verifiedPin(pin, identity);
  if (!v) return { status: "unverified" };
  return compare(await effectiveSet(identity, recipients), v.recipients);
}

/** The identity's own recipient. */
export async function ownRecipient(identity: string): Promise<string> {
  return identityToRecipient(identity.trim());
}

/**
 * Parse a stored device record. Absent: none. `recipients: null` is a
 * mode-only record (key mode known, no set confirmed yet): none for the set.
 * Anything else that is not a non-empty list of strings with an optional
 * non-negative integer seq is corrupt, which fails closed.
 */
export function parseDeviceRecord(raw: unknown): {
  record: DeviceRecord;
  keyMode: "file" | "passphrase" | null;
} {
  if (raw === null || raw === undefined) return { record: { kind: "none" }, keyMode: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { record: { kind: "corrupt" }, keyMode: null };
  }
  const o = raw as Record<string, unknown>;
  const keyMode = o.keyMode === "file" || o.keyMode === "passphrase" ? o.keyMode : null;
  if (o.recipients === null) return { record: { kind: "none" }, keyMode };
  const r = o.recipients;
  const seq = o.seq === undefined ? 0 : o.seq;
  if (
    !Array.isArray(r) ||
    r.length === 0 ||
    !r.every((x) => typeof x === "string" && x.trim() !== "") ||
    !isSeq(seq)
  ) {
    return { record: { kind: "corrupt" }, keyMode };
  }
  return {
    record: { kind: "ok", recipients: [...new Set(r.map((x: string) => x.trim()))].sort(), seq },
    keyMode,
  };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * checkPin, plus this device's local record (see the header for the rules).
 * `adopt` is set when the pin verifies and is newer than the record (or there
 * is no record): the caller moves the record to it.
 */
export async function evaluatePin(
  pin: unknown,
  record: DeviceRecord,
  identity: string,
  recipients: readonly string[]
): Promise<PinEvaluation> {
  const set = await effectiveSet(identity, recipients);
  const v = pin === undefined || pin === null ? null : await verifiedPin(pin, identity);
  if (record.kind === "none") {
    if (pin === undefined || pin === null) return { status: "missing" };
    if (!v) return { status: "unverified" };
    return { ...compare(set, v.recipients), adopt: true };
  }
  if (record.kind === "corrupt") return { status: "removed", ...diffAgainst(set, []) };
  const removed: PinEvaluation = { status: "removed", ...diffAgainst(set, record.recipients) };
  if (!v || v.seq < record.seq) return removed;
  if (v.seq === record.seq) {
    return sameSet(v.recipients, record.recipients) ? compare(set, v.recipients) : removed;
  }
  return { ...compare(set, v.recipients), adopt: true };
}

/** The seq for the next confirmation: above both the record and any verified pin. */
export async function nextSeq(
  pin: unknown,
  record: DeviceRecord,
  identity: string
): Promise<number> {
  const v = await verifiedPin(pin, identity);
  return Math.max(record.kind === "ok" ? record.seq : 0, v?.seq ?? 0) + 1;
}

export const PIN_NOT_CONFIRMED_MESSAGE =
  "Halfday Rune: the recipient set was not confirmed, so nothing was encrypted. Run 'Confirm recipient set' to review it.";
export const PIN_UNVERIFIED_MESSAGE =
  "Halfday Rune: your confirmed recipient set could not be verified with your key (it was edited, or your key changed). Nothing was encrypted or unlocked. Run 'Confirm recipient set' to review it.";

export function pinChangedMessage(added: number, removed: number): string {
  return (
    `Halfday Rune: your recipients differ from the set you confirmed (+${added} added, −${removed} removed). ` +
    "Nothing was encrypted or unlocked. If you made this change, run 'Confirm recipient set'."
  );
}

/** The unlock copy holds keys the confirmed set dropped, and lacks none. */
export function copyOlderMessage(extra: number): string {
  return (
    `Halfday Rune: this unlock copy is older than your confirmed set (it still has ${extra} key(s) you removed). ` +
    "Nothing was unlocked. Make a new unlock copy on desktop."
  );
}

export function pinRemovedMessage(added: number, removed: number): string {
  return (
    "Halfday Rune: your confirmed recipient set was removed or replaced " +
    `(+${added} / −${removed} against the set you last confirmed on this device). ` +
    "Nothing was encrypted or unlocked. Run 'Confirm recipient set' to review it."
  );
}

/** Fixed-message refusal; carries counts only. */
export class RecipientPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipientPinError";
  }
}

/**
 * Pass when the current set matches the pin. No pin and no record: ask the
 * owner (trust on first use) and save the confirmed set. Anything else that
 * is not a match throws RecipientPinError: changing a confirmed set takes the
 * deliberate 'Confirm recipient set' command, never an inline prompt in the
 * middle of a save. A verified newer pin is adopted into the record first.
 * `context` "copy": the list came from the unlock copy, so a copy that only
 * has extra keys is reported as an old copy.
 */
export async function assertPinned(
  store: PinStore,
  identity: string,
  recipients: readonly string[],
  context: "file" | "copy" = "file"
): Promise<void> {
  const blocked = store.blocked?.() ?? null;
  if (blocked !== null) throw new RecipientPinError(blocked);
  const record = store.record();
  const r = await evaluatePin(store.get(), record, identity, recipients);
  if (r.adopt) store.adopt(store.get() as RecipientPin);
  if (r.status === "ok") return;
  if (r.status === "unverified") throw new RecipientPinError(PIN_UNVERIFIED_MESSAGE);
  if (r.status === "removed") {
    throw new RecipientPinError(pinRemovedMessage(r.added.length, r.removed.length));
  }
  if (r.status === "changed") {
    throw new RecipientPinError(
      context === "copy" && r.removed.length === 0
        ? copyOlderMessage(r.added.length)
        : pinChangedMessage(r.added.length, r.removed.length)
    );
  }
  const set = await effectiveSet(identity, recipients);
  if (!(await store.confirmFirst(set, await ownRecipient(identity)))) {
    throw new RecipientPinError(PIN_NOT_CONFIRMED_MESSAGE);
  }
  await store.save(await makePin(identity, recipients, await nextSeq(store.get(), record, identity)));
}
