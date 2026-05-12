/**
 * Fenced code-block decoration — v0.6.2.
 *
 * Renders triple-backtick fenced blocks as a live-preview-style chip:
 *
 *   - `--background-secondary` background behind every line of the block
 *   - `--font-monospace` font
 *   - Padded, with rounded corners (first line: top corners; last line:
 *     bottom corners)
 *   - When the cursor is NOT inside the block, the fence lines (the
 *     `` ``` `` open and close, plus the optional language tag on the open
 *     fence) are hidden via a block-level replace so the visible content is
 *     just the code itself. When the cursor enters the block, the fences
 *     re-appear for editing.
 *
 * NO syntax highlighting inside — phase 2 problem. The class hooks are
 * stable so that pass can layer a highlighter without re-walking the tree.
 *
 * lezer-markdown labels:
 *   - FencedCode: the whole `` ```...``` `` span (including both fences)
 *   - CodeMark:   the literal `` ``` `` token (one at open, one at close)
 *   - CodeInfo:   the language hint after the opening fence (e.g. `ts`)
 *   - CodeText:   the actual content lines
 *
 * Why a per-line decoration: Decoration.line attaches CSS classes to the
 * `.cm-line` element, which gives us per-line background painting without
 * needing to compute pixel-level layout. The first / last classes let the
 * stylesheet round only the outer corners.
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

const CODE_BLOCK_CLASS = "halfday-md-code-block";
const CODE_BLOCK_FIRST_CLASS = "halfday-md-code-block-first";
const CODE_BLOCK_LAST_CLASS = "halfday-md-code-block-last";
/** Block-level replace that collapses an entire fence line when cursor is off. */
const HIDE_FENCE_LINE = Decoration.replace({ block: true });

interface PendingDeco {
  from: number;
  to: number;
  /**
   * CM6's RangeSetBuilder requires non-decreasing (from, startSide). Line
   * decorations and block-replaces both default to startSide=-1, but we
   * track it explicitly to keep the sort consistent with the other
   * modules and to make order-at-same-position deterministic.
   */
  startSide: number;
  deco: Decoration;
}

/**
 * Pure builder over an EditorState + cursor position + walk ranges.
 *
 * For each FencedCode node:
 *   - Emit a Decoration.line on every line in the block with the base
 *     class. First line gets `-first`, last line gets `-last` so the CSS
 *     can round only the outer corners.
 *   - If the cursor is NOT inside the block, emit a block-level replace
 *     over each fence line (the one containing the opening CodeMark, and
 *     the one containing the closing CodeMark) so the fences collapse out
 *     of the visible flow.
 *
 * `cursorOnBlock` is the inclusive containment check used elsewhere in
 * this module set: `cursorPos >= node.from && cursorPos <= node.to`.
 */
export function buildCodeBlockDecorationsFromState(
  state: EditorState,
  cursorPos: number,
  ranges: readonly { from: number; to: number }[]
): DecorationSet {
  const pending: PendingDeco[] = [];
  const doc = state.doc;

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.type.name !== "FencedCode") return;

        const blockFrom = node.from;
        const blockTo = node.to;
        const cursorOnBlock = cursorPos >= blockFrom && cursorPos <= blockTo;

        // Walk each line that lives entirely or partly inside the block,
        // from doc.lineAt(blockFrom) through doc.lineAt(blockTo). For a
        // typical 3-line fence (```\ncode\n```) that's three iterations.
        const firstLineNo = doc.lineAt(blockFrom).number;
        const lastLineNo = doc.lineAt(blockTo).number;

        for (let n = firstLineNo; n <= lastLineNo; n++) {
          const line = doc.line(n);
          const classes = [CODE_BLOCK_CLASS];
          if (n === firstLineNo) classes.push(CODE_BLOCK_FIRST_CLASS);
          if (n === lastLineNo) classes.push(CODE_BLOCK_LAST_CLASS);
          pending.push({
            from: line.from,
            to: line.from,
            startSide: -1, // Decoration.line default
            deco: Decoration.line({ class: classes.join(" ") }),
          });
        }

        // Hide each fence line (open + close) when cursor is off the block.
        // The fence lines are the ones that contain a CodeMark child. We
        // collect the CodeMark children rather than assuming first/last
        // line, because a degenerate block could have only one fence (an
        // unclosed block at the end of the doc).
        if (!cursorOnBlock) {
          let child = node.node.firstChild;
          while (child) {
            if (child.type.name === "CodeMark") {
              const fenceLine = doc.lineAt(child.from);
              // Block-level replace from line start through line end+1
              // (i.e. include the trailing newline) so the line collapses
              // out of the visible flow. For the last line of the doc
              // (no trailing newline) we clamp `to` at doc.length.
              const replaceTo = Math.min(fenceLine.to + 1, doc.length);
              pending.push({
                from: fenceLine.from,
                to: replaceTo,
                startSide: -1, // Decoration.replace default
                deco: HIDE_FENCE_LINE,
              });
            }
            child = child.nextSibling;
          }
        }
      },
    });
  }

  // Sort by (from asc, startSide asc, to desc). For this module everything
  // emits at startSide=-1 (both Decoration.line and Decoration.replace),
  // but the wider-first tiebreak still keeps block-replace ahead of any
  // co-located line decoration so RangeSetBuilder is happy.
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

function buildCodeBlockDecorations(view: EditorView): DecorationSet {
  return buildCodeBlockDecorationsFromState(
    view.state,
    view.state.selection.main.head,
    view.visibleRanges
  );
}

/**
 * CM6 extension for fenced-code-block chip rendering.
 *
 * Note: this plugin owns block-level Decoration.replace ranges; we expose
 * them as a separate `decorations` provider so CM6 knows to handle
 * line-shifting correctly. Same pattern as the other modules — the
 * provider is the ViewPlugin's `decorations` field.
 */
export function codeBlockDecoration() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildCodeBlockDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = buildCodeBlockDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
