/**
 * Load-path guard: on iOS the Node built-ins (fs/os/path) and the modules
 * that import them don't exist. This imports main.ts with every one of
 * them mocked to THROW ON IMPORT and Platform.isDesktopApp = false, proving
 * nothing in the plugin's load path pulls them in.
 */

import { describe, it, expect, vi } from "vitest";

const boom = vi.hoisted(() => (name: string) => () => {
  throw new Error(`${name} imported at load time`);
});

vi.mock("fs", boom("fs"));
vi.mock("node:fs", boom("node:fs"));
vi.mock("os", boom("os"));
vi.mock("node:os", boom("node:os"));
vi.mock("path", boom("path"));
vi.mock("node:path", boom("node:path"));
vi.mock("../src/crypto-node", boom("crypto-node"));
vi.mock("../src/backup", boom("backup"));
vi.mock("../src/rotate-log", boom("rotate-log"));

vi.mock("obsidian", () => {
  class Stub {}
  return {
    Platform: { isDesktopApp: false, isMobile: true, isIosApp: true },
    App: Stub,
    Modal: Stub,
    Notice: Stub,
    Plugin: Stub,
    PluginSettingTab: Stub,
    Setting: Stub,
    TFile: Stub,
    FileView: Stub,
    Scope: Stub,
    WorkspaceLeaf: Stub,
  };
});

describe("plugin load path (Platform.isDesktopApp = false)", () => {
  it("imports main.ts without touching fs/os/path or the Node-only modules", async () => {
    const mod = await import("../src/main");
    expect(typeof mod.default).toBe("function");
  });

  it("the lazy loaders refuse off-desktop instead of importing", async () => {
    const { loadCryptoNode, loadBackup, loadRotateLog } = await import(
      "../src/node-loader"
    );
    await expect(loadCryptoNode()).rejects.toThrow(/desktop/);
    await expect(loadBackup()).rejects.toThrow(/desktop/);
    await expect(loadRotateLog()).rejects.toThrow(/desktop/);
  });
});
