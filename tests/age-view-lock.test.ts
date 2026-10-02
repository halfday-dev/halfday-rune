/** AgeFileView: lock during a save, and the mobile sole-recipient guard. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { encrypt } from "../src/crypto";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => {
  class Stub {}
  class Notice { constructor(m: string) { notices.push(m); } }
  return { FileView: Stub, Notice, Scope: Stub, TFile: Stub, WorkspaceLeaf: Stub };
});

import { AgeFileView, SOLE_RECIPIENT_NOTICE } from "../src/age-view";

beforeEach(() => { notices.length = 0; });

async function setup(opts: { sole: boolean; existingRecipients?: "mine" | "two" }) {
  const identity = await generateIdentity();
  const mine = await identityToRecipient(identity);
  const other = await identityToRecipient(await generateIdentity());
  const existing = await encrypt(opts.existingRecipients === "two" ? [mine, other] : [mine], "old");
  let disk = existing;
  const gate: { release: () => void } = { release: () => {} };
  const modify = vi.fn(async (_f: unknown, data: ArrayBuffer) => {
    await new Promise<void>((r) => (gate.release = r));
    disk = new Uint8Array(data);
  });
  let doc = "new text";
  const view = new (AgeFileView as unknown as new (l: unknown, d: unknown) => any)(
    {},
    {
      getKeySource: () => ({
        soleRecipientOnly: opts.sole,
        getIdentity: async () => identity,
        getRecipients: async () => [mine],
        isUnlocked: () => true,
        lock() {},
      }),
      updateStatusBar() {},
      clearStatusBar() {},
    }
  );
  view.app = { vault: { readBinary: async () => disk.slice().buffer, modifyBinary: modify } };
  view.file = { path: "n.md.age", name: "n.md.age" };
  view.editor = { state: { doc: { toString: () => doc } }, destroy() {} };
  view.editorHost = { empty() {}, createDiv: () => ({ createEl: () => ({ addEventListener() {} }) }) };
  view.plaintext = "old";
  view.dirty = true;
  return { view, modify, gate, getDisk: () => disk, existing, setDoc: (d: string) => (doc = d) };
}

describe("AgeFileView save vs lock", () => {
  it("a lock during the write leaves no decrypted text behind", async () => {
    const t = await setup({ sole: true });
    const saving = t.view.save("manual");
    await vi.waitFor(() => expect(t.modify).toHaveBeenCalled());
    t.view.showLocked();
    t.gate.release();
    await saving;
    expect(t.view.plaintext).toBeNull();
    expect(t.view.dirty).toBe(false);
    expect(t.view.editor).toBeNull();
  });

  it("flushBeforeLock: edit typed during the flush gives the fixed notice", async () => {
    const t = await setup({ sole: true });
    const flushing = t.view.flushBeforeLock();
    await vi.waitFor(() => expect(t.modify).toHaveBeenCalled());
    t.setDoc("typed during flush");
    t.gate.release();
    await flushing;
    expect(notices).toContain("rune locked — your last edit could not be saved");
  });

  it("flushBeforeLock: a clean flush gives no notice", async () => {
    const t = await setup({ sole: true });
    const flushing = t.view.flushBeforeLock();
    await vi.waitFor(() => expect(t.modify).toHaveBeenCalled());
    t.gate.release();
    await flushing;
    expect(notices).toEqual([]);
  });

  it("flushBeforeLock: a failed save gives the fixed notice", async () => {
    const t = await setup({ sole: true });
    t.modify.mockImplementationOnce(async () => { throw new Error("disk"); });
    await t.view.flushBeforeLock();
    expect(notices).toContain("rune locked — your last edit could not be saved");
  });
});

describe("mobile sole-recipient guard", () => {
  it("refuses to save a note encrypted to more than one key, writing nothing", async () => {
    const t = await setup({ sole: true, existingRecipients: "two" });
    await expect(t.view.save("manual")).rejects.toThrow();
    expect(notices).toContain(SOLE_RECIPIENT_NOTICE);
    expect(t.modify).not.toHaveBeenCalled();
    expect([...t.getDisk()]).toEqual([...t.existing]);
  });

  it("saves a single-recipient note", async () => {
    const t = await setup({ sole: true });
    const p = t.view.save("manual");
    await vi.waitFor(() => expect(t.modify).toHaveBeenCalled());
    t.gate.release();
    await p;
    expect(notices).toEqual([]);
  });

  it("desktop source (no flag) is unchanged: multi-recipient notes still save", async () => {
    const t = await setup({ sole: false, existingRecipients: "two" });
    const p = t.view.save("manual");
    await vi.waitFor(() => expect(t.modify).toHaveBeenCalled());
    t.gate.release();
    await p;
    expect(notices).toEqual([]);
  });
});
