/**
 * Plugin-level checks for the mobile path: memory-only handling, lock
 * notifying open views, source selection by platform.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateIdentity } from "age-encryption";
import { wrapMobileKey } from "../src/crypto";

const h = vi.hoisted(() => ({
  desktop: false,
  data: null as unknown,
  closeSpy: vi.fn(),
  prompt: null as null | ((a: (pw: string) => Promise<void>) => Promise<boolean>),
}));

vi.mock("../src/mobile-modals", () => ({
  makeUnlockPrompt: () =>
    Object.assign((a: (pw: string) => Promise<void>) => h.prompt!(a), { close: h.closeSpy }),
  CreateMobileCopyModal: class {},
}));

vi.mock("obsidian", () => {
  class Stub {}
  class Plugin {
    app: unknown;
    manifest = { version: "0.7.0", name: "Halfday Rune" };
    saved: string[] = [];
    commands: { id: string }[] = [];
    domListeners: Record<string, () => void> = {};
    async loadData() { return h.data; }
    async saveData(d: unknown) { this.saved.push(JSON.stringify(d)); }
    addCommand(c: { id: string }) { this.commands.push(c); }
    addStatusBarItem() {
      const el: Record<string, unknown> = { text: "" };
      Object.assign(el, {
        addClass() {}, removeClass() {}, empty() {}, addEventListener() {},
        setAttribute() {}, setText(t: string) { el.text = t; },
      });
      return el;
    }
    registerView() {} registerExtensions() {} registerEvent() {} addSettingTab() {}
    registerDomEvent(_t: unknown, ev: string, cb: () => void) { this.domListeners[ev] = cb; }
  }
  return {
    get Platform() { return { isDesktopApp: h.desktop, isMobile: !h.desktop }; },
    App: Stub, Modal: Stub, Notice: Stub, Plugin, PluginSettingTab: Stub, Setting: Stub,
    TFile: Stub, FileView: Stub, Scope: Stub, WorkspaceLeaf: Stub,
  };
});

const PW = "a long random passphrase 98765";

async function boot(desktop: boolean) {
  h.desktop = desktop;
  const identity = await generateIdentity();
  const wrapped = await wrapMobileKey(identity, [], PW, 16);
  const { default: Plugin } = await import("../src/main");
  const { AgeFileView } = await import("../src/age-view");
  const view = Object.create(AgeFileView.prototype) as InstanceType<typeof AgeFileView>;
  const showLocked = vi.fn();
  const flush = vi.fn(async () => {});
  const flushIfDirty = vi.fn(async () => {});
  Object.assign(view, { showLocked, flushBeforeLock: flush, flushIfDirty });
  const p = new (Plugin as unknown as new () => Record<string, any>)();
  p.app = {
    vault: {
      adapter: {
        exists: async () => true,
        readBinary: async () => wrapped.slice().buffer,
      },
    },
    workspace: {
      on: () => ({}),
      getLeavesOfType: () => [{ view }],
    },
  };
  vi.stubGlobal("document", { visibilityState: "visible" }); // after CodeMirror loaded
  await p.onload();
  return { p, identity, view, showLocked, flush, flushIfDirty };
}

let storageWrites: string[];
beforeEach(() => {
  h.data = null;
  storageWrites = [];
  const store = {
    setItem: (k: string, v: string) => storageWrites.push(`${k}=${v}`),
    getItem: () => null, removeItem: () => {}, clear: () => {},
  };
  vi.stubGlobal("localStorage", store);
  vi.stubGlobal("sessionStorage", store);
  h.prompt = async (attempt) => (await attempt(PW), true);
});

describe("mobile plugin wiring", () => {
  it("uses the passphrase source off-desktop and registers lock commands", async () => {
    const { p } = await boot(false);
    expect(p.getKeySource().constructor.name).toBe("PassphraseKeySource");
    const ids = p.commands.map((c: { id: string }) => c.id);
    expect(ids).toContain("halfday-rune-lock");
    expect(ids).toContain("halfday-rune-unlock");
    expect(ids).not.toContain("halfday-rune-create-mobile-unlock");
  });

  it("still uses FileKeySource on desktop, with no lock commands", async () => {
    const { p } = await boot(true);
    expect(p.getKeySource().constructor.name).toBe("FileKeySource");
    const ids = p.commands.map((c: { id: string }) => c.id);
    expect(ids).toContain("halfday-rune-create-mobile-unlock");
    expect(ids).not.toContain("halfday-rune-lock");
  });

  it("memory only: unlocking writes nothing to data.json or localStorage", async () => {
    const { p, identity } = await boot(false);
    await p.getKeySource().getIdentity();
    await p.saveSettings();
    expect(p.saved.length).toBeGreaterThan(0);
    for (const payload of p.saved) {
      expect(payload).not.toContain("AGE-SECRET-KEY");
      expect(payload).not.toContain(identity);
      expect(payload).not.toContain(PW);
    }
    expect(storageWrites).toEqual([]);
    expect(Object.keys(JSON.parse(p.saved[0])).sort()).toEqual([
      "autoBackupBeforeRotate", "autoLockMinutes", "backgroundLockGraceSeconds",
      "desktopKeyMode", "identityPath", "mobileKeyPath", "recipientsPath",
    ]);
  });

  it("locking flushes then tells open views to show the locked state", async () => {
    const { p, view, showLocked, flush } = await boot(false);
    const ks = p.getKeySource();
    await ks.getIdentity();
    expect(showLocked).not.toHaveBeenCalled();
    await p.passphraseSource.lockGracefully();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(showLocked).toHaveBeenCalledTimes(1);
    expect(ks.isUnlocked()).toBe(false);
    expect(view).toBeDefined();
  });

  it("document visibility hidden with grace 0 locks", async () => {
    const { p, showLocked } = await boot(false);
    p.settings.backgroundLockGraceSeconds = 0;
    await p.getKeySource().getIdentity();
    (document as { visibilityState: string }).visibilityState = "hidden";
    p.domListeners["visibilitychange"]();
    await new Promise((r) => setTimeout(r, 10));
    expect(p.getKeySource().isUnlocked()).toBe(false);
    expect(showLocked).toHaveBeenCalled();
  });

  it("document hidden flushes dirty edits immediately, even with a long grace period", async () => {
    const { p, flushIfDirty, showLocked } = await boot(false);
    p.settings.backgroundLockGraceSeconds = 600;
    await p.getKeySource().getIdentity();
    (document as { visibilityState: string }).visibilityState = "hidden";
    p.domListeners["visibilitychange"]();
    expect(flushIfDirty).toHaveBeenCalledTimes(1);
    expect(showLocked).not.toHaveBeenCalled();
    (document as { visibilityState: string }).visibilityState = "visible";
    p.domListeners["visibilitychange"]();
    expect(flushIfDirty).toHaveBeenCalledTimes(1);
  });

  it("onunload locks and does not prompt again", async () => {
    const { p } = await boot(false);
    const ks = p.getKeySource();
    await ks.getIdentity();
    p.onunload();
    expect(h.closeSpy).toHaveBeenCalled();
    expect(ks.isUnlocked()).toBe(false);
    await expect(ks.getIdentity()).rejects.toThrow(/locked/);
  });
});


describe("desktop passphrase mode (#110)", () => {
  it("defaults to the key file", async () => {
    const { p } = await boot(true);
    expect(p.settings.desktopKeyMode).toBe("file");
    expect(p.usesPassphrase()).toBe(false);
  });

  it("opted in: passphrase source, lock commands, no rotate / create-copy", async () => {
    h.data = { desktopKeyMode: "passphrase" };
    const { p } = await boot(true);
    expect(p.getKeySource().constructor.name).toBe("PassphraseKeySource");
    const ids = p.commands.map((c: { id: string }) => c.id);
    expect(ids).toContain("halfday-rune-lock");
    expect(ids).toContain("halfday-rune-unlock");
    expect(ids).not.toContain("halfday-rune-rotate-keys");
    expect(ids).not.toContain("halfday-rune-create-mobile-unlock");
    expect(ids).not.toContain("halfday-rune-use-passphrase");
  });

  it("key file mode offers the switch command", async () => {
    const { p } = await boot(true);
    expect(p.commands.map((c: { id: string }) => c.id)).toContain("halfday-rune-use-passphrase");
  });

  it("startup does not prompt for the passphrase in passphrase mode", async () => {
    h.data = { desktopKeyMode: "passphrase" };
    const prompted = vi.fn();
    h.prompt = async (a) => (prompted(), await a(PW), true);
    const { p } = await boot(true);
    await p.checkMobileCopyFreshness();
    expect(prompted).not.toHaveBeenCalled();
    expect(p.getKeySource().isUnlocked()).toBe(false);
  });

  it("unlocks from the wrapped copy and never touches data.json or storage with the key", async () => {
    h.data = { desktopKeyMode: "passphrase" };
    const { p, identity } = await boot(true);
    expect(await p.getKeySource().getIdentity()).toBe(identity);
    await p.saveSettings();
    for (const payload of p.saved) expect(payload).not.toContain("AGE-SECRET-KEY");
    expect(storageWrites).toEqual([]);
  });

  it("switching refuses when there is no unlock copy, and changes nothing", async () => {
    const { p } = await boot(true);
    p.app.vault.adapter.exists = async () => false;
    const before = p.saved.length;
    await p.switchToPassphrase();
    expect(p.settings.desktopKeyMode).toBe("file");
    expect(p.saved.length).toBe(before);
  });

  it("switching with a dismissed prompt changes nothing", async () => {
    const { p } = await boot(true);
    h.prompt = async () => false;
    await p.switchToPassphrase();
    expect(p.settings.desktopKeyMode).toBe("file");
  });

  it("switching back to key file records the mode", async () => {
    h.data = { desktopKeyMode: "passphrase" };
    const { p } = await boot(true);
    await p.switchToKeyFile();
    expect(p.settings.desktopKeyMode).toBe("file");
  });
});
