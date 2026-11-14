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
import { AgeFileView, CHANGED_ON_DISK_NOTICE } from "../src/age-view";

beforeEach(() => {
  notices.length = 0;
});

async function setup() {
  const identity = await generateIdentity();
  const mine = await identityToRecipient(identity);
  const loaded = await encrypt([mine], "as loaded");
  let disk = loaded;
  const modify = vi.fn(async (_f: unknown, data: ArrayBuffer) => {
    disk = new Uint8Array(data);
    await onModify?.(file); // Obsidian fires "modify" for our own write too
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
  it("disk changed since load: no write, a Notice, the edit is kept", async () => {
    const t = await setup();
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
