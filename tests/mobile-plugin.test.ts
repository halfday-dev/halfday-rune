/**
 * Plugin-level checks for the mobile path: memory-only handling, lock
 * notifying open views, source selection by platform.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { wrapMobileKey } from "../src/crypto";
import { recipientsFingerprint, STALE_COPY_WARNING } from "../src/mobile-copy";
import { checkPin, makePin } from "../src/recipient-pin";

const h = vi.hoisted(() => ({
  desktop: false,
  data: null as unknown,
  closeSpy: vi.fn(),
  prompt: null as null | ((a: (pw: string) => Promise<void>) => Promise<boolean>),
  notices: [] as string[],
  // what the mocked node loader serves in place of ~/.age (never read for real)
  fileIdentity: "",
  fileRecipients: [] as string[],
  /** No identity file on this computer: readIdentity throws. */
  noIdentityFile: false,
  /** The confirm-set modal: what it was shown, and the owner's answer. */
  confirmSet: vi.fn(async (_p: unknown) => true),
  loadCryptoNode: vi.fn(),
  loadBackup: vi.fn(),
  loadRotateLog: vi.fn(),
}));

vi.mock("../src/node-loader", () => ({
  loadCryptoNode: async () => {
    h.loadCryptoNode();
    // like the real loader: the Node file helpers do not exist off desktop
    if (!h.desktop) throw new Error("loadCryptoNode called on mobile");
    return {
      readIdentity: () => {
        if (h.noIdentityFile) throw new Error("no AGE-SECRET-KEY-1... identity found");
        return h.fileIdentity;
      },
      readRecipients: () => [...h.fileRecipients],
    };
  },
  loadBackup: async () => {
    h.loadBackup();
    throw new Error("loadBackup is not available in tests");
  },
  loadRotateLog: async () => {
    h.loadRotateLog();
    throw new Error("loadRotateLog is not available in tests");
  },
}));

vi.mock("../src/mobile-modals", () => ({
  makeUnlockPrompt: () =>
    Object.assign((a: (pw: string) => Promise<void>) => h.prompt!(a), { close: h.closeSpy }),
  CreateMobileCopyModal: class {},
}));

vi.mock("../src/recipients-modal", () => ({
  ConfirmMainRecipientsModal: class {},
  ConfirmRecipientSetModal: class {
    constructor(_app: unknown, private p: unknown, private done: (ok: boolean) => void) {}
    open() {
      void h.confirmSet(this.p).then(this.done);
    }
  },
}));

vi.mock("obsidian", () => {
  class Stub {}
  class Notice {
    constructor(m: string) { h.notices.push(m); }
    hide() {} setMessage() {}
  }
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
    App: Stub, Modal: Stub, Notice, Plugin, PluginSettingTab: Stub, Setting: Stub,
    TFile: Stub, FileView: Stub, Scope: Stub, WorkspaceLeaf: Stub,
  };
});

const PW = "a long random passphrase 98765";

const KEY_PATH = "_rune/identity.age";
const SIDECAR_PATH = "_rune/identity.recipients.sha256";

/**
 * `copyRecipients`: the list wrapped into the unlock copy (own recipient is
 * added by wrapMobileKey). `files`: vault files by path; the unlock copy is
 * at KEY_PATH unless overridden. Without `files`, every path reads the copy.
 */
