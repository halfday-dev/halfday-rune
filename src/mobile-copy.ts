/**
 * Mobile unlock copy: a passphrase-wrapped copy of the age identity, stored
 * in the vault (default `_rune/identity.age`) so it syncs to the phone.
 *
 * Pure logic, no Obsidian or Node imports: the vault is reached through a
 * minimal adapter interface (Obsidian's `vault.adapter` satisfies it), so
 * this is unit-testable. Nothing here logs, and no message ever contains the
 * passphrase or the identity.
 */

import { buildMobileKey, MalformedRecipientError, isScryptWrapped, unwrapMobileKey, wrapMobileKey } from "./crypto";

export const DEFAULT_MOBILE_KEY_PATH = "_rune/identity.age";
export const MIN_PASSPHRASE_LENGTH = 20;

/** The slice of Obsidian's DataAdapter this module uses. */
export interface VaultAdapterLike {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * A mobile key path must be a vault-relative `.age` path: no leading slash,
 * no backslashes, no empty / `.` / `..` segments, not under `.obsidian`.
 */
export function validateMobileKeyPath(
  p: string
): { ok: true } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (typeof p !== "string" || p.length === 0) return bad("path is empty");
  if (p.length > 255) return bad("path is too long");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.startsWith("~")) {
    return bad("path must be relative to the vault root");
  }
  if (p.includes("\\")) return bad("use / as the path separator");
  if (/[\u0000-\u001f]/.test(p)) return bad("path contains control characters");
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) {
    return bad("path must not contain empty, . or .. segments");
  }
  if (parts[0].toLowerCase() === ".obsidian") {
    return bad("path must not be under .obsidian");
  }
  if (!p.toLowerCase().endsWith(".age") || parts[parts.length - 1].length <= 4) {
    return bad("path must name a .age file");
  }
  return { ok: true };
}

/** The configured path if valid, else the default. */
export function effectiveMobileKeyPath(configured: string | undefined): string {
  return configured !== undefined && validateMobileKeyPath(configured).ok
    ? configured
    : DEFAULT_MOBILE_KEY_PATH;
}

export function validatePassphrasePair(
  a: string,
  b: string
): { ok: true } | { ok: false; error: string } {
  if ([...a].length < MIN_PASSPHRASE_LENGTH) {
    return {
      ok: false,
      error: `Use at least ${MIN_PASSPHRASE_LENGTH} characters (a generated password works well).`,
    };
  }
  if (a !== b) return { ok: false, error: "The two passphrases do not match." };
  return { ok: true };
}

export const MOBILE_COPY_FAILED_MESSAGE =
  "Could not create the mobile unlock copy. Nothing was changed.";
export const MOBILE_COPY_RESTORE_FAILED_MESSAGE =
  "Could not create the mobile unlock copy, and the previous file could not be restored. Check the unlock file in your vault.";

export const MOBILE_COPY_NOT_WRAPPED_MESSAGE =
  "A file that is not a rune unlock file already exists at that path. Nothing was changed.";

/**
 * Is it safe to put the unlock copy at `path`? Missing is fine; an existing
 * file must be a scrypt-wrapped (single scrypt stanza) age file, so the
 * command and the setting can never aim at an ordinary encrypted note.
 */
export async function inspectMobileKeyTarget(
  adapter: Pick<VaultAdapterLike, "exists" | "readBinary">,
  path: string
): Promise<"missing" | "wrapped" | "not-wrapped"> {
  if (!(await adapter.exists(path))) return "missing";
  try {
    return isScryptWrapped(new Uint8Array(await adapter.readBinary(path)))
      ? "wrapped"
      : "not-wrapped";
  } catch {
    return "not-wrapped";
  }
}

/**
 * Public fingerprint of the recipients list wrapped into the unlock file
 * (sorted, deduped, own recipient included), stored beside it as a plain
 * sidecar. Desktop compares it with the current list to warn when the phone
 * copy is stale. It is public information and NOT a security control:
 * editing or deleting the sidecar can only suppress or trigger the warning;
 * the phone's encryption always uses the list inside the passphrase-protected
 * file, never the sidecar.
 */
