/**
 * Pure crypto + key-loading helpers for Halfday Obsidian Rune.
 *
 * Split from main.ts so these functions can be unit-tested without Obsidian.
 * All functions are synchronous or async-but-free-of-Obsidian — the plugin
 * shell in main.ts is responsible for surfacing errors via Notice.
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
 * Read an age recipient (public key) from a file.
 * Returns the first line that looks like `age1...`. Throws on none-found.
 *
 * Accepts files with leading comments (lines starting with `#`) so it works
 * with raw `age-keygen` output (which is an identity file but also has a
 * `# public key: age1...` line — we don't read that form here; the recipient
 * should be in its own file, extracted via `grep '^# public key:'`).
 */
export function readRecipient(filePath: string): string {
  const content = fs.readFileSync(expandHome(filePath), "utf8");
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("age1"));
  if (!line) {
    throw new Error(`no age1... recipient found in ${filePath}`);
  }
  return line;
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
 * Encrypt a UTF-8 string to a single X25519 recipient.
 * Returns the age ciphertext as a Uint8Array.
 *
 * Used by the v0.2 "encrypt current note" command: the bytes can be written
 * to disk as a `.age` file, or passed back through decryptToString() to
 * verify round-trip before deletion of the original plaintext.
 */
export async function encrypt(
  recipient: string,
  plaintext: string
): Promise<Uint8Array> {
  const enc = new Encrypter();
  enc.addRecipient(recipient);
  return enc.encrypt(plaintext);
}

/**
 * Decrypt an age ciphertext (Uint8Array) to its UTF-8 string plaintext.
 *
 * Uses typage's "text" output mode, which is equivalent to
 * `TextDecoder.decode(bytes)` over the decrypted bytes.
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
 * Encrypt a UTF-8 string to a single X25519 recipient, then decrypt it back
 * with the matching identity. Returns the decrypted plaintext.
 *
 * Zero filesystem writes — the ciphertext lives in a Uint8Array in memory
 * and is dropped when this function returns. Kept for the v0.1 "test
 * round-trip" command; v0.2 uses encrypt() + decryptToString() separately.
 */
export async function roundTrip(
  recipient: string,
  identity: string,
  plaintext: string
): Promise<string> {
  const ciphertext = await encrypt(recipient, plaintext);
  return decryptToString(identity, ciphertext);
}
