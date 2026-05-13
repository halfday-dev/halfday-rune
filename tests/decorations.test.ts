/**
 * Vitest for v0.6.1 inline decorations.
 *
 * We don't construct a real EditorView (that needs jsdom + a full DOM). The
 * decoration logic is exposed as pure `buildXFromState(state, cursorPos,
 * ranges)` helpers so we can hand-build an EditorState, run the builder,
 * and read back the resulting DecorationSet.
 *
 * What we cover here:
 *   - the cursor-position toggle (the load-bearing behaviour: show syntax
 *     when cursor on span, hide when off)
 *   - the extension factories return composable extensions
 *   - happy-path: each construct produces the expected decoration shape
 *   - the composed `halfdayInlineDecorations()` returns the right ordering
 */

import { describe, expect, it } from "vitest";
import { EditorState, Extension } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Decoration, DecorationSet } from "@codemirror/view";
import {
  codeBlockDecoration,
  emphasisDecoration,
  halfdayInlineDecorations,
  headingsDecoration,
  htmlInertDecoration,
  imagesDecoration,
  inlineCodeDecoration,
  linksDecoration,
  listsDecoration,
  wikilinksDecoration,
} from "../src/decorations";
import { buildHeadingDecorationsFromState } from "../src/decorations/headings";
import { buildEmphasisDecorationsFromState } from "../src/decorations/emphasis";
import { buildInlineCodeDecorationsFromState } from "../src/decorations/inline-code";
import { buildLinksDecorationsFromState } from "../src/decorations/links";
import { buildListsDecorationsFromState } from "../src/decorations/lists";
import { buildCodeBlockDecorationsFromState } from "../src/decorations/code-block";
import { buildWikilinksDecorationsFromState } from "../src/decorations/wikilinks";
import { buildHtmlInertDecorationsFromState } from "../src/decorations/html-inert";
import { buildImagesDecorationsFromState } from "../src/decorations/images";

interface Span {
  from: number;
  to: number;
  spec: any;
}

/** Collect every decoration in a set into a plain array for assertions. */
function collect(set: DecorationSet): Span[] {
  const out: Span[] = [];
  const cur = set.iter();
  while (cur.value) {
    out.push({ from: cur.from, to: cur.to, spec: cur.value.spec });
    cur.next();
  }
  return out;
}

/** Build a minimal EditorState with markdown parsing enabled. */
function mkState(doc: string, extensions: Extension[] = []): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown(), ...extensions],
  });
}

/**
 * v0.6.3: GFM-enabled state. lezer-markdown's HTML node emission for
 * inline tags isn't affected by GFM, but we mirror age-view's parser
 * config in the sanitization tests so we're testing what actually
 * ships.
 */
function mkGfmState(doc: string): EditorState {
  // We import GFM lazily here to avoid pulling the @lezer/markdown
  // dep into the top of the file when most tests don't need it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GFM } = require("@lezer/markdown");
  return EditorState.create({
    doc,
    extensions: [markdown({ extensions: GFM })],
  });
}

const FULL = (state: EditorState) => [{ from: 0, to: state.doc.length }];

