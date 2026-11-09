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
 * is only rune itself, after the owner unlocked with the passphrase. What it
 * cannot stop: restoring an older data.json together with an older unlock
 * copy (both made by the owner) brings back an older confirmed set.
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
  save(pin: RecipientPin): Promise<void>;
  /**
   * Trust on first use: show `recipients` (the full set, count and
   * fingerprint) and resolve true only if the owner confirms them.
   */
  confirmFirst(recipients: string[]): Promise<boolean>;
}

export type PinCheck =
  | { status: "ok" }
  | { status: "missing" }
  /** The pin is not valid for this identity (edited, or a different key). */
  | { status: "unverified" }
  /** The pin is valid but the set differs. */
  | { status: "changed"; added: string[]; removed: string[] };

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
 * prompt in the middle of a save.
 */
export async function assertPinned(
  store: PinStore,
  identity: string,
  recipients: readonly string[]
): Promise<void> {
  const r = await checkPin(store.get(), identity, recipients);
  if (r.status === "ok") return;
  if (r.status === "unverified") throw new RecipientPinError(PIN_UNVERIFIED_MESSAGE);
  if (r.status === "changed") {
    throw new RecipientPinError(pinChangedMessage(r.added.length, r.removed.length));
  }
  if (!(await store.confirmFirst(await effectiveSet(identity, recipients)))) {
    throw new RecipientPinError(PIN_NOT_CONFIRMED_MESSAGE);
  }
  await store.save(await makePin(identity, recipients));
}
