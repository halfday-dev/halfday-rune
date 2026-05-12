/**
 * Lists decoration — v0.6.2.
 *
 * Paints the literal list marker (`-`, `*`, `+`, `1.`, `2.`) with the
 * theme-neutral `.halfday-md-list-marker` class so it stops rendering in the
 * bright accent color the old `tags.list` highlight rule applied. The marker
 * STAYS VISIBLE at all times — this is not a hide-on-cursor-leave decoration.
 *
 * Indentation comes for free from the markdown layout; we don't touch it.
 *
 * lezer-markdown labels:
 *   - BulletList, OrderedList: list containers
 *   - ListItem: each item within
 *   - ListMark: the literal `-` / `*` / `+` / `1.` token
 *
 * Why a mark and not a line decoration: we only want to repaint the marker,
 * not the whole line (otherwise nested prose in the list item picks up the
 * muted color too). Decoration.mark over just the ListMark range is the
 * minimal surface.
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

const LIST_MARKER_CLASS = "halfday-md-list-marker";

interface PendingMark {
  from: number;
  to: number;
  /**
   * CM6's RangeSetBuilder requires non-decreasing (from, startSide). All
   * decorations emitted here are Decoration.mark (startSide=1), but we
   * track it explicitly to match the other modules and to keep the sort
   * stable if a later revision adds replaces (e.g. for task-list
   * checkboxes).
   */
  startSide: number;
  deco: Decoration;
}

/**
 * Pure builder over an EditorState + walk ranges. Cursor position is
 * accepted for symmetry with the other modules but unused — list markers
 * are always visible.
 */
export function buildListsDecorationsFromState(
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
        if (node.type.name !== "ListMark") return;
        pending.push({
          from: node.from,
          to: node.to,
          startSide: 1, // Decoration.mark default
          deco: Decoration.mark({ class: LIST_MARKER_CLASS }),
        });
      },
    });
  }

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

function buildListsDecorations(view: EditorView): DecorationSet {
  return buildListsDecorationsFromState(
    view.state,
    view.state.selection.main.head,
    view.visibleRanges
  );
}

/**
 * CM6 extension for ordered + unordered list-marker styling.
 */
export function listsDecoration() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildListsDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = buildListsDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