async function boot(
  desktop: boolean,
  opts: {
    identity?: string;
    copyRecipients?: string[];
    files?: (wrapped: Uint8Array) => Record<string, Uint8Array>;
  } = {}
) {
  h.desktop = desktop;
  const identity = opts.identity ?? (await generateIdentity());
  if (!h.fileIdentity) h.fileIdentity = identity;
  const wrapped = await wrapMobileKey(identity, opts.copyRecipients ?? [], PW, 16);
  const files = opts.files?.(wrapped);
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
        exists: async (path: string) => (files ? path in files : true),
        readBinary: async (path: string) => {
          const b = files ? files[path] : wrapped;
          if (!b) throw new Error("ENOENT");
          return b.slice().buffer;
        },
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
  h.notices = [];
  h.fileIdentity = "";
  h.fileRecipients = [];
  h.noIdentityFile = false;
  h.confirmSet.mockReset();
  h.confirmSet.mockImplementation(async () => true);
  h.loadCryptoNode.mockClear();
  h.loadBackup.mockClear();
  h.loadRotateLog.mockClear();
  vi.useRealTimers();
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
    // the first unlock pinned the recipient set (public keys + MAC): nothing else is added
    expect(Object.keys(JSON.parse(p.saved.at(-1))).sort()).toEqual([
      "autoBackupBeforeRotate", "autoLockMinutes", "backgroundLockGraceSeconds",
      "desktopKeyMode", "identityPath", "mobileKeyPath", "recipientPin", "recipientsPath",
    ]);
    expect(h.loadCryptoNode).not.toHaveBeenCalled();
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

  it("switching refuses when there is no unlock copy, without prompting, and changes nothing", async () => {
    const { p } = await boot(true);
    p.app.vault.adapter.exists = async () => false;
    const prompted = vi.fn();
    h.prompt = async (a) => (prompted(), await a(PW), true);
    const before = p.saved.length;
    await p.switchToPassphrase();
    expect(prompted).not.toHaveBeenCalled();
    expect(p.settings.desktopKeyMode).toBe("file");
    expect(p.saved.length).toBe(before);
    expect(h.notices.at(-1)).toMatch(/no unlock copy/);
  });

  it("switching refuses a file at the unlock path that is not a wrapped copy, without prompting", async () => {
    const { p } = await boot(true, {
      files: () => ({ [KEY_PATH]: new TextEncoder().encode("# just a note\n") }),
    });
    const prompted = vi.fn();
    h.prompt = async (a) => (prompted(), await a(PW), true);
    const before = p.saved.length;
    await p.switchToPassphrase();
    expect(prompted).not.toHaveBeenCalled();
    expect(p.settings.desktopKeyMode).toBe("file");
    expect(p.saved.length).toBe(before);
    expect(h.notices.at(-1)).toMatch(/no unlock copy/);
  });

  it("switching succeeds when the copy holds the current recipients: records and saves the mode, shows count and fingerprint", async () => {
    const identity = await generateIdentity();
    const own = await identityToRecipient(identity);
    const other = await identityToRecipient(await generateIdentity());
    h.fileRecipients = [own, other];
    const { p } = await boot(true, {
      identity,
      copyRecipients: [other],
      files: (w) => ({ [KEY_PATH]: w }),
    });
    const before = p.saved.length;
    await p.switchToPassphrase();
    expect(p.settings.desktopKeyMode).toBe("passphrase");
    expect(p.saved.length).toBe(before + 1);
    expect(JSON.parse(p.saved.at(-1)).desktopKeyMode).toBe("passphrase");
    const fp = await recipientsFingerprint([own, other]);
    expect(h.notices.at(-1)).toContain("2 recipient(s)");
    expect(h.notices.at(-1)).toContain(fp);
  });

  it("switching works when recipients.txt lacks the owner's own line (#110 F3)", async () => {
    const identity = await generateIdentity();
    const other = await identityToRecipient(await generateIdentity());
    h.fileRecipients = [other]; // no own recipient: the copy adds it
    const { p } = await boot(true, {
      identity,
      copyRecipients: [other],
      files: (w) => ({ [KEY_PATH]: w }),
    });
    await p.switchToPassphrase();
    expect(p.settings.desktopKeyMode).toBe("passphrase");
  });

  it("switching with a wrong passphrase leaves the mode unchanged", async () => {
    h.fileRecipients = [];
    const { p } = await boot(true, { files: (w) => ({ [KEY_PATH]: w }) });
    let rejected = 0;
    h.prompt = async (a) => {
      await a("not the passphrase at all 000").catch(() => rejected++);
      return false; // the owner gives up
    };
    const before = p.saved.length;
    await p.switchToPassphrase();
    expect(rejected).toBe(1);
    expect(p.settings.desktopKeyMode).toBe("file");
    expect(p.saved.length).toBe(before);
  });

  it("switching refuses a copy whose wrapped recipients differ from the current list, whatever the sidecar says (#110 F1)", async () => {
    const identity = await generateIdentity();
    const own = await identityToRecipient(identity);
    const removed = await identityToRecipient(await generateIdentity());
    h.fileRecipients = [own]; // the attacker's key was removed from recipients.txt
    // older copy under the same passphrase still lists it; the sidecar is forged to match today's list
    const forged = new TextEncoder().encode((await recipientsFingerprint([own])) + "\n");
    const { p } = await boot(true, {
      identity,
      copyRecipients: [removed],
      files: (w) => ({ [KEY_PATH]: w, [SIDECAR_PATH]: forged }),
    });
    const before = p.saved.length;
    await p.switchToPassphrase();
    expect(p.settings.desktopKeyMode).toBe("file");
    expect(p.saved.length).toBe(before);
    expect(h.notices.at(-1)).toContain(STALE_COPY_WARNING);
  });

  it("desktop passphrase mode locks after autoLockMinutes idle", async () => {
    h.data = { desktopKeyMode: "passphrase", autoLockMinutes: 5 };
    const { p, showLocked } = await boot(true);
    const ks = p.getKeySource();
    await ks.getIdentity(); // real timers: the scrypt unwrap
    vi.useFakeTimers();
    await ks.getIdentity(); // re-arms the idle timer on the fake clock
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1000);
    expect(ks.isUnlocked()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ks.isUnlocked()).toBe(false);
    expect(showLocked).toHaveBeenCalled();
  });

  it("rotateKeys called directly in passphrase mode stops before any key, loader or prompt", async () => {
    h.data = { desktopKeyMode: "passphrase" };
    const { p } = await boot(true);
    p.app.vault.getFiles = () => [{ path: "a.age", extension: "age" }];
    p.app.vault.adapter.basePath = "/nonexistent-test-vault";
    const prompted = vi.fn();
    h.prompt = async (a) => (prompted(), await a(PW), true);
    h.loadCryptoNode.mockClear();
    await p.rotateKeys();
    expect(prompted).not.toHaveBeenCalled();
    expect(h.loadCryptoNode).not.toHaveBeenCalled();
    expect(h.loadBackup).not.toHaveBeenCalled();
    expect(h.loadRotateLog).not.toHaveBeenCalled();
    expect(h.notices.at(-1)).toMatch(/rotate needs key file mode/);
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

  it("anti-rollback: an old-identity copy under the same passphrase is refused when the file holds a new key (#2 §2)", async () => {
    const oldId = await generateIdentity();
    const newId = await generateIdentity();
    const newR = await identityToRecipient(newId);
    h.fileIdentity = newId;
    h.fileRecipients = [newR];
    // the copy was made before rotation: old identity, and it lists the new key
    // too, so deriving the own recipient from the UNWRAPPED identity would match
    const { p } = await boot(true, {
      identity: oldId,
      copyRecipients: [newR],
      files: (w) => ({ [KEY_PATH]: w }),
    });
    const before = p.saved.length;
    await p.switchToPassphrase();
    expect(p.settings.desktopKeyMode).toBe("file");
    expect(p.settings.recipientPin).toBeUndefined();
    expect(p.saved.length).toBe(before);
    expect(h.notices.at(-1)).toContain(STALE_COPY_WARNING);
  });

  it("switching pins the copy's set, verifiable with the copy's identity, in the same single save", async () => {
    const identity = await generateIdentity();
    const own = await identityToRecipient(identity);
    const other = await identityToRecipient(await generateIdentity());
    h.fileRecipients = [own, other];
    const { p } = await boot(true, { identity, copyRecipients: [other], files: (w) => ({ [KEY_PATH]: w }) });
    const before = p.saved.length;
    await p.switchToPassphrase();
    expect(p.saved.length).toBe(before + 1);
    const saved = JSON.parse(p.saved.at(-1));
    expect(await checkPin(saved.recipientPin, identity, [own, other])).toEqual({ status: "ok" });
    expect(h.confirmSet).not.toHaveBeenCalled(); // compared against the identity file instead
  });

  it("enrols a Mac with no identity file by trust on first use: shows count + fingerprint + keys, then pins them (#2 §3)", async () => {
    const identity = await generateIdentity();
    const own = await identityToRecipient(identity);
    const other = await identityToRecipient(await generateIdentity());
    h.noIdentityFile = true;
    const { p } = await boot(true, { identity, copyRecipients: [other], files: (w) => ({ [KEY_PATH]: w }) });
    const before = p.saved.length;
    await p.switchToPassphrase();
    expect(h.confirmSet).toHaveBeenCalledTimes(1);
    const shown = h.confirmSet.mock.calls[0][0] as { recipients: string[]; fingerprint: string };
    expect(shown.recipients).toEqual([own, other].sort());
    expect(shown.fingerprint).toBe(await recipientsFingerprint([own, other]));
    expect(p.settings.desktopKeyMode).toBe("passphrase");
    expect(p.saved.length).toBe(before + 1);
    expect(await checkPin(p.settings.recipientPin, identity, [other])).toEqual({ status: "ok" });
    expect(h.notices.at(-1)).toContain("2 recipient(s)");
    expect(h.notices.at(-1)).not.toMatch(/delete your identity file/);
  });

  it("enrolment without an identity file changes nothing when the owner declines", async () => {
    h.noIdentityFile = true;
    h.confirmSet.mockImplementation(async () => false);
    const { p } = await boot(true, { files: (w) => ({ [KEY_PATH]: w }) });
    const before = p.saved.length;
    await p.switchToPassphrase();
    expect(p.settings.desktopKeyMode).toBe("file");
    expect(p.settings.recipientPin).toBeUndefined();
    expect(p.saved.length).toBe(before);
  });
});

