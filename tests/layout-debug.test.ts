import { describe, it, expect } from "vitest";
import { collectLayoutDebug, appendCapped, LAYOUT_DEBUG, type ElLike } from "../src/layout-debug";

const SECRET = "SECRET-paragraph-text-xyz";

function el(over: Partial<ElLike> & { cls?: string } = {}): ElLike {
  // hostile: every text-ish property carries the plaintext
  return Object.assign(
    {
      className: over.cls ?? "box",
      clientHeight: 100,
      scrollHeight: 400,
      scrollTop: 3,
      offsetTop: 12,
      offsetHeight: 24,
      getBoundingClientRect: () => ({ top: 10, left: 0, width: 300, height: 100 }),
      textContent: SECRET,
      innerText: SECRET,
      innerHTML: SECRET,
    },
    over
  ) as ElLike;
}

describe("layout debug output", () => {
  it("is off unless the build constant is defined true", () => {
    expect(LAYOUT_DEBUG).toBe(false);
  });

  it("contains geometry and class names but none of the plaintext", () => {
    const lines = [el({ cls: "cm-line halfday-md-h1" }), el({ cls: "cm-line" }), el({ cls: "cm-line cm-activeLine" })];
    const out = collectLayoutDebug({
      host: el(),
      viewContent: el({ cls: "view-content" }),
      editorDom: el(),
      scroller: el(),
      content: el(),
      view: {
        viewport: { from: 0, to: 40 },
        visibleRanges: [{ from: 0, to: 40 }],
        contentHeight: 480,
        state: { doc: { lines: 6 } },
      },
      lines,
      visualViewport: { width: 390, height: 420, offsetTop: 0 },
      innerHeight: 844,
      label: "editor focus +300ms",
      time: "2026-10-04T10:00:00.000Z",
      outerHeight: 852,
      docClientHeight: 420,
      bodyClasses: "is-mobile is-ios keyboard-open",
      contentIsActive: true,
      getComputedStyle: () => ({
        getPropertyValue: (p: string) => (p === "color" ? "rgb(220, 221, 222)" : p === "opacity" ? "1" : "visible"),
      }),
    });
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("paragraph");
    for (const want of [
      "visualViewport w=390 h=420 offsetTop=0",
      "window.innerHeight=844",
      "window.outerHeight=852 documentElement.clientHeight=420",
      "body.classes=[is-mobile is-ios keyboard-open]",
      "cm-content is document.activeElement=yes",
      "## editor focus +300ms @ 2026-10-04T10:00:00.000Z",
      ".cm-scroller:",
      "view-content:",
      "scrollHeight=400",
      "cm viewport=0-40 contentHeight=480 doc.lines=6",
      "rendered .cm-line count=3",
      "line 2:",
      "color=rgb(220, 221, 222)",
      "classes=[cm-line halfday-md-h1]",
    ]) {
      expect(out, want).toContain(want);
    }
  });
});

describe("appendCapped", () => {
  it("appends sections under one title and keeps the newest when over the cap", () => {
    let f = "";
    for (let i = 0; i < 50; i++) f = appendCapped(f, `## trigger ${i} @ t\n${"x".repeat(100)}\n`, 1000);
    expect(f.startsWith("# rune layout debug")).toBe(true);
    expect(f.length).toBeLessThanOrEqual(1000);
    expect(f).toContain("## trigger 49 @ t");
    expect(f).not.toContain("## trigger 0 @ t");
    expect(f.match(/# rune layout debug/g)).toHaveLength(1);
    const small = appendCapped(appendCapped("", "## a\n"), "## b\n");
    expect(small).toContain("## a");
    expect(small).toContain("## b");
  });
});
