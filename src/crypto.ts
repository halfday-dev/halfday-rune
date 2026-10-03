/**
 * Pure crypto helpers for Halfday Obsidian Rune.
 *
 * No Node imports here: the file-reading helpers (readIdentity,
 * readRecipients, ...) live in crypto-node.ts so this module loads on iOS.
 *
 * Split from main.ts so these functions can be unit-tested without Obsidian.
 * All functions are synchronous or async-but-free-of-Obsidian — the plugin
 * shell in main.ts is responsible for surfacing errors via Notice.
 *
 * v0.5.0: multi-recipient. The recipient input is now `~/.age/recipients.txt`
 * (one age1... pubkey per line, `#` lines = comments). Encrypt accepts a
 * non-empty array of recipients; the resulting age ciphertext is decryptable
 * by any of the matching identities. Single-recipient case (length-1 array)
 * is byte-compatible with v0.4.
 */

import { Encrypter, Decrypter, identityToRecipient } from "age-encryption";

/**
 * v0.5.0: Parse a recipients.txt file into a list of age1... recipient
 * strings.
 *
 * Format:
 *   - one recipient per line, lines starting with `age1...`
 *   - `#` lines are comments (typically a preceding-line label, e.g.
 *     `# main mac\nage1...`); ignored
 *   - blank lines ignored
 *   - duplicates silently deduped (preserving first-occurrence order)
 *
 * Throws (with a clear message naming the offending line) on:
 *   - empty file / file with no valid recipients
 *   - any non-comment, non-blank line that doesn't look like an age1 recipient
 *   - line exceeding 200 chars (defensive cap; real age1 keys are 62 chars)
 *
 * The fail-loud contract is the v0.5 plan's "no implicit fallback" decision.
 * Caller must catch and surface via Notice.
 */
export function parseRecipientsFile(content: string): string[] {
  const MAX_LINE = 200;
  const lines = content.split("\n");
  const seen = new Set<string>();
  const recipients: string[] = [];

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) return;             // blank
    if (line.startsWith("#")) return; // comment

    if (line.length > MAX_LINE) {
      throw new Error(
        `recipients.txt line ${idx + 1}: line too long (${line.length} chars; max ${MAX_LINE})`
      );
    }
    if (!line.startsWith("age1")) {
      throw new Error(
        `recipients.txt line ${idx + 1}: expected age1... recipient, got ${truncate(line, 40)}`
      );
    }
    // age1 keys are 62 chars total (4 prefix + 58 bech32). Be lenient on length
    // for forward compat with future age recipient encodings (age-plugin-yubikey
    // emits longer recipients, for instance).
    if (line.length < 32) {
      throw new Error(
        `recipients.txt line ${idx + 1}: recipient looks too short (${line.length} chars; expected ≥ 32)`
      );
    }
    if (seen.has(line)) return;     // dedup silently
    seen.add(line);
    recipients.push(line);
  });

  if (recipients.length === 0) {
    throw new Error(
      "recipients.txt has no valid age1 recipients (file empty or only comments)"
    );
  }
  return recipients;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/**
 * v0.5.1: Validate recipients.txt content (raw string from the settings
 * textarea). Returns `{ ok: true }` if every non-comment, non-blank line
 * is a valid age1... recipient and at least one recipient is present;
 * `{ ok: false, error }` otherwise — error message names the offending
 * line so it can render inline below the textarea.
 *
 * Wraps `parseRecipientsFile()` so the validation rules stay in one place
 * (DRY across "load → use" path and "save UI → write" path).
 */
export function validateRecipientsContent(
  content: string
): { ok: true } | { ok: false; error: string } {
  try {
    parseRecipientsFile(content);
    return { ok: true };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  }
}

