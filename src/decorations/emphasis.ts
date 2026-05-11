/**
 * Emphasis decoration — v0.6.1.
 *
 * Renders bold (`**foo**`) and italic (`_foo_` / `*foo*`) ranges with the
 * appropriate styling, and hides the surrounding asterisk/underscore syntax
 * markers when the cursor isn't on the span.
 *
 * lezer-markdown labels:
 *   - StrongEmphasis: a bold span (with `**` or `__` markers)
 *   - Emphasis: an italic span (with `*` or `_` markers)
 *   - EmphasisMark: the literal `*` / `_` / `**` token(s) inside either
 *
 * Live-preview semantics: when the cursor enters anywhere between
 * span.from and span.to (inclusive), the syntax markers are revealed so the
 * user can edit them. Otherwise they're hidden via Decoration.replace.
 */

import { syntaxTree } from "@codemirror/language";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

const STRONG_CLASS = "halfday-md-strong";
const EMPHASIS_CLASS = "halfday-md-emphasis";
const HIDE_MARK = Decoration.replace({});

interface PendingMark {
  from: number;
  to: number;
  deco: Decoration;
}

/**
 * Pure builder over an EditorState + cursor position + walk ranges. The
 * ViewPlugin uses the visible viewport; tests use the full doc.
 */
export function buildEmphasisDecorationsFromState(
  state: EditorState,
  cursorPos: number,
  ranges: readonly { from: number; to: number }[]
): DecorationSet {
  // We can't rely on the lezer walk for strictly-ascending order between
  // mark and replace decorations that interleave (a StrongEmphasis can
  // contain a nested Emphasis). Collect everything then sort + emit.
  const pending: PendingMark[] = [];

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.type.name;
        const isStrong = name === "StrongEmphasis";
        const isEmphasis = name === "Emphasis";
        if (!isStrong && !isEmphasis) return;

        const spanFrom = node.from;
        const spanTo = node.to;
        const cursorOnSpan = cursorPos >= spanFrom && cursorPos <= spanTo;

        // outer mark for the whole span — styles the inner text
        pending.push({
          from: spanFrom,
          to: spanTo,
          deco: Decoration.mark({
            class: isStrong ? STRONG_CLASS : EMPHASIS_CLASS,
          }),
        });

        // hide each EmphasisMark child when cursor is elsewhere
        if (!cursorOnSpan) {
          let child = node.node.firstChild;
          while (child) {
            if (child.type.name === "EmphasisMark") {
              pending.push({
                from: child.from,
                to: child.to,
                deco: HIDE_MARK,
              });
            }
            child = child.nextSibling;
          }
        }
      },
    });
  }

  // Sort by (from, then to descending) — RangeSetBuilder requires strictly
  // non-decreasing `from`, and for two decorations at the same `from` the
  // wider one must come first.
  pending.sort((a, b) => a.from - b.from || b.to - a.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const p of pending) {
    builder.add(p.from, p.to, p.deco);
  }
  return builder.finish();
}

function buildEmphasisDecorations(view: EditorView): DecorationSet {
  return buildEmphasisDecorationsFromState(
    view.state,
    view.state.selection.main.head,
    view.visibleRanges
  );
}

/**
 * CM6 extension for bold + italic decorations.
 */
export function emphasisDecoration() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildEmphasisDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = buildEmphasisDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
