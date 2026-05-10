/**
 * v0.5.2: Pre-rotation backup. Tars + gzips every `.age` file in the vault
 * to `~/halfday/logs/age-backups/age-backup-{ISO}.tar.gz` BEFORE rotation
 * touches anything. Auto-toggle in settings (default ON). Mirrors today's
 * pre-seal backup pattern from seal.sh.
 *
 * Why out-of-vault?
 *   - keeps iCloud sync from churning on a tarball it doesn't need
 *   - the backup is a recovery artifact, not vault content
 *   - matches `~/halfday/logs/seal.log` placement, so all halfday-CLI/plugin
 *     crash-recovery state lives in one well-known directory
 *
 * Why shell-out to `tar`?
 *   - Electron has node child_process; no new npm dep
 *   - tar handles symlinks, permissions, and large file lists faster than
 *     any pure-JS implementation we'd ship
 *   - `-C vaultBase` lets the archive store relative paths so a restore
 *     extracts cleanly into any vault root
 *
 * Throws on non-zero tar exit. Caller (main.ts rotate command) aborts the
 * whole rotation in that case — no partial backups, no half-rotated vaults
 * with no safety net.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";

/** Default backup directory. Override-able via `backupDir` arg. */
export const DEFAULT_BACKUP_DIR = path.join(
  os.homedir(),
  "halfday",
  "logs",
  "age-backups"
);

export interface BackupResult {
  /** Absolute path to the created tar.gz. */
  path: string;
  /** Size of the tar.gz in bytes (post-gzip, not sum-of-inputs). */
  bytes: number;
  /** ISO timestamp embedded in the filename — handy for log lines. */
  timestamp: string;
}

/**
 * Backup all `.age` files at `relPaths` (relative to `vaultBase`) into a
 * single tar.gz. Empty `relPaths` is a no-op that returns a result with
 * `path: ""` so the caller can report "nothing to back up" without
 * branching on whether tar was invoked.
 *
 * `backupDir` is created (recursive) before tar runs.
 */
export async function backupAgeFiles(
  vaultBase: string,
  relPaths: string[],
  backupDir: string = DEFAULT_BACKUP_DIR
): Promise<BackupResult> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (relPaths.length === 0) {
    return { path: "", bytes: 0, timestamp };
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const archivePath = path.join(backupDir, `age-backup-${timestamp}.tar.gz`);

  // -C runs tar relative to vaultBase so the archive stores paths as
  // `subdir/file.age` rather than absolute paths. Easier to reason about
  // on restore. Use --no-mac-metadata to skip ._foo AppleDouble files
  // that iCloud occasionally leaves around — they're not vault content
  // and bloat the archive. (BSD tar on macOS supports the flag; GNU tar
  // on Linux ignores unknown flags after a warning, but we're targeting
  // macOS via Electron.)
  //
  // L2: `--` separator before the file list prevents any future filename
  // starting with `-` from being parsed as a flag. (Obsidian itself
  // doesn't allow leading-`-` filenames, but defense-in-depth — if a
  // weird vault import ever sneaks one in, tar must treat it as a path.)
  const args = ["-czf", archivePath, "-C", vaultBase, "--", ...relPaths];
  await runTar(args);

  const stat = fs.statSync(archivePath);
  return { path: archivePath, bytes: stat.size, timestamp };
}

/**
 * L2: pin the tar binary to `/usr/bin/tar` instead of resolving via PATH.
 * Eliminates a hijack vector if a user-writable directory (e.g. /usr/local/bin
 * or a Homebrew prefix on Apple Silicon) ever appears earlier in PATH and
 * shadows system tar. macOS guarantees /usr/bin/tar is BSD tar; that's the
 * version we tested -czf + -C against.
 */
const TAR_BIN = "/usr/bin/tar";

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(TAR_BIN, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "unknown";
        reject(
          new Error(
            `tar failed (code=${code}): ${stderr?.toString().trim() || err.message}`
          )
        );
        return;
      }
      resolve();
    });
  });
}