export async function recipientsFingerprint(recipients: readonly string[]): Promise<string> {
  const list = [...new Set(recipients.map((r) => r.trim()))].sort();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(list.join("\n")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `_rune/identity.age` -> `_rune/identity.recipients.sha256`. */
export function fingerprintSidecarPath(keyPath: string): string {
  return keyPath.replace(/\.age$/i, "") + ".recipients.sha256";
}

export const STALE_COPY_WARNING =
  "Your phone's rune unlock copy uses an older recipients list. Re-run 'Create mobile unlock copy', or phone edits will be encrypted to the old keys.";

/**
 * Desktop check: null when there is nothing to warn about, else the warning.
 * No unlock file = nothing to warn about; an unlock file with a missing or
 * different sidecar = warn.
 */
export async function mobileCopyWarning(
  adapter: Pick<VaultAdapterLike, "exists" | "readBinary">,
  keyPath: string,
  currentRecipients: readonly string[]
): Promise<string | null> {
  if (!(await adapter.exists(keyPath))) return null;
  const side = fingerprintSidecarPath(keyPath);
  let stored = "";
  try {
    if (await adapter.exists(side)) {
      stored = new TextDecoder().decode(await adapter.readBinary(side)).trim().toLowerCase();
    }
  } catch {
    stored = "";
  }
  return stored === (await recipientsFingerprint(currentRecipients)) ? null : STALE_COPY_WARNING;
}

/** Fixed-message failure; the cause is deliberately not carried. */
export class MobileCopyError extends Error {
  constructor(message: string = MOBILE_COPY_FAILED_MESSAGE) {
    super(message);
    this.name = "MobileCopyError";
  }
}

const toAB = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function ensureFolder(adapter: VaultAdapterLike, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
  }
}

export interface MobileCopyResult {
  /** The identity's own recipient was missing from the list and was added. */
  addedOwnRecipient: boolean;
  /**
   * Recipients added / removed relative to the file this replaced. null when
   * there was no previous file, or it could not be opened with this
   * passphrase (it may have been made with a different one).
   */
  changes: { added: number; removed: number } | null;
}

/**
 * Wrap `identity` plus the full `recipients` list under `passphrase` and
 * write it to `path`. The write is verified by reading the file back and
 * unwrapping it with the same passphrase. On any failure the previous state
 * is restored: a pre-existing file is put back byte for byte, and a file this
 * call created is removed. Nothing that existed before is deleted. Throws
 * MobileCopyError only.
 */
export async function createMobileCopy(
  adapter: VaultAdapterLike,
  path: string,
  identity: string,
  recipients: readonly string[],
  passphrase: string,
  logN?: number
): Promise<MobileCopyResult> {
  if (!validateMobileKeyPath(path).ok) throw new MobileCopyError();

  let previous: Uint8Array | null = null;
  let wrote = false;
  let previousSide: Uint8Array | null = null;
  let sideWrote = false;
  const side = fingerprintSidecarPath(path);
  try {
    if (await adapter.exists(path)) {
      previous = new Uint8Array(await adapter.readBinary(path));
      if (!isScryptWrapped(previous)) {
        // not ours: refuse before anything is written
        throw new MobileCopyError(MOBILE_COPY_NOT_WRAPPED_MESSAGE);
      }
    }
    let key;
    try {
      key = await buildMobileKey(identity, recipients);
    } catch (e) {
      if (e instanceof MalformedRecipientError) {
        throw new MobileCopyError(
          `Recipient ${e.position} in your recipients list is not a plain age1 key (plugin and SSH recipients cannot be used on the phone). Nothing was changed.`
        );
      }
      throw e;
    }
    if (await adapter.exists(side)) previousSide = new Uint8Array(await adapter.readBinary(side));
    const wrapped = await wrapMobileKey(key.identity, key.recipients, passphrase, logN);

    let changes: MobileCopyResult["changes"] = null;
    if (previous) {
      try {
        const old = await unwrapMobileKey(previous, passphrase);
        changes = {
          added: key.recipients.filter((r) => !old.recipients.includes(r)).length,
          removed: old.recipients.filter((r) => !key.recipients.includes(r)).length,
        };
      } catch {
        changes = null;
      }
    }

    await ensureFolder(adapter, path);
    wrote = true;
    await adapter.writeBinary(path, toAB(wrapped));

    const back = new Uint8Array(await adapter.readBinary(path));
    if (!sameBytes(back, wrapped)) throw new Error("read-back differs");
    const check = await unwrapMobileKey(back, passphrase);
    if (
      check.identity !== key.identity ||
      check.recipients.length !== key.recipients.length ||
      check.recipients.some((r, i) => r !== key.recipients[i])
    ) {
      throw new Error("unwrap differs");
    }
    sideWrote = true;
    await adapter.writeBinary(
      side,
      toAB(new TextEncoder().encode((await recipientsFingerprint(key.recipients)) + "\n"))
    );
    return { addedOwnRecipient: key.addedOwn, changes };
  } catch (err) {
    if (err instanceof MobileCopyError && !wrote) throw err;
    if (wrote) {
      try {
        if (previous) await adapter.writeBinary(path, toAB(previous));
        else await adapter.remove(path);
        if (sideWrote) {
          if (previousSide) await adapter.writeBinary(side, toAB(previousSide));
          else await adapter.remove(side);
        }
      } catch {
        throw new MobileCopyError(MOBILE_COPY_RESTORE_FAILED_MESSAGE);
      }
    }
    throw new MobileCopyError();
  }
}

/** Extra success-message text: what the copy contains and what changed. */
export function mobileCopySummary(r: MobileCopyResult): string {
  let out = "";
  if (r.addedOwnRecipient) {
    out += " (your key's own recipient was not in your recipients list, so it was added to the copy)";
  }
  if (r.changes && (r.changes.added > 0 || r.changes.removed > 0)) {
    out += ` — recipients updated: +${r.changes.added} / −${r.changes.removed}`;
  }
  return out;
}