describe("recipient pin wiring (#2)", () => {
  async function fileMode(pinned: string[], onDisk: string[]) {
    const identity = await generateIdentity();
    h.fileIdentity = identity;
    h.fileRecipients = onDisk;
    h.data = { recipientPin: await makePin(identity, pinned) };
    const { p } = await boot(true, { identity });
    return { p, identity };
  }

  it("registers 'Confirm recipient set' on desktop and mobile", async () => {
    for (const desktop of [true, false]) {
      const { p } = await boot(desktop);
      expect(p.commands.map((c: { id: string }) => c.id)).toContain("halfday-rune-confirm-recipients");
    }
  });

  it("key file mode: a key appended to recipients.txt stops encryption with a clear message", async () => {
    const own = await identityToRecipient(await generateIdentity());
    const attacker = await identityToRecipient(await generateIdentity());
    const { p } = await fileMode([own], [own, attacker]);
    await expect(p.getKeySource().getRecipients()).rejects.toThrow(/\+1 added/);
    expect(h.confirmSet).not.toHaveBeenCalled();
  });

  it("key file mode with no pin yet: the first encrypt asks, and the answer is saved", async () => {
    const identity = await generateIdentity();
    const other = await identityToRecipient(await generateIdentity());
    h.fileIdentity = identity;
    h.fileRecipients = [other];
    const { p } = await boot(true, { identity });
    expect(await p.getKeySource().getRecipients()).toEqual([other]);
    expect(h.confirmSet).toHaveBeenCalledTimes(1);
    expect(await checkPin(p.settings.recipientPin, identity, [other])).toEqual({ status: "ok" });
    await p.getKeySource().getRecipients();
    expect(h.confirmSet).toHaveBeenCalledTimes(1);
  });

  it("concurrent first encrypts share one confirm modal", async () => {
    const identity = await generateIdentity();
    h.fileIdentity = identity;
    h.fileRecipients = [await identityToRecipient(identity)];
    const { p } = await boot(true, { identity });
    const ks = p.getKeySource();
    await Promise.all([ks.getRecipients(), ks.getRecipients(), ks.getRecipients()]);
    expect(h.confirmSet).toHaveBeenCalledTimes(1);
  });

  it("startup's stale-copy check never asks to confirm", async () => {
    h.fileRecipients = [await identityToRecipient(await generateIdentity())];
    const { p } = await boot(true);
    await p.checkMobileCopyFreshness();
    expect(h.confirmSet).not.toHaveBeenCalled();
  });

  it("'Confirm recipient set' lists the added key apart and re-pins on yes", async () => {
    const own = await identityToRecipient(await generateIdentity());
    const added = await identityToRecipient(await generateIdentity());
    const { p, identity } = await fileMode([own], [own, added]);
    await p.confirmRecipientSet();
    const shown = h.confirmSet.mock.calls[0][0] as { diff: { added: string[] } };
    expect(shown.diff.added).toEqual([added]);
    expect(await checkPin(p.settings.recipientPin, identity, [own, added])).toEqual({ status: "ok" });
    expect(await p.getKeySource().getRecipients()).toEqual([own, added]);
  });

  it("'Confirm recipient set' declined: the pin is unchanged and encryption still refuses", async () => {
    const own = await identityToRecipient(await generateIdentity());
    const added = await identityToRecipient(await generateIdentity());
    const { p } = await fileMode([own], [own, added]);
    const pinBefore = JSON.stringify(p.settings.recipientPin);
    h.confirmSet.mockImplementation(async () => false);
    await p.confirmRecipientSet();
    expect(JSON.stringify(p.settings.recipientPin)).toBe(pinBefore);
    await expect(p.getKeySource().getRecipients()).rejects.toThrow(/added/);
  });

  it("a forged pin that already lists the attacker's key does not hide it: nothing is marked as diff", async () => {
    const identity = await generateIdentity();
    const own = await identityToRecipient(identity);
    const attacker = await identityToRecipient(await generateIdentity());
    h.fileIdentity = identity;
    h.fileRecipients = [own, attacker];
    const real = await makePin(identity, [own]);
    h.data = { recipientPin: { recipients: [own, attacker].sort(), mac: real.mac } };
    const { p } = await boot(true, { identity });
    await expect(p.getKeySource().getRecipients()).rejects.toThrow(/could not be verified/);
    await p.confirmRecipientSet();
    const shown = h.confirmSet.mock.calls[0][0] as { diff: unknown; recipients: string[]; note: string };
    expect(shown.diff).toBeNull();
    expect(shown.recipients).toContain(attacker);
    expect(shown.note).toMatch(/could not be verified/);
  });

  it("after a settings-editor save: removals re-pin without asking", async () => {
    const own = await identityToRecipient(await generateIdentity());
    const gone = await identityToRecipient(await generateIdentity());
    const { p, identity } = await fileMode([own, gone], [own]);
    await p.confirmRecipientSet({ afterEdit: true });
    expect(h.confirmSet).not.toHaveBeenCalled();
    expect(await checkPin(p.settings.recipientPin, identity, [own])).toEqual({ status: "ok" });
  });

  it("after a settings-editor save: an addition still asks", async () => {
    const own = await identityToRecipient(await generateIdentity());
    const added = await identityToRecipient(await generateIdentity());
    const { p } = await fileMode([own], [own, added]);
    h.confirmSet.mockImplementation(async () => false);
    await p.confirmRecipientSet({ afterEdit: true });
    expect(h.confirmSet).toHaveBeenCalledTimes(1);
    await expect(p.getKeySource().getRecipients()).rejects.toThrow(/added/);
  });

  it("passphrase mode: unlock refuses an unlock copy that differs from the pin and holds no key", async () => {
    const identity = await generateIdentity();
    const own = await identityToRecipient(identity);
    const revoked = await identityToRecipient(await generateIdentity());
    h.data = { desktopKeyMode: "passphrase", recipientPin: await makePin(identity, [own]) };
    // an older copy under the same passphrase that still lists a revoked key
    const { p } = await boot(true, { identity, copyRecipients: [revoked] });
    await expect(p.getKeySource().getIdentity()).rejects.toThrow(/\+1 added/);
    expect(p.getKeySource().isUnlocked()).toBe(false);
    expect(h.confirmSet).not.toHaveBeenCalled();
  });

  it("mobile: 'Confirm recipient set' reviews the copy with a one-off unlock that skips the pin", async () => {
    const identity = await generateIdentity();
    const own = await identityToRecipient(identity);
    const added = await identityToRecipient(await generateIdentity());
    h.data = { recipientPin: await makePin(identity, [own]) };
    const { p } = await boot(false, { identity, copyRecipients: [added] });
    await expect(p.getKeySource().getIdentity()).rejects.toThrow(/added/);
    await p.confirmRecipientSet();
    expect((h.confirmSet.mock.calls[0][0] as { diff: { added: string[] } }).diff.added).toEqual([added]);
    expect(await p.getKeySource().getIdentity()).toBe(identity);
    expect(h.loadCryptoNode).not.toHaveBeenCalled();
  });
});
