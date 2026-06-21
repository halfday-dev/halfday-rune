/**
 * Image-placeholder decoration — v0.6.3 (sanitization pass).
 *
 * `![alt](https://example.com/track.png)` in a decrypted note must NOT
 * auto-load. An image load tells whoever hosts that URL "this note was
 * opened, at this IP, at this time" — a timing/identity side channel
 * that defeats the encrypted-by-design property. For v0.6.3 we treat
 * local-vault images the same way: routing them through Obsidian's
 * resource loader (or even an asset:// URL) reintroduces metadata-cache
 * surface that the rest of the plugin spends a lot of effort avoiding.
 * A unified placeholder is also less surprising — same affordance, every
 * image, every time.
 *
 * What we render: the entire `![alt](url)` span is replaced with a
 * widget reading `[image: alt — url]` styled as a quiet chip. When the
 * cursor enters the image span, the replacement is removed so the raw
 * markdown syntax becomes editable again (same live-preview pattern as
 * the other decorations in this directory).
 *
 * NOT in scope here (deferred to a later milestone):
 *   - Click-to-load. The placeholder is inert. A future "load this
 *     image" affordance can layer on top using the same widget hook —
 *     this milestone's job is just to STOP the auto-load.
 *   - Distinguishing local-vault images from remote. v0.6.3 treats all
 *     image refs identically because (a) it's the safer default and
 *     (b) the local-vault path needs Obsidian's resource API which
 *     we're not wired into in the AgeFileView.
 *   - HTML `<img>` tags. Those are handled by the html-inert
 *     decoration which renders raw HTML as literal monospace text —
 *     the `<img>` never auto-loads because the tag is text in CM6,
 *     not parsed into the DOM.
 *
 * lezer-markdown labels (probed by walking the tree on representative
 * docs):
 *   - Image: the whole `![alt](url)` span, from the `!` through the
 *     closing `)`. Children include LinkMark for each of `[`, `]`,
 *     `(`, `)` and a URL node. The `!` lives between the Image's
 *     `from` and the first LinkMark, as a literal character.
 *
 * The replacement widget is a single span with the placeholder text.
 * We don't decode the URL or alt — they're shown verbatim, untouched —
 * because they came from cleartext we already trust and decoding could
 * misrender unicode or punctuation. The trade-off: a very long URL
 * makes the chip wide; acceptable for v0.6.3, can wrap in a later
 * polish pass if anyone complains.
 */

import { syntaxTree } from "@codemirror/language";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

const PLACEHOLDER_CLASS = "halfday-md-image-placeholder";

/**
 * Widget rendered in place of an Image span when the cursor is off it.
 *
 * eq() returns true for widgets with identical alt+url — CM6 uses this
 * to decide whether to re-render the DOM node on doc edits. Without it,
 * every keystroke would tear down and rebuild every placeholder visible
 * in the viewport.
 */
class ImagePlaceholderWidget extends WidgetType {
  constructor(
    private readonly alt: string,
    private readonly url: string
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof ImagePlaceholderWidget &&
      other.alt === this.alt &&
      other.url === this.url
    );
  }

  toDOM(): HTMLElement {
    const span = activeDocument.createElement("span");
    span.className = PLACEHOLDER_CLASS;
    // textContent (not innerHTML) is load-bearing: the alt + url come
    // from cleartext which can contain `<`, `&`, or `"` — putting them
    // in textContent ensures the browser treats them as text.
    const label = this.alt ? `image: ${this.alt}` : "image";
    span.textContent = this.url
      ? `[${label} — ${this.url}]`
      : `[${label}]`;
    return span;
  }

  // ignoreEvent=false lets the editor still receive clicks/mouseover
  // for caret positioning. We have no click handler attached today;
  // future "click to load" lives off the same WidgetType.
  ignoreEvent(): boolean {
    return false;
  }
}

interface PendingDeco {
  from: number;
  to: number;
  startSide: number;
  deco: Decoration;
}

/**
 * Pure builder over an EditorState + cursor position + walk ranges.
 *
 * For each Image node:
 *   - When the cursor is OFF the image span, emit a single
 *     Decoration.replace covering the whole `![alt](url)` and rendering
 *     the placeholder widget.
 *   - When the cursor is ON the span, emit nothing — the raw markdown
 *     becomes editable. This matches the live-preview semantics of the
 *     other decorations: cursor on span ⇒ show source.
 */
export function buildImagesDecorationsFromState(
  state: EditorState,
  cursorPos: number,
  ranges: readonly { from: number; to: number }[]
): DecorationSet {
  const pending: PendingDeco[] = [];

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.type.name !== "Image") return;

        const spanFrom = node.from;
        const spanTo = node.to;
        const cursorOnSpan = cursorPos >= spanFrom && cursorPos <= spanTo;
        if (cursorOnSpan) return;

        // Walk children to extract alt + URL. The alt text lives
        // between the first two LinkMark children (`[` and `]`); the
        // URL is its own node.
        const linkMarks: { from: number; to: number }[] = [];
        let urlNode: { from: number; to: number } | null = null;
        let child = node.node.firstChild;
        while (child) {
          if (child.type.name === "LinkMark") {
            linkMarks.push({ from: child.from, to: child.to });
          } else if (child.type.name === "URL") {
            urlNode = { from: child.from, to: child.to };
          }
          child = child.nextSibling;
        }

        // Defensive: only act on the well-formed shape (4 LinkMarks +
        // URL). Anything else, leave alone — the raw markdown stays
        // visible and the user can edit it to fix.
        if (linkMarks.length !== 4 || urlNode === null) return;

        const altFrom = linkMarks[0].to;
        const altTo = linkMarks[1].from;
        const alt = state.doc.sliceString(altFrom, altTo);
        const url = state.doc.sliceString(urlNode.from, urlNode.to);

        pending.push({
          from: spanFrom,
          to: spanTo,
          startSide: -1, // Decoration.replace default
          deco: Decoration.replace({
            widget: new ImagePlaceholderWidget(alt, url),
          }),
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

function buildImagesDecorations(view: EditorView): DecorationSet {
  return buildImagesDecorationsFromState(
    view.state,
    view.state.selection.main.head,
    view.visibleRanges
  );
}

/**
 * CM6 extension for image-placeholder rendering.
 */
export function imagesDecoration() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildImagesDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = buildImagesDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      // The replace decoration covers a range that participates in line
      // measurement. Mark it so CM6 includes our atomic widget in
      // viewport math.
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => {
          return view.plugin(plugin)?.decorations || Decoration.none;
        }),
    }
  );
}
