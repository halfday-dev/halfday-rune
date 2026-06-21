/**
 * Vitest for src/backup.ts.
 *
 * v0.6.6: backup.ts no longer shells out to /usr/bin/tar via child_process.
 * It now copies each .age file into a fresh timestamped directory using
 * Node `fs`. These tests mock fs (mkdirSync / copyFileSync / statSync) so
 * we exercise the copy contract without touching a real disk:
 *   - we create the timestamped backup dir before copying,
 *   - we copy every input file preserving its relative subpath,
 *   - we sum the copied bytes and report a count,
 *   - a copy failure throws (caller aborts the rotation),
 *   - a path that would escape the backup dir is refused.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- mock fs ----
// backup.ts imports `* as fs`, so the mocked module needs the properties
// as direct exports.
const mkdirSyncMock = vi.fn();
const copyFileSyncMock = vi.fn();
const statSyncMock = vi.fn();
vi.mock("fs", () => ({
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  copyFileSync: (...args: unknown[]) => copyFileSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
}));

let backupAgeFiles: typeof import("../src/backup").backupAgeFiles;
let DEFAULT_BACKUP_DIR: string;
beforeEach(async () => {
  vi.resetModules();
  mkdirSyncMock.mockReset();
  copyFileSyncMock.mockReset();
  statSyncMock.mockReset();
  // default: every copied file is 100 bytes
  statSyncMock.mockReturnValue({ size: 100 });
  const mod = await import("../src/backup");
  backupAgeFiles = mod.backupAgeFiles;
  DEFAULT_BACKUP_DIR = mod.DEFAULT_BACKUP_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backupAgeFiles — empty input", () => {
  it("returns { path: '', count: 0, bytes: 0 } without touching fs", async () => {
    const result = await backupAgeFiles("/Users/t/vault", []);
    expect(result.path).toBe("");
    expect(result.count).toBe(0);
    expect(result.bytes).toBe(0);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mkdirSyncMock).not.toHaveBeenCalled();
    expect(copyFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("backupAgeFiles — happy path", () => {
  it("copies each file into a timestamped dir, preserving subpaths", async () => {
    const result = await backupAgeFiles(
      "/Users/t/vault",
      ["a.age", "subdir/b.age"],
      "/tmp/backups"
    );

    // result shape
    expect(result.path).toMatch(/^\/tmp\/backups\/age-backup-.+$/);
    expect(result.path).not.toMatch(/\.tar\.gz$/); // no archive anymore
    expect(result.count).toBe(2);
    expect(result.bytes).toBe(200); // 2 files × 100 bytes

    // two copies, with correct src → dest mapping
    expect(copyFileSyncMock).toHaveBeenCalledTimes(2);
    const root = result.path;
    expect(copyFileSyncMock).toHaveBeenCalledWith(
      "/Users/t/vault/a.age",
      `${root}/a.age`
    );
    expect(copyFileSyncMock).toHaveBeenCalledWith(
      "/Users/t/vault/subdir/b.age",
      `${root}/subdir/b.age`
    );
  });

  it("creates the timestamped backup root before any copy", async () => {
    const result = await backupAgeFiles(
      "/Users/t/vault",
      ["a.age"],
      "/tmp/halfday/age-backups"
    );
    // root dir created recursively
    expect(mkdirSyncMock).toHaveBeenCalledWith(result.path, {
      recursive: true,
    });
    // mkdir(root) must come BEFORE the first copy
    const firstMkdirOrder = mkdirSyncMock.mock.invocationCallOrder[0];
    const firstCopyOrder = copyFileSyncMock.mock.invocationCallOrder[0];
    expect(firstMkdirOrder).toBeLessThan(firstCopyOrder);
  });

  it("creates parent dirs for nested files before copying them", async () => {
    const result = await backupAgeFiles(
      "/Users/t/vault",
      ["subdir/b.age"],
      "/tmp/backups"
    );
    // the nested file's parent dir is created recursively
    expect(mkdirSyncMock).toHaveBeenCalledWith(`${result.path}/subdir`, {
      recursive: true,
    });
  });

  it("backup dir name embeds a filesystem-safe ISO-ish timestamp", async () => {
    const result = await backupAgeFiles(
      "/Users/t/vault",
      ["a.age"],
      "/tmp/backups"
    );
    // ISO with `:` and `.` swapped to `-`
    expect(result.path).toMatch(/age-backup-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
  });

  it("defaults to DEFAULT_BACKUP_DIR when backupDir omitted", async () => {
    const result = await backupAgeFiles("/Users/t/vault", ["a.age"]);
    expect(result.path.startsWith(DEFAULT_BACKUP_DIR)).toBe(true);
  });
});

describe("backupAgeFiles — failure modes", () => {
  it("throws if a copy fails (so the caller aborts rotation)", async () => {
    copyFileSyncMock.mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    await expect(
      backupAgeFiles("/Users/t/vault", ["a.age"], "/tmp/backups")
    ).rejects.toThrow(/ENOSPC/);
  });

  it("throws when a LATER file in the loop fails (no silent partial)", async () => {
    // first copy ok, second copy throws — proves the loop stops dead and
    // does not resolve with a partial-but-successful-looking result.
    copyFileSyncMock
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("EACCES: permission denied");
      });
    await expect(
      backupAgeFiles("/Users/t/vault", ["a.age", "b.age"], "/tmp/backups")
    ).rejects.toThrow(/EACCES/);
    // exactly one copy was attempted-then-succeeded before the throw
    expect(copyFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("refuses a relative-escape path (../) and copies nothing", async () => {
    await expect(
      backupAgeFiles("/Users/t/vault", ["../escape.age"], "/tmp/backups")
    ).rejects.toThrow(/outside backup dir/);
    expect(copyFileSyncMock).not.toHaveBeenCalled();
  });

  it("refuses an absolute path and copies nothing", async () => {
    await expect(
      backupAgeFiles("/Users/t/vault", ["/etc/evil.age"], "/tmp/backups")
    ).rejects.toThrow(/outside backup dir/);
    expect(copyFileSyncMock).not.toHaveBeenCalled();
  });
});
