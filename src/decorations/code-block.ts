/**
 * Fenced code-block decoration — v0.6.2.
 *
 * Renders triple-backtick fenced blocks as a live-preview-style chip:
 *
 *   - `--background-secondary` background behind every line of the block
 *   - `--font-monospace` font
 *   - Padded, with rounded corners (first line: top corners; last line:
 *     bottom corners)
 *
 * Fence lines stay visible — i.e. the user always sees the opening
 * `` ``` `` (+ optional language tag) and the closing `` ``` ``. v0.6.2
 * originally hid fence lines via a block-level `Decoration.replace
 * ({ block: true })` and revealed them when the cursor entered the block,
 * mirroring Obsidian's own live preview. That behaviour interacted badly
 * with incremental lezer reparses during edits — backspace at the fence
 * boundary could leave stale block-replace ranges pointing at the wrong
 * lines briefly, which surfaced as ghost characters and shifted content
 * after a keystroke. The hide-on-cursor-leave behaviour is removed in
 * this milestone; the chip is still distinct enough visually that the
 * fences read as part of the chip rather than as foreign syntax. Hide-
 * on-cursor-leave can come back in a later milestone with a cleaner
 * implementation (e.g. `atomicRanges` rather than block replaces), and
 * the visual loss in the meantime is small.
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

interface PendingDeco {
  from: number;
  to: number;
  /**
   * CM6's RangeSetBuilder requires non-decreasing (from, startSide). All
   * decorations emitted here are Decoration.line (startSide=-1), but we
   * track the field explicitly to keep the sort consistent with the other
   * modules in this directory and to make order-at-same-position
   * deterministic.
   */
  startSide: number;
  deco: Decoration;
}

/**
 * Pure builder over an EditorState + walk ranges. The signature still
 * accepts `cursorPos` for symmetry with sibling decoration modules — it
 * is unused here because the chip rendering is cursor-independent now.
 *
 * For each FencedCode node:
 *   - Emit a Decoration.line on every line in the block with the base
 *     class. First line gets `-first`, last line gets `-last` so the CSS
 *     can round only the outer corners.
 *
 * Fence lines (open + close) are treated like any other line of the
 * block — they get the chip background + monospace + horizontal padding,
 * and the opening fence picks up `-first` while the closing fence picks
 * up `-last`. They are NOT hidden. This is the v0.6.2 fix for the
 * edit-time ghost-character bug; see the file header for context.
 */
export function buildCodeBlockDecorationsFromState(
  state: EditorState,
  _cursorPos: number,
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

        // Walk each line that lives entirely or partly inside the block,
        // from doc.lineAt(blockFrom) through doc.lineAt(blockTo). For a
        // typical 3-line fence (```\ncode\n```) that's three iterations.
        const firstLineNo = doc.lineAt(node.from).number;
        const lastLineNo = doc.lineAt(node.to).number;

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
      },
    });
  }

  // Sort by (from asc, startSide asc, to desc). For this module everything
  // emits at startSide=-1, but the consistent sort keeps the contract
  // identical to sibling modules and makes the build deterministic.
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
 * As of v0.6.2 the build is cursor-independent (fences always visible),
 * so we only rebuild on docChanged / viewportChanged — selectionSet no
 * longer changes the output and triggering on it is wasted work.
 */
export function codeBlockDecoration() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildCodeBlockDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildCodeBlockDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
