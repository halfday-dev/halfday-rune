/**
 * Node-only key/recipients file helpers for Halfday Obsidian Rune
 * (desktop). Split out of crypto.ts so the pure age functions there carry
 * no top-level `fs` / `os` / `path` import and the plugin can load on iOS,
 * where those modules do not exist.
 *
 * Load this ONLY via `await import("./crypto-node")` behind
 * `Platform.isDesktopApp` (see node-loader.ts). Behaviour is unchanged
 * from when these lived in crypto.ts.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseRecipientsFile } from "./crypto";

/** Expand a leading `~/` or `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
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
 * v0.5.1: Read recipients.txt as raw bytes (preserving comments, blank
 * lines, and ordering verbatim). Used by the settings-tab textarea so the
 * user can edit the file in-place without losing formatting.
 *
 * Returns `{ content: "", exists: false }` if the file is missing, so the
 * settings UI can show an empty textarea and treat first-save as a
 * create-the-file action. Throws on other read errors (permissions, IO).
 */
export function readRecipientsRaw(
  filePath: string
): { content: string; exists: boolean } {
  const expanded = expandHome(filePath);
  try {
    const content = fs.readFileSync(expanded, "utf8");
    return { content, exists: true };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { content: "", exists: false };
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`recipients.txt not readable at ${filePath}: ${msg}`);
  }
}

/**
 * v0.5.1 / v0.6.3: Write recipients.txt content verbatim. Truncate+write
 * (no atomic rename — same iCloud-safe pattern as
 * `_scripts/migrate_privacy_tier.py`). Creates the file if missing.
 *
 * v0.6.3: on FIRST write (file did not exist before), the file is
 * created with mode 0600 to match the permissions of
 * `~/.age/vault.identity`. The recipient list is public-key material
 * — 0644 isn't a leak — but consistency with the rest of `~/.age/` is
 * the principle. On subsequent writes we leave existing permissions
 * alone, so a user who explicitly chmod-ed the file later (e.g. to
 * share-read with another local account) isn't silently fought.
 *
 * Implementation notes:
 *   - We check existence via `fs.statSync` rather than relying on
 *     `wx` open mode + retry, because we WANT to create-or-truncate;
 *     the "first write" detection has to be informational, not
 *     load-bearing for correctness.
 *   - On create we use `openSync(path, "w", 0o600)` + `writeSync` +
 *     `closeSync` rather than `writeFileSync` with `{mode: 0o600}`
 *     because the latter applies the mode only on creation but the
 *     two-arg `writeFileSync(path, content, "utf8")` overload doesn't
 *     accept a `mode` field in a way that's portable across Node
 *     versions. The lower-level path is unambiguous.
 *
 * Caller is responsible for validating content with
 * `validateRecipientsContent()` BEFORE calling this — this helper
 * trusts its input and writes whatever bytes it's given. Keeps each
 * helper single-purpose.
 *
 * Does NOT create parent directories. `~/.age/` is expected to exist
 * already (it's a v1 CLI prerequisite).
 */
export function writeRecipientsRaw(filePath: string, content: string): void {
  const expanded = expandHome(filePath);

  let existedBefore = false;
  try {
    fs.statSync(expanded);
    existedBefore = true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") throw err;
  }

  if (existedBefore) {
    // Preserve existing permissions (don't fight a user who explicitly
    // set them later).
    fs.writeFileSync(expanded, content, "utf8");
    return;
  }

  // First write — create with 0600.
  const fd = fs.openSync(expanded, "w", 0o600);
  try {
    fs.writeSync(fd, content, 0, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * v0.6.3: Best-effort stat of recipients.txt to capture its mtime.
 * Returns `null` if the file doesn't exist (mirrors `readRecipientsRaw`'s
 * `exists: false` shape — first-save semantics). Throws on other I/O
 * errors so the caller can surface them; the settings tab catches and
 * shows an inline error.
 *
 * Used by the modified-on-disk detector: the settings tab captures
 * mtime on textarea-populate, then compares against a fresh stat on
 * Save. If the mtime advanced, the file was edited externally and we
 * refuse the write until the user reloads.
 */
export function statRecipientsMtime(filePath: string): number | null {
  const expanded = expandHome(filePath);
  try {
    const st = fs.statSync(expanded);
    return st.mtimeMs;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
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
