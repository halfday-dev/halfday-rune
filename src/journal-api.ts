/**
 * Journal API: a narrow, owner-enabled way for another plugin (gabbro's
 * Journal tab) to read and write encrypted notes in ONE vault folder while
 * rune is unlocked. Exposed as `plugin.journalApi`.
 *
 * What it guarantees:
 *   - Off unless the owner names a folder ("Folder gabbro may open"). Empty
 *     means every call refuses.
 *   - Every call refuses while rune is locked, and never prompts to unlock:
 *     the key source is only touched straight after a synchronous
 *     isUnlocked() check, and a lock during a call discards its result.
 *   - Paths must already be canonical vault-relative paths strictly inside
 *     the folder (no `..`, `.`, empty segments, backslashes or a leading
 *     `/`), name a supported encrypted file, and (desktop) not pass through
 *     a symlink. The wrapped identity file is never readable or writable.
 *   - encrypt() uses the key source's pinned recipients and the same
 *     refusals as a normal rune save, round-trip-verifies in memory before
 *     writing, then reads the file back and verifies it decrypts to the same
 *     text. Only what is provably this call's own is ever undone: if the
 *     file no longer holds the bytes it wrote, nothing is touched
 *     ("conflict"); if it does but they don't decrypt back, the previous
 *     ciphertext is put back (replace) or the file removed (create), and a
 *     failed undo is "restore-failed".
 *   - The key is read with peekIdentity()/peekRecipients(): API calls never
 *     reset rune's idle auto-lock.
 *   - replace refuses while the file is open with unsaved edits in a rune
 *     editor, and the folder is re-checked just before the write.
 *   - Nothing plaintext is written to disk, logged or put in an error. The
 *     identity, passphrase and a decrypt-anything function are never exposed.
 *
 * Exposure (stated, not solved): while rune is unlocked, any plugin in the
 * vault can call this, the same exposure rune's open views already have.
 *
 * Pure: no Node or Obsidian imports. The plugin passes in the vault access
 * and (desktop) the symlink check, so tests can drive it directly.
 */

import { decryptToString, encrypt, inspectNoteForMobileSave } from "./crypto";
import type { KeySource } from "./keysource";
import { KeyLockedError } from "./keysource";
import { foldPath, isExcludedPath } from "./path-fold";
import { RecipientPinError } from "./recipient-pin";

export const JOURNAL_API_VERSION = 1;

export type JournalApiErrorCode =
  /** rune is locked (or was locked during the call, or the plugin unloaded). */
  | "locked"
  /** The owner has not named a folder, or the setting is not a valid folder. */
  | "disabled"
  /** The path is not a canonical vault-relative path. */
  | "bad-path"
  /** encrypt(): `text` is not a string or `opts.mode` is not "create" / "replace". */
  | "bad-input"
  /** The path is not strictly inside the allowed folder. */
  | "outside-folder"
  /** A component of the path is a symlink, or it could not be checked. */
  | "symlink"
  /** Not a supported encrypted file name, or the wrapped identity file. */
  | "unsupported-type"
  /** create: something is already at the path. */
  | "exists"
  /** decrypt / replace: no file at the path (or its folder is missing). */
  | "missing"
  /** The recipient set or the note on disk refused the write (same rules as a rune save). */
  | "refused"
  /** The file could not be decrypted with the unlocked key. */
  | "decrypt-failed"
  /** Encrypting, or the in-memory round trip, failed. Nothing was written. */
  | "encrypt-failed"
  /** The vault write failed. */
  | "write-failed"
  /** The written file did not read back as the same text (the old file was put back). */
  | "verify-failed"
  /**
   * The written file did not read back as the same text AND putting the old
   * file back (replace) or removing the new one (create) failed too. The
   * entry on disk may be damaged.
   */
  | "restore-failed"
  /** replace: the file is open in a rune editor with unsaved edits. */
  | "open-in-editor"
  /**
   * After the write, the file did not hold the bytes this call wrote
   * (another writer landed there, or the write was damaged). Nothing was
   * undone or deleted: only what is provably this call's own is ever undone.
   */
  | "conflict";

