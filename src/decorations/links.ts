/**
 * Links decoration — v0.6.1 / v0.6.3.
 *
 * Renders standard markdown links `[text](url)` so only the anchor text is
 * visible when the cursor is off the span; brackets, parens, and the URL
 * collapse out of view. When the caret enters the link span, the full
 * `[text](url)` syntax is revealed for editing — same live-preview semantics
 * as headings + emphasis + inline-code.
 *
 * v0.6.3 sanitization: links whose URL uses the `javascript:` or `data:`
 * scheme are rendered as INERT — no accent-color anchor mark, no syntax
 * hiding, no "this is a link" affordance. The raw `[text](url)` source
 * stays visible verbatim so the user can see exactly what's on disk. We
 * don't have click-to-navigate, so the threat surface today is small
 * (the user would have to manually copy the URL into a browser to fire
 * the payload), but the visual affordance was the only thing telling
 * them "this is safe to click." Removing it removes the lie.
 *
 * lezer-markdown labels (confirmed by walking the tree on a probe doc):
 *   - Link:     the whole `[text](url)` span (from `[` through `)`)
 *   - LinkMark: each of `[`, `]`, `(`, `)` individually, as separate children
 *   - URL:      the URL portion `url` (no parens)
 *
 * NOT in scope here (deferred to v0.6.2):
 *   - Wikilinks `[[foo]]`. lezer-markdown's default grammar parses these as
 *     a single Link node `[foo]` with only two LinkMark children and NO URL
 *     child — so the wikilink-shape check below (must have 4 LinkMarks +
 *     URL) naturally excludes them. They render as plain text today.
 *   - Image links `![alt](url)`. These are an Image node, not Link — we
 *     don't enter on them at all.
 *   - Click-to-navigate. Phase 2 problem per the spec.
 *
 * Why both the mark and the existing tags.link/tags.url highlight rule:
 *   tags.link/tags.url in halfdayMarkdownHighlight already give the anchor
 *   text and URL the accent color + underline. We layer an explicit
 *   `.halfday-md-link` mark over the anchor text range anyway — it's
 *   harmless when stacked on top of the tag rule and it gives us a stable
 *   class hook for the v0.6.2 click-to-navigate work that'll build on it.
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

const LINK_CLASS = "halfday-md-link";
const HIDE_LINK_SYNTAX = Decoration.replace({});

/**
 * v0.6.3: URL schemes that are NEVER allowed to look like a clickable
 * link. Every entry is a known vehicle for active content delivery or
 * for accidentally exposing the user to local-file content:
 *
 *   - `javascript:` — executes script when navigated to. Even though
 *     our view has no click-to-navigate today, the link affordance
 *     (anchor color + underline + hidden raw URL) signals "this is
 *     safe to click" — exactly the wrong message.
 *   - `vbscript:` — old IE-era script protocol. Modern browsers reject
 *     it but a future click-to-navigate path might shell out to a less
 *     curated handler; cheap to refuse it here.
 *   - `data:` — can encode an entire HTML/JS payload inline. A
 *     `data:text/html,<script>...` URL is a self-contained attack
 *     vector if it ever ends up in a browser.
 *   - `blob:` — references an in-memory blob; usually safe but the
 *     blob's content could be anything. Same affordance-lie concern as
 *     `data:` in a markdown context.
 *   - `file:` — local file access. In a markdown ecosystem, a
 *     `file:///etc/passwd` link masquerading as an innocuous label
 *     would be a real social-engineering risk if click-to-navigate
 *     ever lands. Inert by default.
 *
 * Matched case-insensitively and tolerant of leading whitespace inside
 * the URL portion (lezer's URL node trims the parens but not internal
 * whitespace).
 *
 * NOT covered (worth knowing): HTML-entity-encoded forms like
 * `&#x6A;avascript:` aren't decoded before matching. lezer parses raw
 * bytes; the regex sees them literally. Acceptable today because no
 * click-to-navigate exists — the affordance lie is the only payload.
 * Revisit when click-to-navigate lands (v0.7+).
 */
const DANGEROUS_URL_SCHEMES = /^\s*(?:javascript|vbscript|data|blob|file)\s*:/i;