/**
 * v0.5.0: Encrypt a UTF-8 string to one or more X25519 recipients.
 * Returns the age ciphertext as a Uint8Array.
 *
 * The resulting ciphertext can be decrypted by any of the matching
 * identities. Single-recipient case (length-1 array) is byte-compatible
 * with v0.4's single-recipient encrypt.
 *
 * Throws if recipients is empty (caller responsibility — readRecipients
 * already guarantees non-empty, but defensive here).
 */
export async function encrypt(
  recipients: string[],
  plaintext: string
): Promise<Uint8Array> {
  if (recipients.length === 0) {
    throw new Error("encrypt: at least one recipient required");
  }
  const enc = new Encrypter();
  for (const r of recipients) {
    enc.addRecipient(r);
  }
  return enc.encrypt(plaintext);
}

/**
 * Decrypt an age ciphertext (Uint8Array) to its UTF-8 string plaintext.
 *
 * Uses typage's "text" output mode, which is equivalent to
 * `TextDecoder.decode(bytes)` over the decrypted bytes.
 *
 * Unchanged in v0.5.0: age decrypts natively against any matching identity
 * regardless of how many recipients are in the ciphertext header.
 */
export async function decryptToString(
  identity: string,
  ciphertext: Uint8Array
): Promise<string> {
  const dec = new Decrypter();
  dec.addIdentity(identity);
  return dec.decrypt(ciphertext, "text");
}

/**
 * v0.5.0: Encrypt to recipients[], then decrypt back with one identity.
 * Used by the v0.1 "test round-trip" command.
 *
 * Zero filesystem writes — the ciphertext lives in a Uint8Array in memory
 * and is dropped when this function returns.
 */
export async function roundTrip(
  recipients: string[],
  identity: string,
  plaintext: string
): Promise<string> {
  const ciphertext = await encrypt(recipients, plaintext);
  return decryptToString(identity, ciphertext);
}

// ---------------------------------------------------------------------------
// Passphrase-wrapped identity (mobile unlock copy)
// ---------------------------------------------------------------------------

/** scrypt work factor (log2 N) used when none is given. */
export const DEFAULT_WRAP_LOGN = 18;
/**
 * Accepted work-factor range, enforced on both wrap and unwrap. Capped at 19
 * so a synced file can never make the phone run a ~1 GiB scrypt (typage
 * itself would allow up to 20); a file we write is always one we can open.
 */
export const MIN_WRAP_LOGN = 16;
export const MAX_WRAP_LOGN = 19;

/** The passphrase did not open the wrapped identity. Fixed message, no detail. */
export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase");
    this.name = "WrongPassphraseError";
  }
}

/** The wrapped file is not a readable passphrase-wrapped identity. Fixed message. */
export class InvalidWrappedIdentityError extends Error {
  constructor() {
    super("The unlock file is not a valid wrapped identity");
    this.name = "InvalidWrappedIdentityError";
  }
}

const IDENTITY_RE = /^AGE-SECRET-KEY-1[A-Z0-9]+$/;

/**
 * True when `s` is a well-formed X25519 age identity: right shape AND it
 * actually derives a recipient (so the bech32 checksum holds).
 */
async function isWellFormedIdentity(s: string): Promise<boolean> {
  if (!IDENTITY_RE.test(s)) return false;
  try {
    await identityToRecipient(s);
    return true;
  } catch {
    return false;
  }
}

const RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{58}$/;
export const MOBILE_KEY_HEADER = "rune-mobile-key v1";
const MAX_MOBILE_RECIPIENTS = 64;

/** True when `s` is a well-formed X25519 age recipient (checksum included). */
function isWellFormedRecipient(s: string): boolean {
  if (!RECIPIENT_RE.test(s)) return false;
  try {
    new Encrypter().addRecipient(s);
    return true;
  } catch {
    return false;
  }
}

export interface MobileKey {
  identity: string;
  /** Deduped; always includes the identity's own recipient. */
  recipients: string[];
}

/**
 * Normalise the identity plus the recipients desktop encrypts to: validate
 * every recipient, dedupe, and add the identity's own recipient if absent
 * (`addedOwn` says so). Throws on anything malformed.
 */