const MESSAGES: Record<JournalApiErrorCode, string> = {
  locked: "rune is locked",
  disabled: "the journal API is off: no folder is set in rune's settings",
  "bad-path": "the path must be a plain vault-relative file path",
  "bad-input": 'encrypt() needs a string and opts.mode "create" or "replace"',
  "outside-folder": "the path is not inside the folder rune allows",
  symlink: "the path goes through a symlink (or could not be checked)",
  "unsupported-type": "the path is not an encrypted note this API handles",
  exists: "a file already exists at that path",
  missing: "there is no file at that path",
  refused: "rune refused to encrypt",
  "decrypt-failed": "the file could not be decrypted with the unlocked key",
  "encrypt-failed": "encrypting failed; nothing was written",
  "write-failed": "writing the file failed",
  "verify-failed": "the written file did not read back as the same text; the previous file was kept",
  "restore-failed": "the written file did not read back as the same text and could not be undone; the entry may be damaged",
  "open-in-editor": "the file is open in rune with unsaved edits; save or close it first",
  conflict:
    "after writing, the file did not hold what was written (another writer, or a damaged write); nothing was undone",
};

/**
 * Every refusal. Messages are fixed text (or a RecipientPinError's fixed,
 * counts-only text): never plaintext, key material or an underlying error.
 */
export class JournalApiError extends Error {
  readonly code: JournalApiErrorCode;
  constructor(code: JournalApiErrorCode, message?: string) {
    super(`Halfday Rune journal API: ${message ?? MESSAGES[code]}`);
    this.name = "JournalApiError";
    this.code = code;
  }
}

export interface JournalEncryptOptions {
  /** "create": fail if the path exists. "replace": fail if it does not. */
  mode: "create" | "replace";
}

/** The public surface. Frozen; holds no reference to the key source. */
export interface JournalApi {
  readonly apiVersion: number;
  isUnlocked(): boolean;
  onLockChange(cb: (unlocked: boolean) => void): () => void;
  decrypt(path: string): Promise<string>;
  encrypt(path: string, text: string, opts: JournalEncryptOptions): Promise<void>;
}

/** The slice of the vault the API uses (the plugin wraps app.vault). */
export interface JournalVault {
  /** What is at a vault path right now. "other": present but not a plain file. */
  kind(path: string): Promise<"file" | "folder" | "none" | "other">;
  read(path: string): Promise<ArrayBuffer>;
  /** Fails if the path exists. */
  create(path: string, data: ArrayBuffer): Promise<void>;
  /** Overwrites an existing file. */
  replace(path: string, data: ArrayBuffer): Promise<void>;
  /** Deletes a file (only ever one this API just created and that failed its check). */
  remove(path: string): Promise<void>;
}

export interface JournalApiDeps {
  /** The plugin's key source; throws once the plugin has unloaded. */
  getKeySource: () => KeySource;
  /** The raw "Folder gabbro may open" setting. */
  getFolder: () => string;
  /** Vault paths never handled (the wrapped identity file). */
  excludedPaths: () => string[];
  vault: JournalVault;
  /**
   * Desktop: true when any component of the vault path is a symlink. Throws
   * when it cannot tell (treated as a symlink). null where symlinks cannot
   * be checked (mobile).
   */
  pathHasSymlink: ((path: string) => Promise<boolean>) | null;
  /** True when the file is open in a rune editor with unsaved edits. */
  isOpenDirty: (path: string) => boolean;
}

/**
 * Validate the "Folder gabbro may open" setting. Trims, drops trailing
 * slashes and NFC-normalises; "" is valid and means off. Refuses anything
 * that is not a plain vault-relative folder, and `.obsidian`.
 */
export function validateJournalFolder(
  raw: string
): { ok: true; folder: string } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (typeof raw !== "string") return bad("not text");
  const v = raw.trim().normalize("NFC").replace(/\/+$/, "");
  if (v === "") {
    // "/" alone (the whole vault) is not a folder setting
    return raw.trim() === "" ? { ok: true, folder: "" } : bad("name a folder, not the vault root");
  }
  if (v.length > 255) return bad("path is too long");
  if (v.startsWith("/") || /^[A-Za-z]:/.test(v) || v.startsWith("~")) {
    return bad("path must be relative to the vault root");
  }
  if (v.includes("\\")) return bad("use / as the path separator");
  if (/[\u0000-\u001f\u007f]/.test(v)) return bad("path contains control characters");
  const parts = v.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) {
    return bad("path must not contain empty, . or .. segments");
  }
  if (parts[0].toLowerCase() === ".obsidian") return bad("path must not be under .obsidian");
  return { ok: true, folder: v };
}

