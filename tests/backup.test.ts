/**
 * Vitest for src/backup.ts. Mocks node child_process + fs so we don't
 * shell out to a real /usr/bin/tar in CI — backup.ts is the most
 * "side-effect-y" module in the plugin and the QA review (F3) flagged
 * that it had zero coverage.
 *
 * What we DON'T test here: the actual tar invocation. /usr/bin/tar
 * behavior is the OS's contract; our contract is "we call execFile
 * with the right args, in the right order, and we propagate non-zero
 * exit as a thrown Error." Covering both with one mocked execFile is
 * tighter than a real-tar end-to-end test would be.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- mocks for child_process + fs ----
//
// We mock at module-resolution time so backup.ts picks up our spies
// when it imports execFile / fs.* . Each mock keeps a thin call
// record + lets each test override behavior.

const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const mkdirSyncMock = vi.fn();
const statSyncMock = vi.fn();
vi.mock("fs", () => ({
  // backup.ts imports `* as fs`, so the mocked module needs the
  // properties as direct exports.
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
}));

// Import AFTER vi.mock so the mocked modules are wired up. dynamic
// import keeps test isolation simple.
let backupAgeFiles: typeof import("../src/backup").backupAgeFiles;
let DEFAULT_BACKUP_DIR: string;
beforeEach(async () => {
  vi.resetModules();
  execFileMock.mockReset();
  mkdirSyncMock.mockReset();
  statSyncMock.mockReset();
  // default: tar exits 0, archive is 1234 bytes
  execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
    cb(null, "", "");
  });
  statSyncMock.mockReturnValue({ size: 1234 });
  const mod = await import("../src/backup");
  backupAgeFiles = mod.backupAgeFiles;
  DEFAULT_BACKUP_DIR = mod.DEFAULT_BACKUP_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backupAgeFiles — empty input", () => {
  it("returns { path: '', bytes: 0 } without invoking execFile", async () => {
    const result = await backupAgeFiles("/Users/t/vault", []);
    expect(result.path).toBe("");
    expect(result.bytes).toBe(0);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(mkdirSyncMock).not.toHaveBeenCalled();
  });
});

describe("backupAgeFiles — happy path", () => {
  it("calls execFile with pinned /usr/bin/tar + correct args + -- separator", async () => {
    const result = await backupAgeFiles(
      "/Users/t/vault",
      ["a.age", "subdir/b.age"],
      "/tmp/backups"
    );

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [bin, args] = execFileMock.mock.calls[0];

    // L2: pinned binary (NOT just "tar")
    expect(bin).toBe("/usr/bin/tar");

    // arg order: -czf <archive> -C <vaultBase> -- <relPaths...>
    expect(args[0]).toBe("-czf");
    expect(args[1]).toMatch(/^\/tmp\/backups\/age-backup-.+\.tar\.gz$/);
    expect(args[2]).toBe("-C");
    expect(args[3]).toBe("/Users/t/vault");
    expect(args[4]).toBe("--");
    expect(args.slice(5)).toEqual(["a.age", "subdir/b.age"]);

    // result reflects the stat'd archive
    expect(result.path).toBe(args[1]);
    expect(result.bytes).toBe(1234);
  });

  it("creates the backup dir recursively before tar runs", async () => {
    await backupAgeFiles(
      "/Users/t/vault",
      ["a.age"],
      "/tmp/halfday/age-backups"
    );
    expect(mkdirSyncMock).toHaveBeenCalledTimes(1);
    expect(mkdirSyncMock).toHaveBeenCalledWith("/tmp/halfday/age-backups", {
      recursive: true,
    });
    // mkdir must come BEFORE execFile — order matters because tar
    // would fail to write into a missing dir.
    const mkdirOrder = mkdirSyncMock.mock.invocationCallOrder[0];
    const execOrder = execFileMock.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(execOrder);
  });

  it("archive filename embeds an ISO-ish timestamp", async () => {
    const result = await backupAgeFiles(
      "/Users/t/vault",
      ["a.age"],
      "/tmp/backups"
    );
    // ISO with `:` and `.` swapped to `-` (filesystem-safe)
    expect(result.path).toMatch(
      /age-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.tar\.gz$/
    );
    // result.timestamp matches the in-filename token
    const filenameTs = result.path.match(/age-backup-(.+)\.tar\.gz$/)?.[1];
    expect(filenameTs).toBe(result.timestamp);
  });

  it("defaults backupDir to ~/halfday/logs/age-backups when omitted", async () => {
    await backupAgeFiles("/Users/t/vault", ["a.age"]);
    const archivePath = execFileMock.mock.calls[0][1][1];
    expect(archivePath.startsWith(DEFAULT_BACKUP_DIR + "/")).toBe(true);
  });
});

describe("backupAgeFiles — failure path", () => {
  it("throws with stderr in the message when tar exits non-zero", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      const err = new Error("Command failed: tar") as NodeJS.ErrnoException;
      err.code = "1";
      cb(err, "", "tar: a.age: Cannot stat: No such file or directory");
    });
    await expect(
      backupAgeFiles("/Users/t/vault", ["a.age"], "/tmp/backups")
    ).rejects.toThrow(/tar failed/);
    await expect(
      backupAgeFiles("/Users/t/vault", ["a.age"], "/tmp/backups")
    ).rejects.toThrow(/Cannot stat/);
  });

  it("falls back to err.message when stderr is empty", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      const err = new Error("ENOENT: tar binary missing") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      cb(err, "", "");
    });
    await expect(
      backupAgeFiles("/Users/t/vault", ["a.age"], "/tmp/backups")
    ).rejects.toThrow(/ENOENT: tar binary missing/);
  });
});