export async function buildMobileKey(
  identity: string,
  recipients: readonly string[]
): Promise<MobileKey & { addedOwn: boolean }> {
  const id = identity.trim();
  if (!(await isWellFormedIdentity(id))) {
    throw new Error("not a well-formed AGE-SECRET-KEY-1 identity");
  }
  const list: string[] = [];
  for (const r of recipients) {
    const t = r.trim();
    if (!isWellFormedRecipient(t)) throw new Error("malformed recipient");
    if (!list.includes(t)) list.push(t);
  }
  const own = await identityToRecipient(id);
  const addedOwn = !list.includes(own);
  if (addedOwn) list.push(own);
  if (list.length > MAX_MOBILE_RECIPIENTS) throw new Error("too many recipients");
  return { identity: id, recipients: list, addedOwn };
}

/**
 * Wrap the mobile key payload under a passphrase (age scrypt stanza). The
 * output is a standard age file: `age -d` opens it. The plaintext is
 *
 *   rune-mobile-key v1\n
 *   identity: AGE-SECRET-KEY-1...\n
 *   recipient: age1...\n        (one line per recipient, at least one)
 *
 * The recipients ride inside the passphrase-protected payload so nobody can
 * add a key to the phone's encrypt list without the passphrase. Pure; never
 * logs or echoes either input.
 */
export async function wrapMobileKey(
  identity: string,
  recipients: readonly string[],
  passphrase: string,
  logN: number = DEFAULT_WRAP_LOGN
): Promise<Uint8Array> {
  if (!Number.isInteger(logN) || logN < MIN_WRAP_LOGN || logN > MAX_WRAP_LOGN) {
    throw new RangeError(
      `scrypt work factor must be an integer from ${MIN_WRAP_LOGN} to ${MAX_WRAP_LOGN}`
    );
  }
  if (!passphrase) throw new Error("a passphrase is required");
  const key = await buildMobileKey(identity, recipients);
  const enc = new Encrypter();
  enc.setPassphrase(passphrase);
  enc.setScryptWorkFactor(logN);
  const body =
    `${MOBILE_KEY_HEADER}\nidentity: ${key.identity}\n` +
    key.recipients.map((r) => `recipient: ${r}\n`).join("");
  return enc.encrypt(body);
}

export interface AgeStanza {
  type: string;
  args: string[];
}

/**
 * Parse the recipient stanzas out of a binary age file's header, without
 * decrypting anything. Throws on anything that is not a v1 age header.
 */
export function parseAgeHeader(bytes: Uint8Array): AgeStanza[] {
  const MAX_HEADER = 64 * 1024;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, MAX_HEADER));
  const lines = head.split("\n");
  if (lines[0] !== "age-encryption.org/v1") throw new Error("not an age file");
  const stanzas: AgeStanza[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("---")) return stanzas;
    if (line.startsWith("-> ")) {
      const [type, ...args] = line.slice(3).split(" ");
      stanzas.push({ type, args });
    }
  }
  throw new Error("age header not terminated");
}

/** True when the file's header is exactly one scrypt (passphrase) stanza. */
export function isScryptWrapped(bytes: Uint8Array): boolean {
  try {
    const st = parseAgeHeader(bytes);
    return st.length === 1 && st[0].type === "scrypt";
  } catch {
    return false;
  }
}

/**
 * Mobile writes only ever encrypt to the unlocked identity's own recipient.
 * Before overwriting a note, check its existing header is exactly one X25519
 * stanza that the identity opens; anything else (extra recipients, other key
 * types, a different key) would be silently dropped by the re-encrypt.
 */
export async function isEncryptedOnlyToIdentity(
  identity: string,
  existing: Uint8Array
): Promise<boolean> {
  try {
    const st = parseAgeHeader(existing);
    if (st.length !== 1 || st[0].type !== "X25519") return false;
    const dec = new Decrypter();
    dec.addIdentity(identity);
    await dec.decrypt(existing, "text");
    return true;
  } catch {
    return false;
  }
}