/** Which files each call accepts. */
const DECRYPT_SUFFIXES = [".md.age", ".age"];
const ENCRYPT_SUFFIXES = [".md.age"];

/**
 * Check `path` against the folder and return it. Never normalises the path
 * into something else: a path that is not already canonical is refused, so
 * what is checked is exactly what is read or written.
 */
export function checkJournalPath(
  path: unknown,
  folder: string,
  suffixes: readonly string[],
  excluded: readonly string[]
): string {
  if (folder === "") throw new JournalApiError("disabled");
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) {
    throw new JournalApiError("bad-path");
  }
  if (path !== path.normalize("NFC")) throw new JournalApiError("bad-path");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("~")) {
    throw new JournalApiError("bad-path");
  }
  if (path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new JournalApiError("bad-path");
  }
  const parts = path.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) {
    throw new JournalApiError("bad-path");
  }
  // Exact, case-sensitive prefix: on a case-sensitive filesystem "Journal"
  // and "journal" are different folders.
  const folderParts = folder.split("/");
  if (
    parts.length <= folderParts.length ||
    folderParts.some((seg, i) => parts[i] !== seg)
  ) {
    throw new JournalApiError("outside-folder");
  }
  const name = parts[parts.length - 1];
  const lower = name.toLowerCase();
  const suffix = suffixes.find((s) => lower.endsWith(s));
  if (!suffix || name.length <= suffix.length) throw new JournalApiError("unsupported-type");
  if (isExcludedPath(path, excluded)) throw new JournalApiError("unsupported-type");
  return path;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * The implementation. The plugin keeps this private and publishes only
 * `api()`, a frozen object of closures.
 */
export class JournalApiHost {
  /** Bumped on every lock; a call that sees it move discards its result. */
  private lockGen = 0;
  private disposed = false;
  private listeners = new Set<(unlocked: boolean) => void>();
  /** Per-path write queue (folded key), so two writes to one file never interleave. */
  private writes = new Map<string, Promise<void>>();
  private published: JournalApi | null = null;

  constructor(private readonly deps: JournalApiDeps) {}

  /** The object other plugins see. */
  api(): JournalApi {
    if (!this.published) {
      this.published = Object.freeze({
        apiVersion: JOURNAL_API_VERSION,
        isUnlocked: () => this.isUnlocked(),
        onLockChange: (cb: (unlocked: boolean) => void) => this.onLockChange(cb),
        decrypt: (path: string) => this.decrypt(path),
        encrypt: (path: string, text: string, opts: JournalEncryptOptions) =>
          this.encrypt(path, text, opts),
      });
    }
    return this.published;
  }

  /** The plugin calls this from the key source's state change (unlock, lock, auto-lock). */
  notifyLockChange(unlocked: boolean): void {
    if (!unlocked) this.lockGen++;
    for (const cb of [...this.listeners]) {
      try {
        cb(unlocked);
      } catch {
        /* a listener's error is its own; never let it stop the others */
      }
    }
  }

