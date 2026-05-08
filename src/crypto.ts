/**
 * Pure crypto + key-loading helpers for Halfday Obsidian Rune.
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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Encrypter, Decrypter } from "age-encryption";

/** Expand a leading `~/` or `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

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
 * v0.5.0: Read a recipients.txt file from disk and return the list of
 * age1... pubkeys it contains. Throws on missing file or any parser error.
 */
export function readRecipients(filePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(expandHome(filePath), "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`recipients.txt not readable at ${filePath}: ${msg}`);
  }
  return parseRecipientsFile(content);
}

/**
 * Read an age identity (secret key) from a file.
 * Returns the first line that looks like `AGE-SECRET-KEY-1...`.
 * Throws on none-found.
 *
 * Works with raw `age-keygen -o FILE` output, which has comment lines plus
 * the secret key on its own line.
 */
export function readIdentity(filePath: string): string {
  const content = fs.readFileSync(expandHome(filePath), "utf8");
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("AGE-SECRET-KEY-1"));
  if (!line) {
    throw new Error(`no AGE-SECRET-KEY-1... identity found in ${filePath}`);
  }
  return line;
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
