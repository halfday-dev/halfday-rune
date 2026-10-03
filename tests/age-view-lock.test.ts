/** AgeFileView: lock during a save, and the mobile wrapped-recipient guard. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { encrypt, decryptToString } from "../src/crypto";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", () => {
  class Stub {}
  class Notice { constructor(m: string) { notices.push(m); } }
  return { FileView: Stub, Notice, Scope: Stub, TFile: Stub, WorkspaceLeaf: Stub };
});

import { AgeFileView, UNKNOWN_RECIPIENTS_NOTICE, NOT_YOUR_KEY_NOTICE } from "../src/age-view";

beforeEach(() => { notices.length = 0; });

async function setup(opts: {
  sole: boolean;
  /** recipients the note on disk currently has, besides the phone's own key */
  existingOthers?: number;
  /** recipients in the wrapped list besides the phone's own key */
  wrappedOthers?: number;
  /** whether the phone's own key is among the note's current recipients */
  existingHasMine?: boolean;
}) {
  const identity = await generateIdentity();
  const mine = await identityToRecipient(identity);
  const others: { id: string; r: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const id = await generateIdentity();
    others.push({ id, r: await identityToRecipient(id) });
  }
  const wrapped = [mine, ...others.slice(0, opts.wrappedOthers ?? 0).map((o) => o.r)];
  const existingRs = [
    ...(opts.existingHasMine === false ? [] : [mine]),
    ...others.slice(0, opts.existingOthers ?? 0).map((o) => o.r),
  ];
  const existing = await encrypt(existingRs, "old");
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
        fixedRecipientList: opts.sole,
        getIdentity: async () => identity,
        getRecipients: async () => wrapped,
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
  return { view, modify, gate, identity, others, getDisk: () => disk, existing, setDoc: (d: string) => (doc = d) };
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

describe("mobile wrapped-recipient-list guard", () => {
  const saveOk = async (t: Awaited<ReturnType<typeof setup>>) => {
    const p = t.view.save("manual");
    await vi.waitFor(() => expect(t.modify).toHaveBeenCalled());
    t.gate.release();
    await p;
  };

  it("refuses a note with more stanzas than the wrapped list, writing nothing", async () => {
    const t = await setup({ sole: true, existingOthers: 1, wrappedOthers: 0 });
    await expect(t.view.save("manual")).rejects.toThrow();
    expect(notices).toContain(UNKNOWN_RECIPIENTS_NOTICE);
    expect(t.modify).not.toHaveBeenCalled();
    expect([...t.getDisk()]).toEqual([...t.existing]);
  });

  it("refuses a note our key cannot open, writing nothing", async () => {
    const t = await setup({ sole: true, existingHasMine: false, existingOthers: 1, wrappedOthers: 1 });
    await expect(t.view.save("manual")).rejects.toThrow();
    expect(notices).toContain(NOT_YOUR_KEY_NOTICE);
    expect(t.modify).not.toHaveBeenCalled();
  });

  it("re-encrypts to ALL wrapped recipients; each one can still open the note", async () => {
    // note on disk is for the phone's key only; the wrapped list has 3 keys
    const t = await setup({ sole: true, existingOthers: 0, wrappedOthers: 2 });
    await saveOk(t);
    expect(notices).toEqual([]);
    expect(await decryptToString(t.identity, t.getDisk())).toBe("new text");
    for (const o of t.others.slice(0, 2)) {
      expect(await decryptToString(o.id, t.getDisk())).toBe("new text");
    }
    await expect(decryptToString(t.others[2].id, t.getDisk())).rejects.toThrow();
  });

  it("saves a note that already has the same recipients as the list", async () => {
    const t = await setup({ sole: true, existingOthers: 1, wrappedOthers: 1 });
    await saveOk(t);
    expect(notices).toEqual([]);
    expect(await decryptToString(t.others[0].id, t.getDisk())).toBe("new text");
  });

  it("desktop source (no flag) is unchanged: multi-recipient notes still save", async () => {
    const t = await setup({ sole: false, existingOthers: 1 });
    await saveOk(t);
    expect(notices).toEqual([]);
  });
});
