/**
 * Inline-code decoration — v0.6.1.
 *
 * Renders `` `foo` `` as a small monospace chip with --code-background
 * behind it, and hides the surrounding backticks when the cursor isn't on
 * the span. Same live-preview semantics as headings + emphasis: cursor on
 * the InlineCode span reveals the backticks for editing.
 *
 * lezer-markdown labels:
 *   - InlineCode: the whole `` `code` `` span (including the backticks)
 *   - CodeMark:   the literal `` ` `` token(s) at either end
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

const INLINE_CODE_CLASS = "halfday-md-inline-code";
const HIDE_BACKTICK = Decoration.replace({});

interface PendingMark {
  from: number;
  to: number;
  deco: Decoration;
}

/**
 * Pure builder over an EditorState + cursor position + walk ranges.
 */
export function buildInlineCodeDecorationsFromState(
  state: EditorState,
  cursorPos: number,
  ranges: readonly { from: number; to: number }[]
): DecorationSet {
  const pending: PendingMark[] = [];

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.type.name !== "InlineCode") return;

        const spanFrom = node.from;
        const spanTo = node.to;
        const cursorOnSpan = cursorPos >= spanFrom && cursorPos <= spanTo;

        // mark the whole span (including backticks) so the chip styling
        // shows behind the visible content
        pending.push({
          from: spanFrom,
          to: spanTo,
          deco: Decoration.mark({ class: INLINE_CODE_CLASS }),
        });

        // hide the backtick CodeMarks at either end when cursor is elsewhere
        if (!cursorOnSpan) {
          let child = node.node.firstChild;
          while (child) {
            if (child.type.name === "CodeMark") {
              pending.push({
                from: child.from,
                to: child.to,
                deco: HIDE_BACKTICK,
              });
            }
            child = child.nextSibling;
          }
        }
      },
    });
  }

  pending.sort((a, b) => a.from - b.from || b.to - a.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const p of pending) {
    builder.add(p.from, p.to, p.deco);
  }
  return builder.finish();
}

function buildInlineCodeDecorations(view: EditorView): DecorationSet {
  return buildInlineCodeDecorationsFromState(
    view.state,
    view.state.selection.main.head,
    view.visibleRanges
  );
}

/**
 * CM6 extension for inline-code chips.
 */
export function inlineCodeDecoration() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildInlineCodeDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = buildInlineCodeDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