  /** Plugin unload: refuse everything from now on. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lockGen++;
    this.notifyLockChange(false);
    this.listeners.clear();
  }

  isUnlocked(): boolean {
    if (this.disposed) return false;
    try {
      return this.deps.getKeySource().isUnlocked();
    } catch {
      return false;
    }
  }

  onLockChange(cb: (unlocked: boolean) => void): () => void {
    if (typeof cb !== "function" || this.disposed) return () => {};
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async decrypt(path: string): Promise<string> {
    const { keys, gen } = this.begin();
    const p = await this.checkPath(path, DECRYPT_SUFFIXES);
    if ((await this.deps.vault.kind(p)) !== "file") throw new JournalApiError("missing");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await this.deps.vault.read(p));
    } catch {
      throw new JournalApiError("missing");
    }
    const identity = await this.identity(keys, gen);
    let text: string;
    try {
      text = await decryptToString(identity, bytes);
    } catch {
      throw new JournalApiError("decrypt-failed");
    }
    // locked while decrypting: the caller must not get plaintext after a lock
    this.assertStillUnlocked(keys, gen);
    return text;
  }

  async encrypt(path: string, text: string, opts: JournalEncryptOptions): Promise<void> {
    const { keys, gen } = this.begin();
    const mode = opts?.mode;
    if ((mode !== "create" && mode !== "replace") || typeof text !== "string") {
      throw new JournalApiError("bad-input");
    }
    const p = await this.checkPath(path, ENCRYPT_SUFFIXES);
    return this.queued(p, () => this.doEncrypt(keys, gen, p, text, mode));
  }

  // ---- internals ----

  /** Refuse unless unlocked and enabled; returns the key source and lock generation. */
  private begin(): { keys: KeySource; gen: number } {
    if (this.disposed) throw new JournalApiError("locked");
    let keys: KeySource;
    try {
      keys = this.deps.getKeySource();
    } catch {
      throw new JournalApiError("locked");
    }
    if (!keys.isUnlocked()) throw new JournalApiError("locked");
    const folder = validateJournalFolder(this.deps.getFolder());
    if (!folder.ok || folder.folder === "") throw new JournalApiError("disabled");
    return { keys, gen: this.lockGen };
  }

  private assertStillUnlocked(keys: KeySource, gen: number): void {
    if (this.disposed || gen !== this.lockGen || !keys.isUnlocked()) {
      throw new JournalApiError("locked");
    }
  }

  /**
   * The identity via peekIdentity(): never prompts (throws KeyLockedError
   * when locked) and does not reset the idle auto-lock, so a caller polling
   * the API cannot keep rune unlocked.
   */
  private async identity(keys: KeySource, gen: number): Promise<string> {
    this.assertStillUnlocked(keys, gen);
    try {
      return await keys.peekIdentity();
    } catch {
      throw new JournalApiError("locked");
    }
  }

  /** The pinned recipients, same rules as a rune save; never prompts, no idle reset. */
  private async recipients(keys: KeySource, gen: number): Promise<string[]> {
    this.assertStillUnlocked(keys, gen);
    try {
      return await keys.peekRecipients();
    } catch (err) {
      if (err instanceof RecipientPinError) throw new JournalApiError("refused", err.message);
      if (err instanceof KeyLockedError) throw new JournalApiError("locked");
      throw new JournalApiError("refused");
    }
  }

  /** The path against the folder setting as it is right now (no symlink check). */
  private checkAgainstFolder(path: string, suffixes: readonly string[]): string {
    // re-read the setting each time: a change takes effect immediately
    const folder = validateJournalFolder(this.deps.getFolder());
    if (!folder.ok) throw new JournalApiError("disabled");
    return checkJournalPath(path, folder.folder, suffixes, this.deps.excludedPaths());
  }

  private async checkPath(path: string, suffixes: readonly string[]): Promise<string> {
    const p = this.checkAgainstFolder(path, suffixes);
    const check = this.deps.pathHasSymlink;
    if (check) {
      let linked: boolean;
      try {
        linked = await check(p);
      } catch {
        linked = true; // could not tell: fail closed
      }
      if (linked) throw new JournalApiError("symlink");
    }
    return p;
  }

  private async queued(path: string, run: () => Promise<void>): Promise<void> {
    const key = foldPath(path);
    const prev = this.writes.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(run);
    const tail = next.catch(() => {});
    this.writes.set(key, tail);
    void tail.then(() => {
      if (this.writes.get(key) === tail) this.writes.delete(key);
    });
    return next;
  }

