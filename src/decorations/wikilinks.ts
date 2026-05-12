/**
 * Wikilinks decoration — v0.6.2.
 *
 * Renders Obsidian-style `[[wikilink]]` syntax with the same visual
 * treatment as standard markdown links: accent-colored, underlined anchor
 * text with the surrounding `[[` / `]]` brackets hidden when the cursor is
 * off the span. When the cursor enters the span, the brackets re-appear
 * for editing.
 *
 * NOT in scope here (phase 2):
 *   - Click-to-navigate. The wikilink renders visually only; clicking it
 *     is a no-op until v0.7 or later.
 *   - Display-text syntax (`[[note|alias]]`). The full inner text is
 *     painted as one anchor for v0.6.2; aliasing can layer on later.
 *   - Resolving against Obsidian's metadata cache. By design — we never
 *     route cleartext through the cache.
 *
 * Implementation: lezer-markdown's default grammar does NOT parse
 * `[[wikilink]]` as its own node — it sees `[[foo]]` as a Link node with
 * only two LinkMark children and no URL (which the links module already
 * skips). We use a regex over the doc text instead. This is pragmatic for
 * v0 — for typical note sizes (~MB) the regex pass is cheap, and we bound
 * the work by the ViewPlugin's visibleRanges the same way the other
 * decorations do.
 *
 * The regex `/\[\[([^\[\]\n]+?)\]\]/g`:
 *   - Negates `[` and `]` inside the anchor so `[[[[foo]]]]` doesn't
 *     match as one giant span — only the inner `[[foo]]` would, but the
 *     outer brackets aren't a wikilink either, so the whole construct is
 *     correctly rejected.
 *   - Negates `\n` so wikilink syntax never spans newlines.
 *   - `+?` (non-greedy) so adjacent wikilinks `[[a]][[b]]` parse as two
 *     separate matches rather than one wide match.
 */

import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

const WIKILINK_CLASS = "halfday-md-wikilink";
const HIDE_WIKILINK_BRACKETS = Decoration.replace({});

/**
 * Inner content (between `[[` and `]]`) — must not contain `[`, `]`, or
 * newline. Non-greedy so adjacent wikilinks don't collapse.
 */
const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

interface PendingMark {
  from: number;
  to: number;
  /**
   * CM6's RangeSetBuilder requires non-decreasing (from, startSide).
   * Decoration.mark defaults to startSide=1, Decoration.replace to -1, so
   * at the same `from` the replace MUST come before the mark. We track
   * this explicitly to mirror the other decoration modules and to keep
   * the v0.6.1 ordering lesson applied.
   */
  startSide: number;
  deco: Decoration;
}

/**
 * Pure builder over an EditorState + cursor position + walk ranges.
 *
 * We slice the document text per range and run the regex on the slice,
 * offsetting matches by `range.from`. visibleRanges is typically one
 * contiguous range covering the on-screen viewport plus margin; tests
 * pass the full doc.
 */
export function buildWikilinksDecorationsFromState(
  state: EditorState,
  cursorPos: number,
  ranges: readonly { from: number; to: number }[]
): DecorationSet {
  const pending: PendingMark[] = [];

  for (const { from, to } of ranges) {
    const text = state.doc.sliceString(from, to);
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(text)) !== null) {
      const spanFrom = from + m.index;
      const spanTo = spanFrom + m[0].length;
      // Inner anchor lives between the closing `[[` and the opening `]]`
      // — i.e. spanFrom+2 through spanTo-2.
      const anchorFrom = spanFrom + 2;
      const anchorTo = spanTo - 2;
      const cursorOnSpan = cursorPos >= spanFrom && cursorPos <= spanTo;

      // Anchor-text mark — always painted, mirrors the links module.
      // anchorFrom < anchorTo is guaranteed by the regex's `+?` (the
      // inner group requires at least one non-bracket non-newline char).
      pending.push({
        from: anchorFrom,
        to: anchorTo,
        startSide: 1, // Decoration.mark default
        deco: Decoration.mark({ class: WIKILINK_CLASS }),
      });

      // Hide the `[[` and `]]` when cursor is off the span.
      if (!cursorOnSpan) {
        pending.push({
          from: spanFrom,
          to: spanFrom + 2,
          startSide: -1, // Decoration.replace default
          deco: HIDE_WIKILINK_BRACKETS,
        });
        pending.push({
          from: spanTo - 2,
          to: spanTo,
          startSide: -1,
          deco: HIDE_WIKILINK_BRACKETS,
        });
      }
    }
  }

  // Sort by (from asc, startSide asc, to desc). RangeSetBuilder requires
  // non-decreasing (from, startSide). At the same `from`, replace
  // (startSide=-1) MUST come before mark (startSide=1). Same gotcha that
  // bit emphasis + inline-code + links in v0.6.1 (see commit abb9cc1).
  pending.sort(
    (a, b) =>
      a.from - b.from || a.startSide - b.startSide || b.to - a.to
  );
  const builder = new RangeSetBuilder<Decoration>();
  for (const p of pending) {
    builder.add(p.from, p.to, p.deco);
  }
  return builder.finish();
}

function buildWikilinksDecorations(view: EditorView): DecorationSet {
  return buildWikilinksDecorationsFromState(
    view.state,
    view.state.selection.main.head,
    view.visibleRanges
  );
}

/**
 * CM6 extension for `[[wikilink]]` decorations.
 *
 * Click-to-navigate is deferred to a later milestone — this is a purely
 * visual treatment.
 */
export function wikilinksDecoration() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildWikilinksDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = buildWikilinksDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
