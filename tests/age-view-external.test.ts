/**
 * AgeFileView vs other writers (the journal API, sync): a clean view reloads
 * when the file changes on disk, and a save never overwrites bytes the view
 * did not read or write itself. Test keys only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { encrypt, decryptToString } from "../src/crypto";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => {
  class Stub {}
  class TFile {}
  class Notice { constructor(m: string) { notices.push(m); } }
  return { FileView: Stub, Notice, Scope: class { register() {} }, TFile, WorkspaceLeaf: Stub };
});

import { TFile } from "obsidian";
import { AgeFileView, CHANGED_ON_DISK_NOTICE, conflictCopyNotice, conflictCopyPath } from "../src/age-view";

beforeEach(() => {
  notices.length = 0;
});

async function setup() {
  const identity = await generateIdentity();
  const mine = await identityToRecipient(identity);
  const loaded = await encrypt([mine], "as loaded");
  let disk = loaded;
  const hooks = { duringWrite: null as null | (() => void), failCreate: false };
  const modify = vi.fn(async (_f: unknown, data: ArrayBuffer) => {
    hooks.duringWrite?.(); // e.g. the owner keeps typing while the save is in flight
    disk = new Uint8Array(data);
    await onModify?.(file); // Obsidian fires "modify" for our own write too
  });
  /** Files made with createBinary (conflict copies). */
  const created = new Map<string, Uint8Array>();
  const createBinary = vi.fn(async (path: string, data: ArrayBuffer) => {
    if (hooks.failCreate) throw new Error("EPERM");
    if (created.has(path) || path === "j/n.md.age") throw new Error("File already exists.");
    created.set(path, new Uint8Array(data.slice(0)));
  });
  let onModify: ((f: unknown) => Promise<void> | void) | null = null;
  const keys = {
    fixedRecipientList: false,
    getIdentity: vi.fn(async () => identity),
    getRecipients: vi.fn(async () => [mine]),
    peekIdentity: vi.fn(async () => identity),
    peekRecipients: vi.fn(async () => [mine]),
    isUnlocked: () => true,
    lock() {},
  };
  const view = new (AgeFileView as unknown as new (l: unknown, d: unknown) => any)(
    {},
    { getKeySource: () => keys, updateStatusBar() {}, clearStatusBar() {} }
  );
  const file = Object.assign(Object.create((TFile as unknown as { prototype: object }).prototype), {
    path: "j/n.md.age",
    name: "n.md.age",
  });
  view.app = {
    scope: {},
    vault: {
      readBinary: async () => disk.slice().buffer,
      modifyBinary: modify,
      createBinary,
      on: (ev: string, cb: (f: unknown) => void) => {
        if (ev === "modify") onModify = cb;
        return {};
      },
    },
  };
  view.registerEvent = () => {};
  view.contentEl = { empty() {}, addClass() {}, createDiv: () => ({ empty() {} }) };
  await view.onOpen();
  view.file = file;
  let doc = "as loaded";
  view.editor = { state: { doc: { toString: () => doc } }, destroy() {} };
  view.editorHost = { empty() {}, createDiv: () => ({ createEl: () => ({ addEventListener() {} }) }) };
  view.plaintext = "as loaded";
  view.diskBytes = loaded; // what onLoadFile records
  return {
    view,
    keys,
    file,
    identity,
    mine,
    modify,
    hooks,
    created,
    createBinary,
    getDisk: () => disk,
    setDisk: (b: Uint8Array) => (disk = b),
    setDoc: (d: string) => (doc = d),
    fireModify: () => onModify?.(file),
  };
}

describe("F2b: external modify", () => {
  it("a clean view reloads quietly (no prompt, no idle reset) when another writer changed the file", async () => {
    const t = await setup();
    t.view.onLoadFile = vi.fn(async () => {});
    t.setDisk(await encrypt([t.mine], "written by gabbro"));
    await t.fireModify();
    expect(t.view.onLoadFile).toHaveBeenCalledWith(t.file, { quiet: true });
  });

  it("a quiet reload reads the key with peekIdentity, never getIdentity", async () => {
    const t = await setup();
    t.view.mountEditor = vi.fn();
    t.view.updateTabHeader = () => {};
    t.setDisk(await encrypt([t.mine], "written by gabbro"));
    await t.view.onLoadFile(t.file, { quiet: true });
    expect(t.keys.peekIdentity).toHaveBeenCalled();
    expect(t.keys.getIdentity).not.toHaveBeenCalled();
    expect(t.view.mountEditor).toHaveBeenCalledWith("written by gabbro");
  });

  it("a dirty view does not reload (its text is kept)", async () => {
    const t = await setup();
    t.view.onLoadFile = vi.fn(async () => {});
    t.view.dirty = true;
    t.setDisk(await encrypt([t.mine], "written by gabbro"));
    await t.fireModify();
    expect(t.view.onLoadFile).not.toHaveBeenCalled();
  });

  it("the view's own save is not treated as external", async () => {
    const t = await setup();
    t.view.onLoadFile = vi.fn(async () => {});
    t.view.updateTabHeader = () => {};
    t.view.dirty = true;
    t.setDoc("my edit");
    await t.view.save("manual");
    expect(t.modify).toHaveBeenCalledTimes(1);
    expect(t.view.onLoadFile).not.toHaveBeenCalled();
    expect(await decryptToString(t.identity, t.getDisk())).toBe("my edit");
  });
});

