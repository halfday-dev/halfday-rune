/** iOS keyboard: CM6 re-measure hooks, and the doc is never truncated. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import { EditorState } from "@codemirror/state";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { encrypt, decryptToString } from "../src/crypto";

vi.mock("obsidian", () => {
  class Stub {}
  class ScopeStub { register() {} }
  class Notice { constructor(_m: string) {} }
  return { FileView: Stub, Notice, Scope: ScopeStub, TFile: Stub, WorkspaceLeaf: Stub };
});

import { AgeFileView } from "../src/age-view";

const PLAIN = [
  "this is a mac test",
  "can you see this written from the phone and the mac and more words to wrap around",
  "",
  "third paragraph",
  "",
  "fourth paragraph",
].join("\n");

afterEach(() => vi.unstubAllGlobals());

function mkView(opts: { remeasure: boolean }) {
  const listeners: Record<string, Set<() => void>> = { resize: new Set(), scroll: new Set() };
  const vv = {
    addEventListener: (e: string, f: () => void) => listeners[e].add(f),
    removeEventListener: (e: string, f: () => void) => listeners[e].delete(f),
  };
  const winL: Record<string, Set<() => void>> = { resize: new Set() };
  vi.stubGlobal("window", {
    visualViewport: vv,
    addEventListener: (e: string, f: () => void) => winL[e].add(f),
    removeEventListener: (e: string, f: () => void) => winL[e].delete(f),
  });
  const focusL = new Set<() => void>();
  const wsHandlers = new Set<() => void>();
  const requestMeasure = vi.fn();
  const view = new (AgeFileView as unknown as new (l: unknown, d: unknown) => any)(
    {},
    { remeasureOnViewport: opts.remeasure, getKeySource: () => ({}), updateStatusBar() {}, clearStatusBar() {} }
  );
  view.app = {
    workspace: {
      on: (_n: string, f: () => void) => (wsHandlers.add(f), f),
      offref: (f: () => void) => wsHandlers.delete(f),
    },
  };
  view.editor = { requestMeasure, destroy() {}, dom: { addEventListener: (_e: string, f: () => void) => focusL.add(f), removeEventListener: (_e: string, f: () => void) => focusL.delete(f) }, state: { doc: { toString: () => PLAIN } } };
  view.editorHost = { empty() {} };
  return { view, listeners, wsHandlers, requestMeasure, winL, focusL };
}

describe("viewport re-measure (mobile)", () => {
  it("visualViewport resize/scroll and workspace resize call requestMeasure", () => {
    const t = mkView({ remeasure: true });
    t.view.attachViewportListeners();
    expect(t.listeners.resize.size).toBe(1);
    expect(t.listeners.scroll.size).toBe(1);
    expect(t.wsHandlers.size).toBe(1);
    t.listeners.resize.forEach((f) => f());
    t.listeners.scroll.forEach((f) => f());
    t.wsHandlers.forEach((f) => f());
    expect(t.requestMeasure).toHaveBeenCalledTimes(3);
    // the document is untouched by resizes
    expect(t.view.editor.state.doc.toString()).toBe(PLAIN);
  });

  it("window resize, editor focus and the view's onResize also re-measure", () => {
    const t = mkView({ remeasure: true });
    t.view.attachViewportListeners();
    expect(t.winL.resize.size).toBe(1);
    expect(t.focusL.size).toBe(1);
    t.winL.resize.forEach((f) => f());
    t.focusL.forEach((f) => f());
    t.view.onResize();
    expect(t.requestMeasure).toHaveBeenCalledTimes(3);
    t.view.teardownEditor();
    expect(t.winL.resize.size).toBe(0);
    expect(t.focusL.size).toBe(0);
  });

  it("listeners are removed on teardown and not double-added", () => {
    const t = mkView({ remeasure: true });
    t.view.attachViewportListeners();
    t.view.attachViewportListeners();
    expect(t.listeners.resize.size).toBe(1);
    t.view.teardownEditor();
    expect(t.listeners.resize.size).toBe(0);
    expect(t.listeners.scroll.size).toBe(0);
    expect(t.wsHandlers.size).toBe(0);
  });

  it("desktop (flag off) attaches nothing", () => {
    const t = mkView({ remeasure: false });
    t.view.attachViewportListeners();
    expect(t.listeners.resize.size + t.listeners.scroll.size + t.wsHandlers.size).toBe(0);
  });
});

describe("the document is never truncated", () => {
  it("the editor state holds the full decrypted plaintext, and typing keeps all of it", async () => {
    const id = await generateIdentity();
    const ct = await encrypt([await identityToRecipient(id)], PLAIN);
    const plain = await decryptToString(id, ct);
    const st = EditorState.create({ doc: plain });
    expect(st.doc.toString()).toBe(PLAIN);
    expect(st.doc.lines).toBe(6);
    const typed = st.update({ changes: { from: st.doc.length, insert: " EDIT" } }).state;
    expect(typed.doc.toString()).toBe(PLAIN + " EDIT");
  });

  it("a save after typing writes the FULL text plus the edit", async () => {
    const id = await generateIdentity();
    const mine = await identityToRecipient(id);
    let disk = await encrypt([mine], PLAIN);
    const doc = EditorState.create({ doc: PLAIN }).update({
      changes: { from: 0, insert: "EDIT " },
    }).state.doc;
    const view = new (AgeFileView as unknown as new (l: unknown, d: unknown) => any)(
      {},
      {
        getKeySource: () => ({ getIdentity: async () => id, getRecipients: async () => [mine], isUnlocked: () => true, lock() {} }),
        updateStatusBar() {},
        clearStatusBar() {},
      }
    );
    view.app = {
      vault: {
        readBinary: async () => disk.slice().buffer,
        modifyBinary: async (_f: unknown, d: ArrayBuffer) => { disk = new Uint8Array(d); },
      },
    };
    view.file = { path: "n.age", name: "n.age" };
    view.editor = { state: { doc }, destroy() {} };
    view.editorHost = { empty() {}, createDiv: () => ({ createEl: () => ({ addEventListener() {} }) }) };
    view.dirty = true;
    await view.save("manual");
    expect(await decryptToString(id, disk)).toBe("EDIT " + PLAIN);
  });
});

describe("mobile layout: the editor does not clip", () => {
  const mkOpen = (mobile: boolean) => {
    const classes: string[] = [];
    const view = new (AgeFileView as unknown as new (l: unknown, d: unknown) => any)(
      {},
      { remeasureOnViewport: mobile, getKeySource: () => ({}), updateStatusBar() {}, clearStatusBar() {} }
    );
    view.app = { scope: {} };
    view.contentEl = { empty() {}, addClass: (c: string) => classes.push(c), createDiv: () => ({}) };
    return { view, classes };
  };

  it("onOpen adds the mobile class only on mobile", async () => {
    const m = mkOpen(true);
    await m.view.onOpen();
    expect(m.classes).toEqual(["halfday-age-view", "halfday-age-mobile"]);
    const d = mkOpen(false);
    await d.view.onOpen();
    expect(d.classes).toEqual(["halfday-age-view"]);
  });

  it("stylesheet: the mobile class makes the scroller non-clipping and the view the scroller; desktop rules are unchanged", () => {
    const css = fs.readFileSync("styles.css", "utf8");
    const rule = (sel: string): string => {
      const i = css.indexOf(sel + " {");
      expect(i, sel).toBeGreaterThanOrEqual(0);
      return css.slice(i, css.indexOf("}", i));
    };
    expect(rule(".halfday-age-view.halfday-age-mobile")).toMatch(/overflow-y:\s*auto/);
    expect(rule(".halfday-age-mobile .halfday-age-editor .cm-scroller")).toMatch(/overflow:\s*visible/);
    expect(rule(".halfday-age-mobile .halfday-age-editor .cm-scroller")).toMatch(/height:\s*auto/);
    expect(rule(".halfday-age-mobile .halfday-age-editor .cm-editor")).toMatch(/height:\s*auto/);
    expect(rule(".halfday-age-mobile .halfday-age-editor")).toMatch(/flex:\s*none/);
    // desktop: the original sizing is still there
    expect(css).toMatch(/\n\.halfday-age-editor \.cm-scroller \{\s*overflow:\s*auto/);
    expect(css).toMatch(/\n\.halfday-age-editor \.cm-editor \{\s*height:\s*100%/);
  });

  it("typing scrolls the caret into view on mobile (and not on desktop)", async () => {
    for (const mobile of [true, false]) {
      const m = mkOpen(mobile);
      const dispatch = vi.fn();
      const scrollIntoView = vi.fn();
      m.view.editor = {
        hasFocus: true,
        dispatch,
        state: { selection: { main: { head: 7 } } },
        dom: { querySelector: () => ({ scrollIntoView }) },
      };
      m.view.keepCaretVisible();
      await Promise.resolve();
      await Promise.resolve();
      if (mobile) {
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][0].effects).toBeTruthy();
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      } else {
        expect(dispatch).not.toHaveBeenCalled();
      }
    }
  });

  it("the editor update listener calls keepCaretVisible on doc and selection changes", () => {
    const src = fs.readFileSync("src/age-view.ts", "utf8");
    expect(src).toMatch(/update\.docChanged \|\| update\.selectionSet\) this\.keepCaretVisible\(\)/);
  });
});
