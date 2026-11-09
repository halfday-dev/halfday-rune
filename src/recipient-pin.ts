/**
 * Recipient pin: the exact set of keys the owner confirmed rune may encrypt
 * to. Every unlock and every encrypt checks the current set against it and
 * fails closed on any difference, so a key appended to recipients.txt (or an
 * older unlock copy swapped in) is refused, never silently used.
 *
 * Where it lives: plugin data (data.json), as the sorted list plus an HMAC
 * keyed from the age identity. data.json is writable by any same-user
 * process, so the list alone would be no stronger than recipients.txt; the
 * MAC means a valid pin can only be made by something holding the identity,
 * the same secret the pin protects. Once the identity file is deleted, that
 * is only rune itself, after the owner unlocked with the passphrase.
 *
 * A pin that is simply gone must not read as "first use": deleting it (or
 * all of data.json) and restoring an older genuine unlock copy would then
 * take one click to re-pin an old set. So each device also keeps a local
 * record (Obsidian's per-vault local storage, never synced) of the set it
 * last confirmed and its key mode. When that record exists, a missing,
 * unverifiable or different pin is refused as "removed or replaced", and
 * Confirm shows the difference against the record. First use is offered
 * only when there is no record at all. What remains: removing the record as
 * well (Obsidian's local storage, not a plain file) brings first use back.
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
  /** Hex HMAC-SHA256 over the list, keyed from the identity. */
  mac: string;
}

/** Reads and writes the pin and asks the owner on first use. */
export interface PinStore {
  get(): unknown;
  /** Saves the pin and this device's local record of it. */
  save(pin: RecipientPin): Promise<void>;
  /** This device's local record of the last confirmed set; null when none. */
  record(): string[] | null;
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
   * This device has a record, and the pin is missing, does not verify, or
   * does not match it. added / removed are against the record.
   */
  | { status: "removed"; added: string[]; removed: string[] };

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

export async function makePin(
  identity: string,
  recipients: readonly string[]
): Promise<RecipientPin> {
  const set = await effectiveSet(identity, recipients);
  const mac = await crypto.subtle.sign("HMAC", await macKey(identity, "sign"), enc(set.join("\n")));
  return { recipients: set, mac: toHex(mac) };
}

function isPinShape(p: unknown): p is RecipientPin {
  const o = p as Partial<RecipientPin> | null;
  return (
    typeof o === "object" &&
    o !== null &&
    Array.isArray(o.recipients) &&
    o.recipients.every((r) => typeof r === "string") &&
    typeof o.mac === "string"
  );
}

export async function checkPin(
  pin: unknown,
  identity: string,
  recipients: readonly string[]
): Promise<PinCheck> {
  if (pin === undefined || pin === null) return { status: "missing" };
  if (!isPinShape(pin)) return { status: "unverified" };
  const mac = fromHex(pin.mac);
  if (!mac) return { status: "unverified" };
  const valid = await crypto.subtle.verify(
    "HMAC",
    await macKey(identity, "verify"),
    mac,
    enc(pin.recipients.join("\n"))
  );
  if (!valid) return { status: "unverified" };
  const set = await effectiveSet(identity, recipients);
  const added = set.filter((r) => !pin.recipients.includes(r));
  const removed = pin.recipients.filter((r) => !set.includes(r));
  if (added.length === 0 && removed.length === 0) return { status: "ok" };
  return { status: "changed", added, removed };
}

/** The identity's own recipient. */
export async function ownRecipient(identity: string): Promise<string> {
  return identityToRecipient(identity.trim());
}

/** A stored record list, normalised; null when it is not a list of strings. */
export function normalizeRecord(r: unknown): string[] | null {
  if (!Array.isArray(r) || !r.every((x) => typeof x === "string")) return null;
  return [...new Set(r.map((x: string) => x.trim()))].sort();
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * checkPin, plus this device's local record. With no record it is checkPin.
 * With one, the pin only counts if it verifies AND holds the recorded set;
 * otherwise it is "removed" (added / removed against the record), so a
 * deleted, forged or rolled-back pin never reads as first use.
 */
export async function evaluatePin(
  pin: unknown,
  record: readonly string[] | null,
  identity: string,
  recipients: readonly string[]
): Promise<PinCheck> {
  const base = await checkPin(pin, identity, recipients);
  if (record === null) return base;
  const trusted =
    (base.status === "ok" || base.status === "changed") &&
    sameSet((pin as RecipientPin).recipients, record);
  if (trusted) return base;
  const set = await effectiveSet(identity, recipients);
  return {
    status: "removed",
    added: set.filter((r) => !record.includes(r)),
    removed: record.filter((r) => !set.includes(r)),
  };
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
 * Pass when the current set matches the pin. No pin yet: ask the owner
 * (trust on first use) and save the confirmed set. A pin that does not
 * verify, or a different set, throws RecipientPinError: changing a confirmed
 * set takes the deliberate 'Confirm recipient set' command, never an inline
 * prompt in the middle of a save. First use is offered only when this device
 * has no record of a confirmed set (see evaluatePin). `context` "copy": the
 * list came from the unlock copy, so a copy that only has extra keys is
 * reported as an old copy.
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
  if (r.status === "ok") {
    // a valid pin synced from another device: record it here
    if (record === null) await store.save(store.get() as RecipientPin);
    return;
  }
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
  await store.save(await makePin(identity, recipients));
}
