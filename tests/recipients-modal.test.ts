/**
 * ConfirmRecipientSetModal rendered against a small fake DOM (fix round 1,
 * F4/F5): Cancel is the default, closing means no, every list renders and
 * every key is labelled.
 */
import { describe, it, expect, vi } from "vitest";

interface FakeEl {
  tag: string;
  cls: string;
  text: string;
  children: FakeEl[];
  listeners: Record<string, () => void>;
  createEl(tag: string, o?: { text?: string; cls?: string }): FakeEl;
  createDiv(o?: { text?: string; cls?: string }): FakeEl;
  createSpan(o?: { text?: string; cls?: string }): FakeEl;
  setText(t: string): void;
  empty(): void;
  addEventListener(ev: string, cb: () => void): void;
}

function el(tag: string, o: { text?: string; cls?: string } = {}): FakeEl {
  const e: FakeEl = {
    tag,
    cls: o.cls ?? "",
    text: o.text ?? "",
    children: [],
    listeners: {},
    createEl(t, opt) {
      const c = el(t, opt);
      e.children.push(c);
      return c;
    },
    createDiv(opt) {
      return e.createEl("div", opt);
    },
    createSpan(opt) {
      return e.createEl("span", opt);
    },
    setText(t) {
      e.text = t;
    },
    empty() {
      e.children = [];
    },
    addEventListener(ev, cb) {
      e.listeners[ev] = cb;
    },
  };
  return e;
}

const all = (e: FakeEl): FakeEl[] => [e, ...e.children.flatMap(all)];
/** Each paragraph / key row as one line of text. */
const lines = (e: FakeEl): string[] =>
  all(e)
    .filter((x) => x.tag === "p" || x.cls === "halfday-rune-key-row" || x.tag === "h2")
    .map((x) => x.text + x.children.map((c) => c.text).join(""));

vi.mock("obsidian", () => ({
  App: class {},
  Modal: class {
    contentEl = el("div");
    open() {
      (this as unknown as { onOpen(): void }).onOpen();
    }
    close() {
      (this as unknown as { onClose(): void }).onClose();
    }
  },
}));

import { ConfirmRecipientSetModal, type RecipientSetPrompt } from "../src/recipients-modal";

const OWN = "age1" + "o".repeat(58);
const OTHER = "age1" + "x".repeat(58);
const NEW = "age1" + "n".repeat(58);
const GONE = "age1" + "g".repeat(58);

function open(p: Partial<RecipientSetPrompt> = {}) {
  const done = vi.fn();
  const m = new ConfirmRecipientSetModal(
    {} as never,
    { recipients: [NEW, OTHER, OWN], own: OWN, fingerprint: "f".repeat(64), diff: null, ...p },
    done
  ) as unknown as { contentEl: FakeEl; open(): void; close(): void };
  m.open();
  const root = m.contentEl;
  const buttons = all(root).filter((x) => x.tag === "button");
  return { m, done, root, buttons };
}

describe("ConfirmRecipientSetModal", () => {
  it("Cancel is the default (mod-cta) button and resolves false", () => {
    const { buttons, done } = open();
    const cancel = buttons.find((b) => b.text === "Cancel")!;
    expect(cancel.cls).toBe("mod-cta");
    expect(buttons.find((b) => b.text === "These are my keys")!.cls).not.toContain("mod-cta");
    cancel.listeners.click();
    expect(done).toHaveBeenCalledWith(false);
  });

  it("closing (Esc, click outside) resolves false", () => {
    const { m, done } = open();
    m.close();
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(false);
  });

  it("confirming resolves true exactly once", () => {
    const { buttons, done } = open();
    buttons.find((b) => b.text === "These are my keys")!.listeners.click();
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(true);
  });

  it("renders the added list, the removed list and the full set, with count and fingerprint", () => {
    const { root } = open({ diff: { added: [NEW], removed: [GONE] } });
    const l = lines(root);
    const at = (s: string) => l.indexOf(s);
    expect(l.some((x) => x.includes("these 3 keys") && x.includes("f".repeat(64)))).toBe(true);
    expect(at("New since you last confirmed:")).toBeGreaterThan(-1);
    expect(l[at("New since you last confirmed:") + 1]).toBe(`other key: ${NEW}`);
    expect(l[at("Removed since you last confirmed:") + 1]).toBe(`other key: ${GONE}`);
    const full = l.slice(at("The full set:") + 1, at("The full set:") + 4);
    expect(full).toEqual([`other key: ${NEW}`, `other key: ${OTHER}`, `your key: ${OWN}`]);
  });

  it("F5: labels the own key and marks every other key, on first use too", () => {
    const { root } = open({ note: "rune has no confirmed recipient set yet." });
    const spans = all(root).filter((x) => x.cls === "halfday-rune-key-own" || x.cls === "halfday-rune-key-other");
    expect(spans.map((s) => s.text)).toEqual(["other key: ", "other key: ", "your key: "]);
    const keys = all(root).filter((x) => x.cls === "halfday-rune-key");
    expect(keys.map((k) => k.text)).toEqual([NEW, OTHER, OWN]); // whole keys, never cut
  });

  it("no diff: no added / removed headings", () => {
    const { root } = open();
    const l = lines(root);
    expect(l).not.toContain("New since you last confirmed:");
    expect(l).not.toContain("Removed since you last confirmed:");
  });
});

describe("key rows wrap (F5)", () => {
  it("styles.css wraps the key text so a whole key shows on a phone", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const rule = css.match(/\.halfday-rune-key\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/white-space:\s*pre-wrap/);
    expect(rule).toMatch(/word-break:\s*break-all/);
  });
});
