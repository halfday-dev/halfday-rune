/**
 * v0.5.2: Vault key rotation. Re-encrypts every `.age` file in the vault to
 * the current recipient list so that recipients added AFTER existing files
 * were sealed actually protect those files.
 *
 * Pure rotation logic, dependency-injected so the unit tests can drive it
 * without Obsidian or the filesystem. The shell in main.ts wires the real
 * deps (vault, crypto, fs) and surfaces results via Notice / modal.
 *
 * Per-file pipeline mirrors AgeFileView.save:
 *   readBinary → decryptToString(identity) → encrypt(recipients)
 *   → decryptToString(identity)  // round-trip verify
 *   → modifyBinary(file, ciphertext) on success
 *
 * Single-file failures DO NOT throw — they are pushed onto `skipped` with
 * the captured error and the loop continues. This is the v0.5 plan's
 * "continue-with-log" decision: a 100-file rotate that hits one corrupt
 * ciphertext shouldn't lose the other 99 successes. Caller decides how to
 * surface the summary (Notice for all-success, modal on partial failure).
 *
 * No optimization for "already rotated to this recipient set" — re-encrypting
 * is microseconds per file, and parsing the age header to detect the
 * recipient list isn't worth the complexity at v0.
 */

import type { TFile, Vault } from "obsidian";

/**
 * The minimal Vault surface the rotator uses. Defined as a structural type
 * so the test suite can pass a fake without pulling in obsidian's full
 * Vault class.
 */
export interface RotateVault {
  readBinary(file: TFile): Promise<ArrayBuffer>;
  modifyBinary(file: TFile, data: ArrayBuffer): Promise<void>;
}

/**
 * Crypto deps — same signatures as the helpers exported from src/crypto.ts.
 * Injected so tests can swap in fakes (e.g. a "wrong identity" decrypt that
 * always throws to simulate a file sealed to a recipient we don't hold).
 */
export interface RotateCryptoDeps {
  encrypt(recipients: string[], plaintext: string): Promise<Uint8Array>;
  decryptToString(identity: string, ciphertext: Uint8Array): Promise<string>;
}

export interface RotateLogger {
  log: (msg: string, ctx?: unknown) => void;
  error: (msg: string, ctx?: unknown) => void;
}

/**
 * v0.5.2 (F2/F4): structured per-file logging hook. Distinct from the
 * unstructured RotateLogger above, which mirrors console.log/error.
 * The fileLog hook emits one line per file outcome to the persistent
 * rotate.log so the user has a breadcrumb after the modal closes.
 *
 * Both hooks are optional — tests that don't care about logging just
 * leave them off.
 */
export interface RotateFileLog {
  ok(meta: { path: string; bytesBefore: number; bytesAfter: number }): void;
  skip(meta: { path: string; reason: RotateSkip["reason"]; err: string }): void;
}

export interface RotateDeps {
  vault: RotateVault;
  crypto: RotateCryptoDeps;
  logger?: RotateLogger;
  fileLog?: RotateFileLog;
}

export interface RotateOpts {
  ageFiles: TFile[];
  identity: string;
  recipients: string[];
  /** Optional per-file progress hook (1-indexed `i`). */
  onProgress?: (i: number, total: number, file: TFile) => void;
}

export interface RotateSkip {
  file: TFile;
  /** Stage where the failure happened — useful for the summary modal. */
  reason: "decrypt" | "encrypt" | "round-trip-mismatch" | "write";
  error: string;
}

/**
 * F8 (v0.5.2): per-file byte deltas. Useful as a regression guard —
 * adding a recipient grows the age header by ~50 bytes, so a rotation
 * that adds a recipient must produce bytesAfter > bytesBefore. The
 * summary modal also uses these to spot suspicious shrinkage.
 */
export interface RotatedFile {
  file: TFile;
  bytesBefore: number;
  bytesAfter: number;
}

export interface RotateResult {
  rotated: RotatedFile[];
  skipped: RotateSkip[];
  totalBytes: { before: number; after: number };
}

/**
 * Rotate every `.age` file in `ageFiles` to the current recipient list.
 *
 * Contract:
 *   - never throws on a single-file failure; pushes to `skipped` and continues
 *   - throws only on programmer error (empty recipients, missing identity)
 *   - empty `ageFiles` is a valid no-op — returns empty arrays + zero bytes
 *   - byte counts are ciphertext-only; plaintext byte counts aren't useful
 *     and would leak unnecessarily into logs
 */