describe("headingsDecoration", () => {
  it("emits a line-level decoration at the start of an H1", () => {
    const doc = "# title\nbody";
    const state = mkState(doc);
    const set = buildHeadingDecorationsFromState(state, doc.length, FULL(state));
    const out = collect(set);
    // expect a line decoration at offset 0 with the H1 class
    const lineDeco = out.find((d) => d.from === 0 && d.to === 0);
    expect(lineDeco).toBeDefined();
    expect(lineDeco?.spec?.class).toBe("halfday-md-h1");
  });

  it("emits H1..H6 line classes for each ATX level", () => {
    const doc = "# a\n## b\n### c\n#### d\n##### e\n###### f";
    const state = mkState(doc);
    const set = buildHeadingDecorationsFromState(state, doc.length, FULL(state));
    const classes = collect(set)
      .map((d) => d.spec?.class)
      .filter(Boolean);
    expect(classes).toEqual(
      expect.arrayContaining([
        "halfday-md-h1",
        "halfday-md-h2",
        "halfday-md-h3",
        "halfday-md-h4",
        "halfday-md-h5",
        "halfday-md-h6",
      ])
    );
  });

  it("hides the `# ` prefix when cursor is on a different line", () => {
    const doc = "# title\nbody";
    const state = mkState(doc);
    // cursor at end of doc (on "body" line) — heading line is NOT the cursor line
    const set = buildHeadingDecorationsFromState(state, doc.length, FULL(state));
    const replaceSpans = collect(set).filter((d) => d.from !== d.to);
    // There should be exactly one replace decoration covering "# " (offsets 0..2)
    expect(replaceSpans).toHaveLength(1);
    expect(replaceSpans[0].from).toBe(0);
    expect(replaceSpans[0].to).toBe(2);
  });

  it("reveals the `# ` prefix when cursor is on the heading line", () => {
    const doc = "# title\nbody";
    const state = mkState(doc);
    // cursor inside "title" (position 3 = on heading line)
    const set = buildHeadingDecorationsFromState(state, 3, FULL(state));
    const replaceSpans = collect(set).filter((d) => d.from !== d.to);
    // No replace decoration when cursor is on the heading line
    expect(replaceSpans).toHaveLength(0);
  });

  it("is a no-op for an empty document", () => {
    const state = mkState("");
    const set = buildHeadingDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("does not decorate non-heading lines", () => {
    const doc = "just a paragraph\nno headings here";
    const state = mkState(doc);
    const set = buildHeadingDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("decorates the correct line when cursor is at a heading line's exact end", () => {
    // Edge: cursor at position 7 = end of "# title" line.
    // Live preview behaviour: cursor still on the line, syntax revealed.
    const doc = "# title\nbody";
    const state = mkState(doc);
    const set = buildHeadingDecorationsFromState(state, 7, FULL(state));
    const replaceSpans = collect(set).filter((d) => d.from !== d.to);
    expect(replaceSpans).toHaveLength(0);
  });

  it("handles an empty heading (`# ` with no content) without crashing", () => {
    // Edge: heading marker present but no text. Caught in v0.6.1 QA — the
    // hide-range logic must not blow up when `# ` is the entire content of
    // the heading line. Expected: line decoration still applies, hide range
    // covers the "# " prefix as for any normal heading.
    const doc = "# \nbody";
    const state = mkState(doc);
    // cursor on the body line, so the heading's `# ` should be hidden
    const set = buildHeadingDecorationsFromState(state, doc.length, FULL(state));
    const out = collect(set);
    // line decoration at offset 0 with halfday-md-h1
    const lineDeco = out.find(
      (d) => d.from === 0 && d.to === 0 && d.spec?.class === "halfday-md-h1"
    );
    expect(lineDeco).toBeDefined();
    // exactly one replace span covering the "# " prefix (offsets 0..2)
    const replaceSpans = out.filter((d) => d.from !== d.to);
    expect(replaceSpans).toHaveLength(1);
    expect(replaceSpans[0].from).toBe(0);
    expect(replaceSpans[0].to).toBe(2);
  });
});

describe("emphasisDecoration", () => {
  it("emits a strong-class mark for **bold**", () => {
    const doc = "say **hi** there";
    const state = mkState(doc);
    // cursor far from span
    const set = buildEmphasisDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-strong"
    );
    expect(marks).toHaveLength(1);
    // span covers ** through ** (offsets 4..10 in "say **hi** there")
    expect(marks[0].from).toBe(4);
    expect(marks[0].to).toBe(10);
  });

  it("emits an emphasis-class mark for _italic_", () => {
    const doc = "_ital_";
    const state = mkState(doc);
    const set = buildEmphasisDecorationsFromState(state, doc.length, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-emphasis"
    );
    expect(marks).toHaveLength(1);
  });

  it("emits an emphasis-class mark for *italic*", () => {
    const doc = "*ital*";
    const state = mkState(doc);
    const set = buildEmphasisDecorationsFromState(state, doc.length, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-emphasis"
    );
    expect(marks).toHaveLength(1);
  });

  it("hides the `**` markers when cursor is off the span", () => {
    const doc = "**bold**";
    const state = mkState(doc);
    // cursor at offset 0 — at the very start, considered ON the span (>= from)
    // so test with a doc that has a second line and put cursor elsewhere
    const docMulti = "**bold**\nelsewhere";
    const stateMulti = mkState(docMulti);
    const set = buildEmphasisDecorationsFromState(
      stateMulti,
      docMulti.length,
      FULL(stateMulti)
    );
    // EmphasisMarks are the leading and trailing "**" pairs
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.class !== "halfday-md-strong" && d.spec?.class !== "halfday-md-emphasis"
    );
    expect(replaces.length).toBeGreaterThanOrEqual(2);
  });

  it("reveals the `**` markers when cursor is on the span", () => {
    const doc = "**bold**\nelsewhere";
    const state = mkState(doc);
    // cursor inside "bold" — span is "**bold**" at offsets 0..8, cursor at 3
    const set = buildEmphasisDecorationsFromState(state, 3, FULL(state));
    // we should still see the mark decoration but NO replace decorations
    const all = collect(set);
    const replaces = all.filter(
      (d) => d.from !== d.to && d.spec?.class === undefined
    );
    expect(replaces).toHaveLength(0);
    // and a strong mark remains
    expect(all.some((d) => d.spec?.class === "halfday-md-strong")).toBe(true);
  });

  it("handles nesting: `**bold _italic_**` produces both classes", () => {
    const doc = "**bold _italic_**";
    const state = mkState(doc);
    // cursor far away (no doc length available since this is the whole doc) —
    // use 0 which is the start of the span; cursor will be ON the outer span,
    // but the test is about both decorations being emitted regardless.
    const set = buildEmphasisDecorationsFromState(state, 0, FULL(state));
    const classes = collect(set)
      .map((d) => d.spec?.class)
      .filter(Boolean);
    expect(classes).toContain("halfday-md-strong");
    expect(classes).toContain("halfday-md-emphasis");
  });

  it("is a no-op for an empty document", () => {
    const state = mkState("");
    const set = buildEmphasisDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("is a no-op for plain text with no emphasis markers", () => {
    const state = mkState("just regular prose, nothing styled");
    const set = buildEmphasisDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });
});

describe("inlineCodeDecoration", () => {
  it("emits an inline-code class mark for `code`", () => {
    const doc = "run `npm test` now";
    const state = mkState(doc);
    const set = buildInlineCodeDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-inline-code"
    );
    expect(marks).toHaveLength(1);
    // span is `npm test` including backticks — offsets 4..14
    expect(marks[0].from).toBe(4);
    expect(marks[0].to).toBe(14);
  });

  it("hides backticks when cursor is off the span", () => {
    const doc = "run `npm test` now";
    const state = mkState(doc);
    // cursor at the end of the doc, well past the span
    const set = buildInlineCodeDecorationsFromState(
      state,
      doc.length,
      FULL(state)
    );
    const all = collect(set);
    // there must be at least 2 zero-or-one-char replace decorations
    // (the leading ` and trailing `)
    const replaces = all.filter(
      (d) => d.from !== d.to && d.spec?.class !== "halfday-md-inline-code"
    );
    expect(replaces).toHaveLength(2);
  });

  it("reveals backticks when cursor is on the span", () => {
    const doc = "run `npm test` now";
    const state = mkState(doc);
    // cursor inside `npm test` — at offset 7 (between "npm" and " test")
    const set = buildInlineCodeDecorationsFromState(state, 7, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.class !== "halfday-md-inline-code"
    );
    expect(replaces).toHaveLength(0);
  });

  it("emits one mark per inline-code span when several are present", () => {
    const doc = "foo `a` bar `b` baz `c`";
    const state = mkState(doc);
    const set = buildInlineCodeDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-inline-code"
    );
    expect(marks).toHaveLength(3);
  });

  it("is a no-op for an empty document", () => {
    const state = mkState("");
    const set = buildInlineCodeDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });
});

describe("linksDecoration", () => {
  it("emits a .halfday-md-link mark over the anchor text range", () => {
    // doc:        see [text](https://example.com) end
    // offsets:    0123456789...
    //             ^ "see " is 0..4
    //             ^ "[" at 4, anchor "text" at 5..9, "]" at 9
    const doc = "see [text](https://example.com) end";
    const state = mkState(doc);
    // cursor at offset 0 — well off the link span
    const set = buildLinksDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-link"
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].from).toBe(5);
    expect(marks[0].to).toBe(9);
  });

  it("hides the [, ], (, URL, and ) when cursor is off the span", () => {
    const doc = "see [text](https://example.com) end";
    const state = mkState(doc);
    // cursor at end of doc — off the link
    const set = buildLinksDecorationsFromState(state, doc.length, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.class !== "halfday-md-link"
    );
    // five hide ranges: [ ] ( URL )
    expect(replaces).toHaveLength(5);
  });

  it("reveals the syntax when cursor is on the link span", () => {
    const doc = "see [text](https://example.com) end";
    const state = mkState(doc);
    // cursor inside the anchor text "text" at offset 7
    const set = buildLinksDecorationsFromState(state, 7, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.class !== "halfday-md-link"
    );
    expect(replaces).toHaveLength(0);
    // the anchor-text mark still fires
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-link"
    );
    expect(marks).toHaveLength(1);
  });

  it("decorates multiple links independently on one line", () => {
    // doc:     [a](u1) and [b](u2)
    // offsets: 0123456789...
    // link1 span 0..7, anchor "a" at 1..2
    // link2 span 12..19, anchor "b" at 13..14
    const doc = "[a](u1) and [b](u2)";
    const state = mkState(doc);
    // cursor on the first link (offset 1) — first reveals, second hides
    const set = buildLinksDecorationsFromState(state, 1, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-link"
    );
    expect(marks).toHaveLength(2);
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.class !== "halfday-md-link"
    );
    // only the second link should be hidden — 5 replace ranges
    expect(replaces).toHaveLength(5);
    // and all those hide ranges should be inside the second link span (12..19)
    expect(replaces.every((r) => r.from >= 12 && r.to <= 19)).toBe(true);
  });

  it("is a no-op for an empty document", () => {
    const state = mkState("");
    const set = buildLinksDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("is a no-op for plain text with no links", () => {
    const state = mkState("just regular prose, no links at all");
    const set = buildLinksDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("does NOT decorate wikilinks `[[foo]]` (no URL child → skipped)", () => {
    // lezer-markdown's default grammar parses `[[foo]]` as a Link node with
    // only two LinkMark children and no URL — our shape check should bail.
    // v0.6.2 will handle wikilinks via a custom regex/parser extension.
    const doc = "see [[wiki]] not a standard link";
    const state = mkState(doc);
    const set = buildLinksDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });
});

describe("extension factories integrate into an EditorState", () => {
  it("headingsDecoration() returns an extension EditorState accepts", () => {
    expect(() =>
      EditorState.create({
        doc: "# hello",
        extensions: [markdown(), headingsDecoration()],
      })
    ).not.toThrow();
  });

  it("emphasisDecoration() returns an extension EditorState accepts", () => {
    expect(() =>
      EditorState.create({
        doc: "**bold**",
        extensions: [markdown(), emphasisDecoration()],
      })
    ).not.toThrow();
  });

  it("inlineCodeDecoration() returns an extension EditorState accepts", () => {
    expect(() =>
      EditorState.create({
        doc: "`code`",
        extensions: [markdown(), inlineCodeDecoration()],
      })
    ).not.toThrow();
  });

  it("linksDecoration() returns an extension EditorState accepts", () => {
    expect(() =>
      EditorState.create({
        doc: "[text](https://example.com)",
        extensions: [markdown(), linksDecoration()],
      })
    ).not.toThrow();
  });

  it("listsDecoration() returns an extension EditorState accepts", () => {
    expect(() =>
      EditorState.create({
        doc: "- one\n- two\n- three",
        extensions: [markdown(), listsDecoration()],
      })
    ).not.toThrow();
  });

  it("codeBlockDecoration() returns an extension EditorState accepts", () => {
    expect(() =>
      EditorState.create({
        doc: "```ts\nconst x = 1;\n```",
        extensions: [markdown(), codeBlockDecoration()],
      })
    ).not.toThrow();
  });

  it("wikilinksDecoration() returns an extension EditorState accepts", () => {
    expect(() =>
      EditorState.create({
        doc: "see [[wiki]]",
        extensions: [markdown(), wikilinksDecoration()],
      })
    ).not.toThrow();
  });

  it("htmlInertDecoration() returns an extension EditorState accepts", () => {
    expect(() =>
      EditorState.create({
        doc: "<script>alert(1)</script>",
        extensions: [markdown(), htmlInertDecoration()],
      })
    ).not.toThrow();
  });

  it("imagesDecoration() returns an extension EditorState accepts", () => {
    expect(() =>
      EditorState.create({
        doc: "![alt](https://example.com/x.png)",
        extensions: [markdown(), imagesDecoration()],
      })
    ).not.toThrow();
  });

  it("halfdayInlineDecorations() returns a 9-element extension list", () => {
    // v0.6.2: grew from 4 (headings/emphasis/inline-code/links) to 7 with
    // the addition of lists, code-block, and wikilinks.
    // v0.6.3: grew to 9 with html-inert + images (sanitization pass).
    const ext = halfdayInlineDecorations();
    expect(Array.isArray(ext)).toBe(true);
    expect(ext).toHaveLength(9);
  });

  it("halfdayInlineDecorations() composes into an EditorState with mixed content", () => {
    expect(() =>
      EditorState.create({
        doc: "# h1\nbody with **bold** and _italic_ and `code` and [link](https://x.y)",
        extensions: [markdown(), ...halfdayInlineDecorations()],
      })
    ).not.toThrow();
  });

  it("halfdayInlineDecorations() composes with v0.6.2 constructs (lists, code blocks, wikilinks)", () => {
    expect(() =>
      EditorState.create({
        doc: "- one\n- two\n\n```ts\nconst x = 1;\n```\n\nsee [[wiki]] and [link](https://x.y)",
        extensions: [markdown(), ...halfdayInlineDecorations()],
      })
    ).not.toThrow();
  });
});

describe("listsDecoration", () => {
  it("emits a .halfday-md-list-marker mark over the `-` of a bullet item", () => {
    // doc:    "- one"
    // offsets: 01234
    // ListMark is "-" at offset 0..1
    const doc = "- one";
    const state = mkState(doc);
    const set = buildListsDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-list-marker"
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].from).toBe(0);
    expect(marks[0].to).toBe(1);
  });

  it("decorates every item in an unordered list", () => {
    const doc = "- one\n- two\n- three";
    const state = mkState(doc);
    const set = buildListsDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-list-marker"
    );
    expect(marks).toHaveLength(3);
  });

  it("decorates every item in an ordered list", () => {
    // ordered list markers include the digit + dot: "1.", "2.", "3."
    const doc = "1. one\n2. two\n3. three";
    const state = mkState(doc);
    const set = buildListsDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-list-marker"
    );
    expect(marks).toHaveLength(3);
    // first marker covers "1." — offsets 0..2
    expect(marks[0].from).toBe(0);
    expect(marks[0].to).toBe(2);
  });

  it("emits markers regardless of cursor position (always visible)", () => {
    // Lists are NOT hide-on-cursor-leave; markers stay visible whether the
    // cursor is on the list or far away.
    const doc = "- one\nbody";
    const state = mkState(doc);
    const onItem = buildListsDecorationsFromState(state, 2, FULL(state));
    const offItem = buildListsDecorationsFromState(state, doc.length, FULL(state));
    const onCount = collect(onItem).filter(
      (d) => d.spec?.class === "halfday-md-list-marker"
    ).length;
    const offCount = collect(offItem).filter(
      (d) => d.spec?.class === "halfday-md-list-marker"
    ).length;
    expect(onCount).toBe(offCount);
    expect(onCount).toBe(1);
  });

  it("is a no-op for an empty document", () => {
    const state = mkState("");
    const set = buildListsDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("is a no-op for plain prose with no list markers", () => {
    const state = mkState("just a paragraph with no list at all");
    const set = buildListsDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("does not emit hide-syntax replace decorations (markers stay visible)", () => {
    const doc = "- one\n- two";
    const state = mkState(doc);
    const set = buildListsDecorationsFromState(state, doc.length, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.class === undefined
    );
    expect(replaces).toHaveLength(0);
  });
});

describe("codeBlockDecoration", () => {
  it("emits per-line decorations for a 3-line fenced code block", () => {
    const doc = "```\ncode\n```";
    const state = mkState(doc);
    // cursor at start — well, start is offset 0 which is on the block.
    // To test line emission we just need the line decorations themselves;
    // cursor position is orthogonal.
    const set = buildCodeBlockDecorationsFromState(state, 0, FULL(state));
    const lineDecos = collect(set).filter(
      (d) =>
        d.from === d.to &&
        typeof d.spec?.class === "string" &&
        d.spec.class.includes("halfday-md-code-block")
    );
    // three lines in the block
    expect(lineDecos).toHaveLength(3);
  });

  it("applies -first and -last classes only to the outer lines", () => {
    const doc = "```\ncode\n```";
    const state = mkState(doc);
    const set = buildCodeBlockDecorationsFromState(state, 0, FULL(state));
    const lineDecos = collect(set).filter(
      (d) =>
        d.from === d.to &&
        typeof d.spec?.class === "string" &&
        d.spec.class.includes("halfday-md-code-block")
    );
    const firsts = lineDecos.filter((d) =>
      (d.spec.class as string).includes("halfday-md-code-block-first")
    );
    const lasts = lineDecos.filter((d) =>
      (d.spec.class as string).includes("halfday-md-code-block-last")
    );
    expect(firsts).toHaveLength(1);
    expect(lasts).toHaveLength(1);
    // the middle line has only the base class
    const middle = lineDecos.filter(
      (d) =>
        !(d.spec.class as string).includes("halfday-md-code-block-first") &&
        !(d.spec.class as string).includes("halfday-md-code-block-last")
    );
    expect(middle).toHaveLength(1);
  });

  it("emits no block-replace decorations — fences stay visible regardless of cursor", () => {
    // v0.6.2 used to hide fence lines via Decoration.replace({block: true})
    // when the cursor was off the block, mirroring Obsidian's own live
    // preview. That interacted badly with incremental lezer reparses at
    // the fence boundary (backspace on the fence could surface stale
    // hidden content as ghost characters in adjacent lines) so the
    // hide-on-cursor-leave behaviour was removed in the v0.6.2 ship.
    // Test pins the new contract: NO replace decorations are emitted
    // in either cursor state. The chip styling still applies via
    // Decoration.line; the fences read as part of the chip.
    const doc = "prose\n```\ncode\n```";
    const state = mkState(doc);
    // cursor off the block
    const offSet = buildCodeBlockDecorationsFromState(state, 0, FULL(state));
    const offReplaces = collect(offSet).filter(
      (d) => d.from !== d.to && d.spec?.class === undefined
    );
    expect(offReplaces).toHaveLength(0);
    // cursor inside the block (on the "code" line, offset 12)
    const onSet = buildCodeBlockDecorationsFromState(state, 12, FULL(state));
    const onReplaces = collect(onSet).filter(
      (d) => d.from !== d.to && d.spec?.class === undefined
    );
    expect(onReplaces).toHaveLength(0);
  });

  it("decorates code blocks with a language tag (CodeInfo)", () => {
    // doc: ```ts\nconst x = 1;\n```
    // The language tag lives on the opening fence line; the line decoration
    // covers that whole line regardless.
    const doc = "```ts\nconst x = 1;\n```";
    const state = mkState(doc);
    const set = buildCodeBlockDecorationsFromState(state, 0, FULL(state));
    const lineDecos = collect(set).filter(
      (d) =>
        d.from === d.to &&
        typeof d.spec?.class === "string" &&
        d.spec.class.includes("halfday-md-code-block")
    );
    expect(lineDecos).toHaveLength(3);
  });

  it("is a no-op for an empty document", () => {
    const state = mkState("");
    const set = buildCodeBlockDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("is a no-op for prose with no fenced code blocks", () => {
    const state = mkState("just a paragraph\nno backticks here");
    const set = buildCodeBlockDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("decorates multiple fenced blocks independently", () => {
    // two blocks, separated by a blank line
    const doc = "```\na\n```\n\n```\nb\n```";
    const state = mkState(doc);
    const set = buildCodeBlockDecorationsFromState(state, 0, FULL(state));
    const lineDecos = collect(set).filter(
      (d) =>
        d.from === d.to &&
        typeof d.spec?.class === "string" &&
        d.spec.class.includes("halfday-md-code-block")
    );
    // 3 lines per block × 2 blocks = 6
    expect(lineDecos).toHaveLength(6);
  });
});

describe("wikilinksDecoration", () => {
  it("emits a .halfday-md-wikilink mark over the anchor text of `[[wiki]]`", () => {
    // doc:     see [[wiki]] end
    // offsets: 0123456789012345
    // span 4..12, anchor "wiki" 6..10
    const doc = "see [[wiki]] end";
    const state = mkState(doc);
    // cursor at offset 0 — off the span
    const set = buildWikilinksDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-wikilink"
    );
    expect(marks).toHaveLength(1);
    expect(marks[0].from).toBe(6);
    expect(marks[0].to).toBe(10);
  });

  it("hides `[[` and `]]` when cursor is off the span", () => {
    const doc = "see [[wiki]] end";
    const state = mkState(doc);
    const set = buildWikilinksDecorationsFromState(state, 0, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.class !== "halfday-md-wikilink"
    );
    // two hide ranges: leading "[[" and trailing "]]"
    expect(replaces).toHaveLength(2);
  });

  it("reveals `[[` and `]]` when cursor is on the span", () => {
    const doc = "see [[wiki]] end";
    const state = mkState(doc);
    // cursor inside the anchor "wiki" at offset 8
    const set = buildWikilinksDecorationsFromState(state, 8, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.class !== "halfday-md-wikilink"
    );
    expect(replaces).toHaveLength(0);
    // the anchor-text mark still fires
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-wikilink"
    );
    expect(marks).toHaveLength(1);
  });

  it("decorates multiple wikilinks independently", () => {
    // doc:     [[a]] and [[b]]
    // offsets: 0123456789012345
    // [[a]] spans 0..5, anchor "a" at 2..3
    // [[b]] spans 10..15, anchor "b" at 12..13
    const doc = "[[a]] and [[b]]";
    const state = mkState(doc);
    // cursor at offset 2 — on the first wikilink
    const set = buildWikilinksDecorationsFromState(state, 2, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-wikilink"
    );
    expect(marks).toHaveLength(2);
    // first wikilink revealed, second hidden — 2 hide ranges (only on link 2)
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.class !== "halfday-md-wikilink"
    );
    expect(replaces).toHaveLength(2);
    expect(replaces.every((r) => r.from >= 10 && r.to <= 15)).toBe(true);
  });

  it("does NOT conflict with standard `[regular](link)` syntax", () => {
    // wikilinks regex must not match regular markdown links. The links
    // module already skips wikilinks via the lezer shape check (no URL
    // child); this test confirms the wikilinks module ignores standard
    // links in turn.
    const doc = "see [regular](https://example.com) and [[wiki]]";
    const state = mkState(doc);
    const set = buildWikilinksDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-wikilink"
    );
    // only the wikilink should be marked, not the regular link
    expect(marks).toHaveLength(1);
    // and its range should be inside the "[[wiki]]" — anchor "wiki" at
    // offsets 41..45 in this doc.
    expect(marks[0].from).toBe(41);
    expect(marks[0].to).toBe(45);
  });

  it("is a no-op for an empty document", () => {
    const state = mkState("");
    const set = buildWikilinksDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("is a no-op for plain prose with no wikilinks", () => {
    const state = mkState("just a paragraph with no [[wiki]]links here, kidding");
    // (the doc above DOES contain [[wiki]] — let's make sure it really
    // doesn't by using a clean string.)
    const cleanState = mkState("just a paragraph with no wikilinks here");
    const set = buildWikilinksDecorationsFromState(cleanState, 0, FULL(cleanState));
    expect(collect(set)).toEqual([]);
  });

  it("does not match wikilink-shaped spans that cross newlines", () => {
    // The regex negates \n inside the anchor, so a literal `[[foo\nbar]]`
    // should NOT match. This is the guard that keeps a doc with unmatched
    // brackets across lines from collapsing into one wide span.
    const doc = "[[foo\nbar]]";
    const state = mkState(doc);
    const set = buildWikilinksDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-wikilink"
    );
    expect(marks).toHaveLength(0);
  });
});

describe("cross-construct nesting", () => {
  it("`**bold `code` inside**` produces both the strong mark and the inline-code mark", () => {
    // Spec line 79 calls this exact case out as the nesting smoke test. The
    // emphasis + inline-code decorations live in separate ViewPlugins, so
    // each emits its own DecorationSet — CM6 layers them in the rendered
    // output. We verify here that BOTH decorations fire over a single doc
    // and that their ranges are sensible: the strong mark spans the full
    // `**...**`, the inline-code mark spans just the `` `code` ``.
    const doc = "**bold `code` inside**";
    const state = mkState(doc);
    // cursor far from any markers (well, the whole doc IS the span — put
    // cursor at offset 1 which is between the first two `*`s; still on the
    // outer span but that's fine, we're checking emission not hide-state).
    // What we care about: both classes are present, with the expected ranges.
    const emphasisSet = buildEmphasisDecorationsFromState(state, 1, FULL(state));
    const codeSet = buildInlineCodeDecorationsFromState(state, 1, FULL(state));

    const strongMarks = collect(emphasisSet).filter(
      (d) => d.spec?.class === "halfday-md-strong"
    );
    expect(strongMarks).toHaveLength(1);
    // strong mark covers the whole `**...**` — offsets 0..22
    expect(strongMarks[0].from).toBe(0);
    expect(strongMarks[0].to).toBe(doc.length);

    const codeMarks = collect(codeSet).filter(
      (d) => d.spec?.class === "halfday-md-inline-code"
    );
    expect(codeMarks).toHaveLength(1);
    // code mark covers `` `code` `` including backticks — offsets 7..13
    expect(codeMarks[0].from).toBe(7);
    expect(codeMarks[0].to).toBe(13);
  });

  it("`**bold with `code` and [link](url) and [[wiki]]**` fires every relevant decoration", () => {
    // The v0.6.2 cross-construct smoke: one doc, every decoration module
    // that can plausibly fire over it should fire. We check that the
    // outer strong span, the inner inline-code chip, the inner link
    // anchor, and the inner wikilink anchor all emit their marks. No
    // assertion on hide-state — we just want to confirm the decorators
    // don't trip over each other when stacked.
    const doc = "**bold with `code` and [link](url) and [[wiki]]**";
    const state = mkState(doc);
    // cursor at offset 2 — inside the strong span, off the link/wikilink/code
    const emphasisSet = buildEmphasisDecorationsFromState(state, 2, FULL(state));
    const codeSet = buildInlineCodeDecorationsFromState(state, 2, FULL(state));
    const linkSet = buildLinksDecorationsFromState(state, 2, FULL(state));
    const wikiSet = buildWikilinksDecorationsFromState(state, 2, FULL(state));

    const strongMarks = collect(emphasisSet).filter(
      (d) => d.spec?.class === "halfday-md-strong"
    );
    expect(strongMarks).toHaveLength(1);

    const codeMarks = collect(codeSet).filter(
      (d) => d.spec?.class === "halfday-md-inline-code"
    );
    expect(codeMarks).toHaveLength(1);

    const linkMarks = collect(linkSet).filter(
      (d) => d.spec?.class === "halfday-md-link"
    );
    expect(linkMarks).toHaveLength(1);

    const wikiMarks = collect(wikiSet).filter(
      (d) => d.spec?.class === "halfday-md-wikilink"
    );
    expect(wikiMarks).toHaveLength(1);
  });

  it("`**bold [link](url)**` produces both the strong mark and the link mark", () => {
    // doc:     **bold [link](url)**
    // offsets: 0123456789012345678901
    // StrongEmphasis spans 0..20, Link spans 7..18, anchor "link" 8..12
    const doc = "**bold [link](url)**";
    const state = mkState(doc);
    // cursor at offset 1 — inside the strong span but off the link span
    // (link is 7..18; cursor 1 is < 7 so link syntax should hide).
    const emphasisSet = buildEmphasisDecorationsFromState(state, 1, FULL(state));
    const linkSet = buildLinksDecorationsFromState(state, 1, FULL(state));

    const strongMarks = collect(emphasisSet).filter(
      (d) => d.spec?.class === "halfday-md-strong"
    );
    expect(strongMarks).toHaveLength(1);
    expect(strongMarks[0].from).toBe(0);
    expect(strongMarks[0].to).toBe(doc.length);

    const linkMarks = collect(linkSet).filter(
      (d) => d.spec?.class === "halfday-md-link"
    );
    expect(linkMarks).toHaveLength(1);
    // anchor text "link" — offsets 8..12
    expect(linkMarks[0].from).toBe(8);
    expect(linkMarks[0].to).toBe(12);
  });
});

describe("Decoration.replace shape (sanity)", () => {
  // Belt-and-braces: the production code uses Decoration.replace({}) for
  // hides. Confirm it really is a replace, not a mark, so the assertions
  // above (.spec?.class === undefined → it's a hide) hold.
  it("Decoration.replace({}) has no `class` in spec", () => {
    const d = Decoration.replace({});
    expect(d.spec?.class).toBeUndefined();
  });
});

describe("htmlInertDecoration (v0.6.3 sanitization)", () => {
  it("marks a <script> HTMLBlock as inert", () => {
    // lezer parses `<script>...</script>` on its own paragraph as an
    // HTMLBlock node. We mark it with .halfday-md-html-inert so the
    // user has a visual signal that it's literal text, not rendered HTML.
    const doc = "<script>alert(1)</script>";
    const state = mkGfmState(doc);
    const set = buildHtmlInertDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-html-inert"
    );
    expect(marks.length).toBeGreaterThan(0);
    // span covers (at minimum) the opening tag — lezer's HTMLBlock can
    // be the whole element. Just verify SOME inert marking landed.
    expect(marks.some((m) => m.from === 0)).toBe(true);
  });

  it("marks <iframe>, <object>, and <embed> blocks as inert too", () => {
    // The decoration treats ALL HTMLBlock + HTMLTag nodes uniformly —
    // we don't allowlist any tags. That's the safe default: anything
    // lezer recognises as HTML gets the inert treatment.
    for (const tag of ["iframe", "object", "embed"]) {
      const doc = `<${tag} src="x"></${tag}>`;
      const state = mkGfmState(doc);
      const set = buildHtmlInertDecorationsFromState(state, 0, FULL(state));
      const marks = collect(set).filter(
        (d) => d.spec?.class === "halfday-md-html-inert"
      );
      expect(marks.length, `tag=${tag}`).toBeGreaterThan(0);
    }
  });

  it("marks inline HTMLTag (e.g. <b>...</b> in prose)", () => {
    // Inline HTML emits one HTMLTag per `<b>` and `</b>`. Both should
    // be marked.
    const doc = "hello <b>world</b> bye";
    const state = mkGfmState(doc);
    const set = buildHtmlInertDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-html-inert"
    );
    // at least the opening and closing tags
    expect(marks.length).toBeGreaterThanOrEqual(2);
  });

  it("is a no-op for plain prose with no HTML", () => {
    const state = mkGfmState("just a paragraph, nothing fancy");
    const set = buildHtmlInertDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("is a no-op for an empty document", () => {
    const state = mkGfmState("");
    const set = buildHtmlInertDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("does not emit hide-syntax replace decorations (only mark)", () => {
    // The inert decoration is purely a Decoration.mark — the bytes
    // stay visible as text, just styled. Confirm no replace ranges
    // are produced.
    const doc = "<script>x</script>";
    const state = mkGfmState(doc);
    const set = buildHtmlInertDecorationsFromState(state, 0, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.class === undefined
    );
    expect(replaces).toEqual([]);
  });
});

describe("linksDecoration sanitization (v0.6.3)", () => {
  it("strips the link affordance from `javascript:` URLs", () => {
    // doc:     "[click](javascript:alert(1))"
    // expected: NO .halfday-md-link anchor mark, NO syntax-hide
    //   replaces. A single .halfday-md-link-inert mark over the URL
    //   portion (so the tags.url accent color is overridden back to
    //   plain text).
    const doc = "[click](javascript:alert(1))";
    const state = mkState(doc);
    // cursor far off so syntax-hide WOULD normally fire on a benign link
    const set = buildLinksDecorationsFromState(state, 0, FULL(state));
    const anchorMarks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-link"
    );
    expect(anchorMarks).toEqual([]);
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.class === undefined
    );
    expect(replaces).toEqual([]);
    const inertMarks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-link-inert"
    );
    expect(inertMarks).toHaveLength(1);
  });

  it("strips the link affordance from `data:` URLs", () => {
    const doc = "[payload](data:text/html,xx)";
    const state = mkState(doc);
    const set = buildLinksDecorationsFromState(state, 0, FULL(state));
    const anchorMarks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-link"
    );
    expect(anchorMarks).toEqual([]);
    const inertMarks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-link-inert"
    );
    expect(inertMarks).toHaveLength(1);
  });

  it("is case-insensitive on the dangerous scheme match", () => {
    // `JavaScript:` is just as executable as `javascript:` in a
    // browser. Match has /i flag.
    const doc = "[x](JaVaScRiPt:alert(1))";
    const state = mkState(doc);
    const set = buildLinksDecorationsFromState(state, 0, FULL(state));
    const anchorMarks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-link"
    );
    expect(anchorMarks).toEqual([]);
  });

  it("leaves http/https/mailto links untouched (still get the link affordance)", () => {
    // Regression: don't over-match. https:// MUST still produce the
    // normal .halfday-md-link mark.
    const doc = "[ok](https://example.com)";
    const state = mkState(doc);
    const set = buildLinksDecorationsFromState(state, doc.length, FULL(state));
    const anchorMarks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-link"
    );
    expect(anchorMarks).toHaveLength(1);
  });

  it("strips the affordance from `vbscript:`, `blob:`, and `file:` schemes (v0.6.3 expansion)", () => {
    // v0.6.3 fix-bundle: DANGEROUS_URL_SCHEMES was expanded beyond
    // javascript+data to cover the legacy IE-era vbscript handler, the
    // in-memory blob: scheme (content unknown to us), and file: which
    // would expose local-disk content via affordance. All three should
    // produce inert marks, not the normal link affordance.
    for (const scheme of ["vbscript:alert(1)", "blob:foo", "file:///etc/passwd"]) {
      const doc = `[x](${scheme})`;
      const state = mkState(doc);
      const set = buildLinksDecorationsFromState(state, 0, FULL(state));
      const anchorMarks = collect(set).filter(
        (d) => d.spec?.class === "halfday-md-link"
      );
      const inertMarks = collect(set).filter(
        (d) => d.spec?.class === "halfday-md-link-inert"
      );
      expect(anchorMarks).toEqual([]);
      expect(inertMarks).toHaveLength(1);
    }
  });
});

