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
  emphasisDecoration,
  halfdayInlineDecorations,
  headingsDecoration,
  inlineCodeDecoration,
  linksDecoration,
} from "../src/decorations";
import { buildHeadingDecorationsFromState } from "../src/decorations/headings";
import { buildEmphasisDecorationsFromState } from "../src/decorations/emphasis";
import { buildInlineCodeDecorationsFromState } from "../src/decorations/inline-code";
import { buildLinksDecorationsFromState } from "../src/decorations/links";

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

  it("halfdayInlineDecorations() returns a 4-element extension list", () => {
    const ext = halfdayInlineDecorations();
    expect(Array.isArray(ext)).toBe(true);
    expect(ext).toHaveLength(4);
  });

  it("halfdayInlineDecorations() composes into an EditorState with mixed content", () => {
    expect(() =>
      EditorState.create({
        doc: "# h1\nbody with **bold** and _italic_ and `code` and [link](https://x.y)",
        extensions: [markdown(), ...halfdayInlineDecorations()],
      })
    ).not.toThrow();
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