export async function rotateVault(
  deps: RotateDeps,
  opts: RotateOpts
): Promise<RotateResult> {
  if (!opts.identity) {
    throw new Error("rotateVault: identity required");
  }
  if (opts.recipients.length === 0) {
    throw new Error("rotateVault: at least one recipient required");
  }

  const log = deps.logger?.log ?? (() => {});
  const logErr = deps.logger?.error ?? (() => {});
  const fileLog = deps.fileLog;

  const rotated: RotatedFile[] = [];
  const skipped: RotateSkip[] = [];
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (let i = 0; i < opts.ageFiles.length; i++) {
    const file = opts.ageFiles[i];
    opts.onProgress?.(i + 1, opts.ageFiles.length, file);

    let ciphertextIn: Uint8Array;
    try {
      const buf = await deps.vault.readBinary(file);
      ciphertextIn = new Uint8Array(buf);
      bytesBefore += ciphertextIn.byteLength;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ file, reason: "decrypt", error: `read: ${msg}` });
      logErr("[rotate] read failed", { path: file.path, msg });
      fileLog?.skip({ path: file.path, reason: "decrypt", err: `read: ${msg}` });
      continue;
    }

    let plaintext: string;
    try {
      plaintext = await deps.crypto.decryptToString(opts.identity, ciphertextIn);
    } catch (err) {
      // most common: file sealed to a recipient our primary identity doesn't
      // match (e.g. a file from before primary was added to recipients.txt).
      // skip + continue is the right behavior — the file is still readable
      // by SOME identity, just not this one, so we shouldn't blow it away.
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ file, reason: "decrypt", error: msg });
      logErr("[rotate] decrypt failed", { path: file.path, msg });
      fileLog?.skip({ path: file.path, reason: "decrypt", err: msg });
      continue;
    }

    let ciphertextOut: Uint8Array;
    try {
      ciphertextOut = await deps.crypto.encrypt(opts.recipients, plaintext);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ file, reason: "encrypt", error: msg });
      logErr("[rotate] encrypt failed", { path: file.path, msg });
      fileLog?.skip({ path: file.path, reason: "encrypt", err: msg });
      continue;
    }

    // round-trip verify before touching the on-disk ciphertext — same
    // safety property as v0.2 / AgeFileView. If we can't decrypt what we
    // just encrypted, leave the existing .age in place.
    try {
      const decoded = await deps.crypto.decryptToString(opts.identity, ciphertextOut);
      if (decoded !== plaintext) {
        // M1: don't put plaintext/decoded LENGTHS in the user-facing
        // `error` string — it ends up in the summary modal, which is
        // screenshot-able. Even a length is a side channel for
        // known-format files. Lengths still go to logErr (console-only).
        const safeMsg = "decoded ciphertext did not match input plaintext";
        skipped.push({
          file,
          reason: "round-trip-mismatch",
          error: safeMsg,
        });
        logErr("[rotate] round-trip mismatch", {
          path: file.path,
          plaintextLen: plaintext.length,
          decodedLen: decoded.length,
        });
        fileLog?.skip({
          path: file.path,
          reason: "round-trip-mismatch",
          err: safeMsg,
        });
        continue;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ file, reason: "round-trip-mismatch", error: msg });
      logErr("[rotate] round-trip verify threw", { path: file.path, msg });
      fileLog?.skip({ path: file.path, reason: "round-trip-mismatch", err: msg });
      continue;
    }

    try {
      const buffer = ciphertextOut.buffer.slice(
        ciphertextOut.byteOffset,
        ciphertextOut.byteOffset + ciphertextOut.byteLength
      ) as ArrayBuffer;
      await deps.vault.modifyBinary(file, buffer);
      const inLen = ciphertextIn.byteLength;
      const outLen = ciphertextOut.byteLength;
      rotated.push({ file, bytesBefore: inLen, bytesAfter: outLen });
      bytesAfter += outLen;
      log("[rotate] rotated", {
        path: file.path,
        before: inLen,
        after: outLen,
      });
      fileLog?.ok({ path: file.path, bytesBefore: inLen, bytesAfter: outLen });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ file, reason: "write", error: msg });
      logErr("[rotate] write failed", { path: file.path, msg });
      fileLog?.skip({ path: file.path, reason: "write", err: msg });
      continue;
    }
  }

  return { rotated, skipped, totalBytes: { before: bytesBefore, after: bytesAfter } };
}

/**
 * Diff two recipients arrays and return the lines added/removed in `next`
 * vs `prev`. Used by the on-save Notice in the settings tab — when the
 * user changes recipients via the textarea, we want to surface BOTH
 * directions: an addition means existing .age files don't include the
 * new pubkey yet; a removal means existing .age files still encode the
 * old pubkey in their headers (security-relevant when rotating away
 * from a leaked recipient).
 *
 * Order is preserved from `next` (for `added`) and `prev` (for `removed`).
 *
 * Pure / deterministic / no I/O — safe to unit-test alongside the rest of
 * crypto.ts but lives here because it's rotation-adjacent UX glue, not
 * crypto.
 *
 * CONTRACT: inputs MUST be the output of `parseRecipientsFile` (already
 * trimmed/deduped/comment-stripped). Do NOT call this with raw textarea
 * lines — comments and blank lines will read as "removed" when the file
 * is re-validated through parseRecipientsFile, producing noisy false
 * positives in the Notice.
 */
export function recipientsChanged(
  prev: string[],
  next: string[]
): { added: string[]; removed: string[] } {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  return {
    added: next.filter((r) => !prevSet.has(r)),
    removed: prev.filter((r) => !nextSet.has(r)),
  };
}