interface PendingMark {
  from: number;
  to: number;
  /**
   * CM6's RangeSetBuilder requires non-decreasing (from, startSide).
   * Decoration.mark defaults to startSide=1, Decoration.replace to -1, so
   * at the same `from` the replace MUST come before the mark. We track
   * this explicitly because we can't read startSide off a Decoration
   * object via the public API. Same gotcha that bit emphasis + inline-code
   * (see abb9cc1).
   */
  startSide: number;
  deco: Decoration;
}

/**
 * Pure builder over an EditorState + cursor position + walk ranges.
 *
 * The shape we look for inside each Link node: exactly four LinkMark
 * children (`[`, `]`, `(`, `)`) plus a URL child. If a Link is missing the
 * `(`/`)`/URL trio (the wikilink `[foo]` case), we skip it entirely.
 */
export function buildLinksDecorationsFromState(
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
        if (node.type.name !== "Link") return;

        // Collect children in document order so we can tell standard links
        // from wikilinks and find the anchor-text range.
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

        // Standard `[text](url)` has 4 LinkMarks + 1 URL. Anything else
        // (wikilinks, reference-style links, malformed) — bail.
        if (linkMarks.length !== 4 || urlNode === null) return;

        // v0.6.3: if the URL uses a dangerous scheme, refuse to render
        // any link affordance for this span. No anchor mark (so no
        // accent color, no underline), no hide-syntax replace (so the
        // raw `[text](javascript:...)` text shows verbatim). The user
        // sees exactly what's on disk and gets no false signal that
        // the link is clickable. We also defense-in-depth this in the
        // halfdayMarkdownHighlight tags.link / tags.url rules at the
        // age-view layer — a tags-based highlight rule would still
        // paint accent over a `javascript:` URL — so we mark the URL
        // span itself with an inert class that the stylesheet uses
        // to override the tags-based color back to plain text.
        const urlText = state.doc.sliceString(urlNode.from, urlNode.to);
        if (DANGEROUS_URL_SCHEMES.test(urlText)) {
          pending.push({
            from: urlNode.from,
            to: urlNode.to,
            startSide: 1,
            deco: Decoration.mark({ class: "halfday-md-link-inert" }),
          });
          return;
        }

        const openBracket = linkMarks[0]; // [
        const closeBracket = linkMarks[1]; // ]
        const openParen = linkMarks[2]; // (
        const closeParen = linkMarks[3]; // )

        const spanFrom = node.from;
        const spanTo = node.to;
        const cursorOnSpan = cursorPos >= spanFrom && cursorPos <= spanTo;

        // Anchor text lives between the closing `[` and the opening `]`,
        // i.e. from openBracket.to up to closeBracket.from. Empty-text
        // links (`[](url)`) produce a zero-width mark; RangeSetBuilder
        // accepts that (it'd just be a no-op decoration).
        const anchorFrom = openBracket.to;
        const anchorTo = closeBracket.from;
        if (anchorFrom < anchorTo) {
          pending.push({
            from: anchorFrom,
            to: anchorTo,
            startSide: 1, // Decoration.mark default
            deco: Decoration.mark({ class: LINK_CLASS }),
          });
        }

        // Hide the syntax bits when the cursor is elsewhere. Five hide
        // ranges per link: `[`, `]`, `(`, URL, `)`.
        if (!cursorOnSpan) {
          for (const m of [
            openBracket,
            closeBracket,
            openParen,
            urlNode,
            closeParen,
          ]) {
            pending.push({
              from: m.from,
              to: m.to,
              startSide: -1, // Decoration.replace default
              deco: HIDE_LINK_SYNTAX,
            });
          }
        }
      },
    });
  }

  // Sort by (from asc, startSide asc, to desc). RangeSetBuilder requires
  // non-decreasing (from, startSide). At the same `from`, replace
  // (startSide=-1) MUST come before mark (startSide=1).
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

function buildLinksDecorations(view: EditorView): DecorationSet {
  return buildLinksDecorationsFromState(
    view.state,
    view.state.selection.main.head,
    view.visibleRanges
  );
}

/**
 * CM6 extension for standard markdown link decorations.
 */
export function linksDecoration() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildLinksDecorations(view);
      }

      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = buildLinksDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
