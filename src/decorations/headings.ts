/**
 * Headings decoration — v0.6.1.
 *
 * Renders ATX headings (`#`..`######`) at theme-defined sizes/weights using
 * Decoration.mark on the heading line, and hides the `# ` prefix syntax via
 * Decoration.replace when the cursor is not on that line. When the cursor
 * enters the heading line, the syntax span is revealed so the user can edit.
 *
 * This is the live-preview semantics Obsidian's own markdown view exposes:
 * the syntax is real text, but it visually disappears unless the caret is
 * sitting on the same line.
 *
 * Implementation notes:
 *   - We walk the lezer syntax tree produced by @codemirror/lang-markdown
 *     and react to ATXHeading1..ATXHeading6 nodes. The leading `# ` span
 *     is a HeaderMark child of the heading node.
 *   - Rebuilds happen on docChanged / viewportChanged / selectionSet.
 *     selectionSet is load-bearing — it's what lets us toggle the hide /
 *     reveal as the cursor crosses into the line.
 *   - CSS classes are applied via Decoration.mark and styled in styles.css
 *     (theme tokens pull from --h1-size/--h1-weight etc).
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

/** Heading level → CSS class on the heading line. */
const HEADING_LINE_CLASS: Record<number, string> = {
  1: "halfday-md-h1",
  2: "halfday-md-h2",
  3: "halfday-md-h3",
  4: "halfday-md-h4",
  5: "halfday-md-h5",
  6: "halfday-md-h6",
};

/** Map an ATXHeadingN node name → 1..6 (or null if not a heading). */
function headingLevel(nodeName: string): number | null {
  // Names look like "ATXHeading1" .. "ATXHeading6"
  if (!nodeName.startsWith("ATXHeading")) return null;
  const n = Number(nodeName.slice("ATXHeading".length));
  return n >= 1 && n <= 6 ? n : null;
}

/** Decoration that hides the leading `# ` span of a heading line. */
const HIDE_HEADER_MARK = Decoration.replace({});

/**
 * Pure builder over an EditorState + cursor position. Used by the ViewPlugin
 * with the visible viewport, and by unit tests (where there is no real
 * EditorView) over the entire document.
 *
 * `ranges`: list of `{from, to}` regions to walk. The ViewPlugin passes
 * `view.visibleRanges`; tests pass `[{from: 0, to: state.doc.length}]`.
 */
export function buildHeadingDecorationsFromState(
  state: EditorState,
  cursorPos: number,
  ranges: readonly { from: number; to: number }[]
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const level = headingLevel(node.type.name);
        if (level === null) return;

        const line = doc.lineAt(node.from);
        const cursorOnLine = cursorPos >= line.from && cursorPos <= line.to;

        // Line-level decoration sets font-size + weight + the heading line
        // class. Decoration.line attaches to the line, not the range — so
        // we emit it at `line.from` with a zero-width range.
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            class: HEADING_LINE_CLASS[level],
          })
        );

        // Hide the `# `/`## ` prefix when cursor is elsewhere. The lezer tree
        // exposes a HeaderMark child as the literal `#` characters; the
        // following whitespace is not part of HeaderMark but lives between
        // it and the heading text. We hide HeaderMark + the single trailing
        // space (if any) so headings sit flush with the line start.
        if (!cursorOnLine) {
          // Find the HeaderMark child for this heading.
          const headerMark = node.node.firstChild;
          if (headerMark && headerMark.type.name === "HeaderMark") {
            // include one trailing space if present (the `# ` separator)
            let hideEnd = headerMark.to;
            if (
              hideEnd < line.to &&
              doc.sliceString(hideEnd, hideEnd + 1) === " "
            ) {
              hideEnd += 1;
            }
            builder.add(headerMark.from, hideEnd, HIDE_HEADER_MARK);
          }
        }
      },
    });
  }

  return builder.finish();
}

function buildHeadingDecorations(view: EditorView): DecorationSet {
  return buildHeadingDecorationsFromState(
    view.state,
    view.state.selection.main.head,
    view.visibleRanges
  );
}

/**
 * CM6 extension that renders ATX heading decorations on the active view.
 *
 * Exported as a factory function for symmetry with the other decorations
 * modules and to make it easy to add per-instance options later (e.g. opting
 * out of hide-on-cursor-leave for tests).
 */
export function headingsDecoration() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildHeadingDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = buildHeadingDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