  private async doEncrypt(
    keys: KeySource,
    gen: number,
    p: string,
    text: string,
    mode: "create" | "replace"
  ): Promise<void> {
    const vault = this.deps.vault;
    this.assertStillUnlocked(keys, gen);
    // queued behind another write: the folder may have changed since the call
    this.checkAgainstFolder(p, ENCRYPT_SUFFIXES);
    if (mode === "replace" && this.deps.isOpenDirty(p)) throw new JournalApiError("open-in-editor");

    const parent = p.slice(0, p.lastIndexOf("/"));
    if ((await vault.kind(parent)) !== "folder") throw new JournalApiError("missing");
    const kind = await vault.kind(p);
    if (mode === "create" && kind !== "none") throw new JournalApiError("exists");
    if (mode === "replace" && kind !== "file") throw new JournalApiError("missing");

    const recipients = await this.recipients(keys, gen);
    const identity = await this.identity(keys, gen);

    let old: Uint8Array | null = null;
    if (mode === "replace") {
      try {
        old = new Uint8Array(await vault.read(p));
      } catch {
        throw new JournalApiError("missing");
      }
      // Never replace a file the unlocked key cannot open. With a fixed list
      // (the unlock copy) also refuse a note that has more recipients than
      // the list, as a rune save does: re-encrypting would drop one.
      const note = await inspectNoteForMobileSave(identity, old);
      if (!note.ok) {
        throw new JournalApiError("refused", "the existing file is not encrypted to the unlocked key");
      }
      if (keys.fixedRecipientList && note.x25519Stanzas + note.otherStanzas > recipients.length) {
        throw new JournalApiError(
          "refused",
          "the existing file is encrypted to keys this device's unlock copy does not have"
        );
      }
    }

    let ciphertext: Uint8Array;
    try {
      ciphertext = await encrypt(recipients, text);
      // round-trip in memory before anything touches disk
      if ((await decryptToString(identity, ciphertext)) !== text) {
        throw new Error("mismatch");
      }
    } catch {
      throw new JournalApiError("encrypt-failed");
    }

    // locked, folder cleared or narrowed, or the owner started editing the
    // file while encrypting: write nothing
    this.assertStillUnlocked(keys, gen);
    this.checkAgainstFolder(p, ENCRYPT_SUFFIXES);
    if (mode === "replace" && this.deps.isOpenDirty(p)) throw new JournalApiError("open-in-editor");

    try {
      if (mode === "create") await vault.create(p, toArrayBuffer(ciphertext));
      else await vault.replace(p, toArrayBuffer(ciphertext));
    } catch {
      throw new JournalApiError("write-failed");
    }

    // read back from the vault: it must be exactly the ciphertext this call
    // wrote, and decrypt to the same text
    let onDisk: Uint8Array;
    try {
      onDisk = new Uint8Array(await vault.read(p));
    } catch {
      // can't tell what is there: touch nothing
      throw new JournalApiError("restore-failed");
    }
    if (!bytesEqual(onDisk, ciphertext)) {
      // Another writer (sync, another device) landed here after our write,
      // or the write was damaged: either way the bytes are not provably ours,
      // so nothing is undone and nothing is deleted.
      throw new JournalApiError("conflict");
    }
    let readBack = false;
    try {
      readBack = (await decryptToString(identity, onDisk)) === text;
    } catch {
      readBack = false;
    }
    if (readBack) return;

    // The file holds exactly our bytes and they don't decrypt back: undo
    // only that. Replace puts the old ciphertext back; create removes the file.
    const undone =
      old !== null ? await this.restore(p, old, ciphertext) : await this.removeCreated(p, ciphertext);
    throw new JournalApiError(undone === "ok" ? "verify-failed" : undone);
  }

  /** Put `old` back, only while the file still holds `ours`; check it landed. */
  private async restore(
    p: string,
    old: Uint8Array,
    ours: Uint8Array
  ): Promise<"ok" | "conflict" | "restore-failed"> {
    try {
      if (!bytesEqual(new Uint8Array(await this.deps.vault.read(p)), ours)) return "conflict";
      await this.deps.vault.replace(p, toArrayBuffer(old));
      return bytesEqual(new Uint8Array(await this.deps.vault.read(p)), old) ? "ok" : "restore-failed";
    } catch {
      return "restore-failed";
    }
  }

  /** Remove a just-created file, only while it still holds `ours`; check it is gone. */
  private async removeCreated(p: string, ours: Uint8Array): Promise<"ok" | "conflict" | "restore-failed"> {
    try {
      if (!bytesEqual(new Uint8Array(await this.deps.vault.read(p)), ours)) return "conflict";
      await this.deps.vault.remove(p);
      return (await this.deps.vault.kind(p)) === "none" ? "ok" : "restore-failed";
    } catch {
      return "restore-failed";
    }
  }
}
