/**
 * v0.5.2 / v0.6.6: Pre-rotation backup. Copies every `.age` file in the
 * vault into a fresh timestamped directory at
 * `~/halfday/logs/age-backups/age-backup-{ISO}/` BEFORE rotation touches
 * anything. Auto-toggle in settings (default ON). Mirrors today's
 * pre-seal backup pattern from seal.sh.
 *
 * v0.6.6 change — NO MORE SHELL OUT.
 *   Earlier versions shelled out to `/usr/bin/tar` via child_process to
 *   produce a single `.tar.gz`. The Obsidian community-catalog review
 *   (correctly) flags any `child_process` use as "Shell Execution — full
 *   control over the system", which is a poor signal for a security
 *   plugin. We now do a pure Node `fs` copy: no child_process, no shell,
 *   no archive tool dependency. The backup is a plain directory of file
 *   copies instead of a tarball — functionally identical for recovery
 *   (copy the files back), and gzip barely compresses age ciphertext
 *   anyway, so we lose nothing meaningful.
 *
 * Why out-of-vault?
 *   - keeps iCloud sync from churning on backup copies it doesn't need
 *   - the backup is a recovery artifact, not vault content
 *   - matches `~/halfday/logs/seal.log` placement, so all halfday-CLI/plugin
 *     crash-recovery state lives in one well-known directory
 *
 * Throws if any copy fails. Caller (main.ts rotate command) aborts the
 * whole rotation in that case — no partial backups, no half-rotated
 * vaults with no safety net.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Default backup directory. Override-able via `backupDir` arg. */
export const DEFAULT_BACKUP_DIR = path.join(
  os.homedir(),
  "halfday",
  "logs",
  "age-backups"
);

export interface BackupResult {
  /** Absolute path to the created backup directory (empty string if no-op). */
  path: string;
  /** Number of files copied. */
  count: number;
  /** Total bytes copied (sum of input file sizes). */
  bytes: number;
  /** ISO timestamp embedded in the directory name — handy for log lines. */
  timestamp: string;
}

/**
 * Back up all `.age` files at `relPaths` (relative to `vaultBase`) by
 * copying each into a fresh `age-backup-{ISO}/` directory under
 * `backupDir`, preserving the file's relative subpath. Empty `relPaths`
 * is a no-op that returns a result with `path: ""` so the caller can
 * report "nothing to back up" without branching.
 *
 * The timestamped subdir and any nested parent dirs are created
 * (recursive) before each copy.
 *
 * Fails closed: the first copy error throws, and the caller aborts the
 * rotation. A partial backup directory may be left behind on failure —
 * harmless (it's a recovery artifact in a logs dir), and rotation never
 * proceeds without a complete backup.
 */
export async function backupAgeFiles(
  vaultBase: string,
  relPaths: string[],
  backupDir: string = DEFAULT_BACKUP_DIR
): Promise<BackupResult> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  if (relPaths.length === 0) {
    return { path: "", count: 0, bytes: 0, timestamp };
  }

  const backupRoot = path.join(backupDir, `age-backup-${timestamp}`);
  fs.mkdirSync(backupRoot, { recursive: true });

  let bytes = 0;
  let copied = 0;
  for (const rel of relPaths) {
    // Defense-in-depth: keep every copy strictly inside backupRoot.
    // Vault API paths are always in-vault relative paths, but reject
    // anything absolute (path.join would quietly contain it) or escaping
    // via `..`, rather than silently writing to an unexpected location.
    const dest = path.join(backupRoot, rel);
    if (path.isAbsolute(rel) || path.relative(backupRoot, dest).startsWith("..")) {
      throw new Error(`backup: refusing to write outside backup dir: ${rel}`);
    }

    const src = path.join(vaultBase, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // copyFileSync is a byte-exact copy — correct for ciphertext.
    fs.copyFileSync(src, dest);
    bytes += fs.statSync(dest).size;
    copied++;
  }

  // `copied` is incremented only after a successful copy, so it can never
  // over-report even if a future edit adds per-file error tolerance to the
  // loop. (Today the loop throws on first error, so copied === relPaths.length
  // on the success path.)
  return { path: backupRoot, count: copied, bytes, timestamp };
}