/**
 * Check a note on disk before the phone re-encrypts it. `ok` requires that
 * the unlocked identity opens the note's current header. `stanzas` is the
 * number of X25519 recipient stanzas; the caller compares it with the size
 * of the wrapped recipient list (more stanzas = a key the phone does not
 * know about, so re-encrypting would silently drop it).
 */
export async function inspectNoteForMobileSave(
  identity: string,
  existing: Uint8Array
): Promise<{ ok: boolean; x25519Stanzas: number; otherStanzas: number }> {
  try {
    const st = parseAgeHeader(existing);
    const x25519Stanzas = st.filter((s) => s.type === "X25519").length;
    const otherStanzas = st.length - x25519Stanzas;
    const dec = new Decrypter();
    dec.addIdentity(identity);
    await dec.decrypt(existing, "text");
    return { ok: true, x25519Stanzas, otherStanzas };
  } catch {
    return { ok: false, x25519Stanzas: 0, otherStanzas: 0 };
  }
}

export const LEGACY_WRAPPED_MESSAGE =
  "This unlock file is from an older rune version. Re-run 'Create mobile unlock copy' on desktop.";

/** The file is the old bare-identity format; fixed message, re-create it. */
export class LegacyWrappedIdentityError extends InvalidWrappedIdentityError {
  constructor() {
    super();
    this.message = LEGACY_WRAPPED_MESSAGE;
    this.name = "LegacyWrappedIdentityError";
  }
}

/**
 * Open a wrapped mobile key. Throws WrongPassphraseError for a wrong
 * passphrase and InvalidWrappedIdentityError for anything else (not an age
 * file, damaged, unknown version, malformed payload). Messages are fixed.
 */
export async function unwrapMobileKey(
  wrapped: Uint8Array,
  passphrase: string
): Promise<MobileKey> {
  // Refuse hostile work factors BEFORE any scrypt runs: a synced file must
  // not be able to make the phone allocate ~1 GiB.
  try {
    const st = parseAgeHeader(wrapped);
    if (st.length !== 1 || st[0].type !== "scrypt") throw new Error("shape");
    const raw = st[0].args[1];
    if (st[0].args.length !== 2 || !/^\d{1,3}$/.test(raw ?? "")) throw new Error("logN");
    const n = Number(raw);
    if (n < MIN_WRAP_LOGN || n > MAX_WRAP_LOGN) throw new Error("logN range");
  } catch {
    throw new InvalidWrappedIdentityError();
  }
  let text: string;
  try {
    const dec = new Decrypter();
    dec.addPassphrase(passphrase);
    text = await dec.decrypt(wrapped, "text");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no identity matched")) throw new WrongPassphraseError();
    throw new InvalidWrappedIdentityError();
  }
  if (await isWellFormedIdentity(text.trim())) throw new LegacyWrappedIdentityError();
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 3 || lines.length > 2 + MAX_MOBILE_RECIPIENTS) {
    throw new InvalidWrappedIdentityError();
  }
  if (lines[0] !== MOBILE_KEY_HEADER || !lines[1].startsWith("identity: ")) {
    throw new InvalidWrappedIdentityError();
  }
  const identity = lines[1].slice("identity: ".length);
  if (!(await isWellFormedIdentity(identity))) throw new InvalidWrappedIdentityError();
  const recipients: string[] = [];
  for (const line of lines.slice(2)) {
    if (!line.startsWith("recipient: ")) throw new InvalidWrappedIdentityError();
    const r = line.slice("recipient: ".length);
    if (!isWellFormedRecipient(r) || recipients.includes(r)) {
      throw new InvalidWrappedIdentityError();
    }
    recipients.push(r);
  }
  if (!recipients.includes(await identityToRecipient(identity))) {
    throw new InvalidWrappedIdentityError();
  }
  return { identity, recipients };
}
