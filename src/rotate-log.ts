/**
 * v0.5.2: Single-purpose append-only log for rotate-keys runs.
 *
 * QA finding F2/F4: the v0.5.2 rotate command originally promised a
 * "logged reason" for skipped files but only wrote to `console.error`,
 * which a user can't find two hours later when they realize a file
 * went missing. This module mirrors the seal.log pattern from the
 * halfday CLI (`~/halfday/logs/seal.log`) so all halfday crash-recovery
 * state lives in one well-known directory.
 *
 * Format is line-oriented for easy `tail -f` / grep:
 *
 *   ROTATE START {ISO}  files=N recipients=K autoBackup={true|false}
 *   ROTATE BACKUP {ok|fail}  path=... bytes=... err=...
 *   ROTATE FILE {ok|skip}    path=... reason=... bytesBefore=... bytesAfter=...
 *   ROTATE END {ISO}    rotated=N skipped=M
 *
 * Pure dependency-injectable surface so the main.ts caller AND the
 * pure rotate loop can share the same logger without either of them
 * having to know about node fs.
 *
 * Why module-scoped rather than per-rotate? A single appendFileSync
 * per line keeps the log line-atomic at the OS level (small writes
 * to O_APPEND are atomic up to PIPE_BUF on POSIX) — we never want a
 * partial line to appear after a crash mid-rotation.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Default log file. Override-able via the constructor for tests. */
export const DEFAULT_ROTATE_LOG_PATH = path.join(
  os.homedir(),
  "halfday",
  "logs",
  "rotate.log"
);

export interface RotateLogWriter {
  /** Absolute path of the log file (for surfacing in Notice + summary modal). */
  readonly path: string;
  start(meta: { files: number; recipients: number; autoBackup: boolean }): void;
  backup(meta:
    | { ok: true; path: string; bytes: number }
    | { ok: false; err: string }
  ): void;
  file(meta:
    | { ok: true; path: string; bytesBefore: number; bytesAfter: number }
    | { ok: false; path: string; reason: string; err: string }
  ): void;
  end(meta: { rotated: number; skipped: number }): void;
}

/**
 * Build a writer that appends to `logPath`. Creates the parent
 * directory recursively on first use. Failures to write are
 * swallowed-and-console.error'd — a logging crash must not abort
 * the rotation itself (the user's vault is more important than
 * the breadcrumb).
 */
export function makeRotateLogWriter(
  logPath: string = DEFAULT_ROTATE_LOG_PATH
): RotateLogWriter {
  let dirEnsured = false;
  const ensureDir = (): void => {
    if (dirEnsured) return;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      dirEnsured = true;
    } catch (err) {
      console.error("[halfday-rune] rotate-log mkdir failed", err);
    }
  };

  const append = (line: string): void => {
    ensureDir();
    try {
      fs.appendFileSync(logPath, line + "\n", { encoding: "utf8" });
    } catch (err) {
      console.error("[halfday-rune] rotate-log append failed", err);
    }
  };

  const iso = (): string => new Date().toISOString();

  return {
    path: logPath,
    start(meta) {
      append(
        `ROTATE START ${iso()}  files=${meta.files} recipients=${meta.recipients} autoBackup=${meta.autoBackup}`
      );
    },
    backup(meta) {
      if (meta.ok) {
        append(`ROTATE BACKUP ok  path=${meta.path} bytes=${meta.bytes}`);
      } else {
        append(`ROTATE BACKUP fail  err=${oneLine(meta.err)}`);
      }
    },
    file(meta) {
      if (meta.ok) {
        append(
          `ROTATE FILE ok  path=${meta.path} bytesBefore=${meta.bytesBefore} bytesAfter=${meta.bytesAfter}`
        );
      } else {
        append(
          `ROTATE FILE skip  path=${meta.path} reason=${meta.reason} err=${oneLine(meta.err)}`
        );
      }
    },
    end(meta) {
      append(
        `ROTATE END ${iso()}  rotated=${meta.rotated} skipped=${meta.skipped}`
      );
    },
  };
}

/**
 * Replace newlines/CR with a literal "\\n" so a multi-line error
 * message doesn't break the line-oriented format. Cheap, defensive.
 */
function oneLine(s: string): string {
  return s.replace(/\r?\n/g, "\\n");
}
