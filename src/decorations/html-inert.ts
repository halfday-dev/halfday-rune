/**
 * HTML-inert decoration — v0.6.3 (sanitization pass).
 *
 * The CM6 view never actually renders HTML — lezer-markdown parses HTML
 * source as `HTMLBlock` / `HTMLTag` nodes and CM6 paints them as plain
 * characters in the text layer. So `<script>alert(1)</script>` in a
 * decrypted note is already inert against script execution.
 *
 * Why this decoration exists anyway: visual unambiguity. A user reading a
 * note with HTML literals in it should SEE that the tags are not being
 * rendered — otherwise `<b>important</b>` could read as bold-styled
 * "important" the way it would in any other markdown viewer, and the user
 * has no signal that the tag is being intentionally passed through. By
 * styling HTMLBlock + HTMLTag spans with a muted monospace look, the
 * literalness is legible at a glance.
 *
 * Scope:
 *   - HTMLBlock: top-level HTML blocks (`<script>...</script>` paragraphs,
 *     `<iframe>...</iframe>`, raw `<div>` blocks, etc.). lezer emits one
 *     node spanning the whole block.
 *   - HTMLTag: inline HTML tags inside prose (`<b>x</b>` mid-sentence).
 *     lezer emits one node per individual tag (each `<b>` and `</b>` is
 *     its own HTMLTag).
 *
 * What this does NOT do:
 *   - Parse or strip the content of the tags. The bytes on disk are the
 *     bytes the user sees; we just mark them visually.
 *   - Prevent script execution. That's already guaranteed by the CM6
 *     rendering path — no HTML is ever passed to innerHTML in the active
 *     editor. This decoration is a UX legibility feature on top.
 *
 * Click-load-image (separate concern) lives in `images.ts`. URL-scheme
 * sanitization (javascript:/data:) lives in `links.ts`.
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

const HTML_INERT_CLASS = "halfday-md-html-inert";

interface PendingMark {
  from: number;
  to: number;
  startSide: number;
  deco: Decoration;
}

/**
 * Pure builder over an EditorState + walk ranges. Cursor position is
 * accepted for signature symmetry with sibling decoration modules; the
 * inert styling is cursor-independent (we always render HTML as literal
 * monospace — there's no "edit mode" to drop into).
 */
export function buildHtmlInertDecorationsFromState(
  state: EditorState,
  _cursorPos: number,
  ranges: readonly { from: number; to: number }[]
): DecorationSet {
  const pending: PendingMark[] = [];

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (
          node.type.name !== "HTMLBlock" &&
          node.type.name !== "HTMLTag"
        ) {
          return;
        }
        pending.push({
          from: node.from,
          to: node.to,
          startSide: 1, // Decoration.mark default
          deco: Decoration.mark({ class: HTML_INERT_CLASS }),
        });
      },
    });
  }

  pending.sort(
    (a, b) => a.from - b.from || a.startSide - b.startSide || b.to - a.to
  );
  const builder = new RangeSetBuilder<Decoration>();
  for (const p of pending) {
    builder.add(p.from, p.to, p.deco);
  }
  return builder.finish();
}

function buildHtmlInertDecorations(view: EditorView): DecorationSet {
  return buildHtmlInertDecorationsFromState(
    view.state,
    view.state.selection.main.head,
    view.visibleRanges
  );
}

/**
 * CM6 extension for HTML-inert decorations.
 */
export function htmlInertDecoration() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildHtmlInertDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildHtmlInertDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