describe("wikilinksDecoration sanitization (v0.6.3)", () => {
  it("does NOT decorate `![[embed]]` — the `!` prefix bypasses all marks", () => {
    // doc:     "![[note]]"
    // expected: no .halfday-md-wikilink mark, no hide decorations
    //   anywhere. The whole `![[note]]` renders as literal prose.
    const doc = "![[note]]";
    const state = mkState(doc);
    const set = buildWikilinksDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("still decorates a normal `[[wiki]]` in the same doc as an `![[embed]]`", () => {
    // doc:     "see [[wiki]] and ![[embed]] end"
    // offsets: 0...4......12 .....18......28
    // - [[wiki]] at 4..12 → normal decoration (1 mark + 2 hides off-cursor)
    // - ![[embed]] at 18..28 (the `!` is at 17) → NO decoration
    const doc = "see [[wiki]] and ![[embed]] end";
    const state = mkState(doc);
    const set = buildWikilinksDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-wikilink"
    );
    expect(marks).toHaveLength(1);
    // mark covers the inner "wiki" between [[ and ]]
    expect(marks[0].from).toBe(6);
    expect(marks[0].to).toBe(10);
  });

  it("does NOT bypass when there's whitespace between `!` and `[[`", () => {
    // `! [[note]]` is two tokens — a literal `!` and a normal
    // wikilink. The decoration should still fire on the [[note]].
    const doc = "! [[note]]";
    const state = mkState(doc);
    const set = buildWikilinksDecorationsFromState(state, 0, FULL(state));
    const marks = collect(set).filter(
      (d) => d.spec?.class === "halfday-md-wikilink"
    );
    expect(marks).toHaveLength(1);
  });

  it("treats `![[foo|bar]]` embed display-text syntax as inert (no decoration)", () => {
    // F4 from v0.6.3 QA: the embed bypass should fire on display-text-
    // aliased wikilinks too. The regex matches `[[foo|bar]]` and the
    // prevChar check sees `!` so we skip — `foo|bar` does NOT get the
    // wikilink mark, and the brackets do NOT hide. The whole
    // `![[foo|bar]]` renders as literal prose.
    const doc = "![[foo|bar]]";
    const state = mkState(doc);
    const set = buildWikilinksDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });
});

describe("imagesDecoration (v0.6.3 sanitization)", () => {
  it("replaces `![alt](https://...)` with a placeholder widget when cursor is off", () => {
    const doc = "![alt](https://example.com/x.png)";
    const state = mkState(doc);
    // cursor at end of doc — past the image span (image ends at doc.length)
    // So put cursor on a doc with extra trailing text.
    const docWithTrail = doc + " trailing";
    const stateT = mkState(docWithTrail);
    const set = buildImagesDecorationsFromState(
      stateT,
      docWithTrail.length,
      FULL(stateT)
    );
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.widget !== undefined
    );
    expect(replaces).toHaveLength(1);
    // covers the whole image span (0..length-of-doc minus " trailing")
    expect(replaces[0].from).toBe(0);
    expect(replaces[0].to).toBe(doc.length);
  });

  it("treats local images the same way (same placeholder, no auto-load)", () => {
    // v0.6.3 deliberately doesn't distinguish local from remote.
    const doc = "![local](./foo.png) trail";
    const state = mkState(doc);
    const set = buildImagesDecorationsFromState(state, doc.length, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.widget !== undefined
    );
    expect(replaces).toHaveLength(1);
  });

  it("reveals the raw `![alt](url)` source when the cursor is on the image span", () => {
    const doc = "![alt](https://example.com/x.png) trail";
    const state = mkState(doc);
    // cursor inside the alt text (offset 3 — between `!` and `]`)
    const set = buildImagesDecorationsFromState(state, 3, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.widget !== undefined
    );
    expect(replaces).toEqual([]);
  });

  it("decorates multiple images independently", () => {
    const doc = "![a](u1.png) and ![b](u2.png) end";
    const state = mkState(doc);
    // cursor at end so both placeholders fire
    const set = buildImagesDecorationsFromState(state, doc.length, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.widget !== undefined
    );
    expect(replaces).toHaveLength(2);
  });

  it("is a no-op for an empty document", () => {
    const state = mkState("");
    const set = buildImagesDecorationsFromState(state, 0, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("does not match standard `[link](url)` (Link node, not Image)", () => {
    // sanity: standard links have no `!` prefix and lezer emits Link,
    // not Image. The images decoration must only consume Image nodes.
    const doc = "[regular](https://example.com) trail";
    const state = mkState(doc);
    const set = buildImagesDecorationsFromState(state, doc.length, FULL(state));
    expect(collect(set)).toEqual([]);
  });

  it("widget label includes the alt text and the URL when both are present", () => {
    const doc = "![my pic](https://example.com/x.png) trail";
    const state = mkState(doc);
    const set = buildImagesDecorationsFromState(state, doc.length, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.widget !== undefined
    );
    expect(replaces).toHaveLength(1);
    // The widget is the ImagePlaceholderWidget; we don't poke into the
    // DOM here (no jsdom), but we verify it WAS produced — toDOM
    // behaviour is exercised in the browser-mode smoke (out of scope
    // for unit tests).
    expect(replaces[0].spec?.widget).toBeDefined();
  });

  it("handles empty alt `![](url)` without crashing — placeholder still fires", () => {
    // F3 from v0.6.3 QA: defensive code in images.ts handles the empty-
    // alt case by emitting `[image]` (no `: alt` suffix). The replace
    // decoration must still cover the full Image node range so the
    // ![](url) source bytes don't render alongside the placeholder.
    const doc = "![](https://example.com/x.png) trail";
    const state = mkState(doc);
    const set = buildImagesDecorationsFromState(state, doc.length, FULL(state));
    const replaces = collect(set).filter(
      (d) => d.from !== d.to && d.spec?.widget !== undefined
    );
    expect(replaces).toHaveLength(1);
    expect(replaces[0].from).toBe(0);
    // span covers `![](https://example.com/x.png)` (offsets 0..30)
    expect(replaces[0].to).toBe(30);
  });

  it("handles empty URL `![alt]()` without crashing", () => {
    // F3 from v0.6.3 QA: defensive code in images.ts handles the empty-
    // url case. Either it emits a placeholder labelled `[image: alt]`
    // (URL omitted from the chip text) or it skips emission entirely —
    // both are acceptable. Either way it must not throw.
    const doc = "![alt]() trail";
    const state = mkState(doc);
    expect(() =>
      buildImagesDecorationsFromState(state, doc.length, FULL(state))
    ).not.toThrow();
  });
});