describe("F2c: save never overwrites another writer", () => {
  it("disk changed and no conflict copy can be written: no write, a Notice, the edit is kept", async () => {
    const t = await setup();
    t.hooks.failCreate = true;
    t.view.dirty = true;
    t.setDoc("my edit");
    const theirs = await encrypt([t.mine], "written by gabbro");
    t.setDisk(theirs);
    await expect(t.view.save("manual")).rejects.toThrow();
    expect(t.modify).not.toHaveBeenCalled();
    expect(notices).toContain(CHANGED_ON_DISK_NOTICE);
    expect(t.view.dirty).toBe(true);
    expect(t.view.editor.state.doc.toString()).toBe("my edit");
    expect(t.getDisk()).toBe(theirs);
  });

  it("unchanged disk saves, and the next save compares against the bytes just written", async () => {
    const t = await setup();
    t.view.updateTabHeader = () => {};
    t.view.dirty = true;
    t.setDoc("first edit");
    await t.view.save("manual");
    t.view.dirty = true;
    t.setDoc("second edit");
    await t.view.save("manual");
    expect(t.modify).toHaveBeenCalledTimes(2);
    expect(await decryptToString(t.identity, t.getDisk())).toBe("second edit");
  });

  it("hasUnsavedEdits is true only for the open, dirty file", async () => {
    const t = await setup();
    expect(t.view.hasUnsavedEdits("j/n.md.age")).toBe(false);
    t.view.dirty = true;
    expect(t.view.hasUnsavedEdits("j/n.md.age")).toBe(true);
    expect(t.view.hasUnsavedEdits("j/other.md.age")).toBe(false);
  });
});

describe("N2: a refused save always leaves the edits on disk, encrypted", () => {
  /** Dirty view; another writer then changes the file under it. */
  async function conflicted() {
    const t = await setup();
    t.view.onLoadFile = vi.fn(async () => {}); // the reload after the copy
    t.view.updateTabHeader = () => {};
    t.view.dirty = true;
    t.setDoc("my paragraph");
    const theirs = await encrypt([t.mine], "written by gabbro");
    t.setDisk(theirs);
    return { ...t, theirs };
  }
  async function expectCopy(t: Awaited<ReturnType<typeof conflicted>>) {
    expect(t.created.size).toBe(1);
    const [copyPath, bytes] = [...t.created][0];
    expect(copyPath).toMatch(/^j\/n \(conflict \d{4}-\d{2}-\d{2} \d{6}\)\.md\.age$/);
    expect(await decryptToString(t.identity, bytes)).toBe("my paragraph");
    expect(t.getDisk()).toBe(t.theirs); // the other writer's file is untouched
    expect(t.modify).not.toHaveBeenCalled();
    expect(notices).toContain(conflictCopyNotice(copyPath));
  }

  it("manual save", async () => {
    const t = await conflicted();
    await t.view.save("manual");
    await expectCopy(t);
    expect(t.view.dirty).toBe(false);
    expect(t.view.onLoadFile).toHaveBeenCalledWith(t.file, { quiet: true }); // shows the newer version
  });

  it("lock (auto-lock / background lock): flush, then the editor is torn down", async () => {
    const t = await conflicted();
    await t.view.flushBeforeLock();
    t.view.showLocked();
    await expectCopy(t);
    expect(t.view.editor).toBeNull();
    expect(notices).not.toContain("rune locked — your last edit could not be saved");
  });

  it("tab close", async () => {
    const t = await conflicted();
    await t.view.onClose();
    await expectCopy(t);
    expect(t.view.editor).toBeNull();
  });

  it("a taken copy name gets -2", async () => {
    const t = await conflicted();
    t.createBinary.mockRejectedValueOnce(new Error("File already exists."));
    await t.view.save("manual");
    expect([...t.created.keys()][0]).toMatch(/ \(conflict \d{4}-\d{2}-\d{2} \d{6}-2\)\.md\.age$/);
  });

  it("conflictCopyPath names", () => {
    const when = new Date(2026, 10, 14, 9, 3, 7);
    expect(conflictCopyPath("j/13_day.md.age", when)).toBe("j/13_day (conflict 2026-11-14 090307).md.age");
    expect(conflictCopyPath("note.age", when, 3)).toBe("note (conflict 2026-11-14 090307-3).md.age");
  });
});

describe("N3: typing during a save keeps the view dirty", () => {
  it("text typed while the write is in flight stays dirty and is autosaved, not reloaded over", async () => {
    vi.stubGlobal("window", { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() });
    try {
      const t = await setup();
      t.view.updateTabHeader = () => {};
      t.view.onLoadFile = vi.fn(async () => {});
      t.view.dirty = true;
      t.setDoc("first");
      t.hooks.duringWrite = () => t.setDoc("first and more");
      await t.view.save("manual");
      expect(await decryptToString(t.identity, t.getDisk())).toBe("first");
      expect(t.view.dirty).toBe(true);
      expect(t.view.hasUnsavedEdits("j/n.md.age")).toBe(true);
      expect((window as unknown as { setTimeout: ReturnType<typeof vi.fn> }).setTimeout).toHaveBeenCalled();
      // another writer now: a dirty view is not reloaded over the new text
      t.setDisk(await encrypt([t.mine], "written by gabbro"));
      await t.fireModify();
      expect(t.view.onLoadFile).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
