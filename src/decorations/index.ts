/**
 * Halfday Rune inline + block decorations — v0.6.2.
 *
 * Bundles every markdown decoration module the AgeFileView mounts into a
 * single composed extension. As of v0.6.2 this covers:
 *
 *   Inline (v0.6.1):
 *     1. headings — H1–H6 line styling + hide `# ` prefix off-cursor
 *     2. emphasis — bold + italic with marker hiding
 *     3. inline-code — `code` chips with backtick hiding
 *     4. links — `[text](url)` with full syntax hiding
 *
 *   Block + extension syntax (v0.6.2):
 *     5. lists — paint `-` / `*` / `1.` markers in `--text-muted` instead
 *        of the bright accent color the old `tags.list` highlight rule
 *        applied. Marker stays visible at all times.
 *     6. code-block — fenced triple-backtick chip with `--background-secondary`
 *        background, padded, rounded. Fence lines hide off-cursor.
 *     7. wikilinks — `[[wikilink]]` styled like a markdown link; the `[[`
 *        / `]]` brackets hide off-cursor. Click-to-navigate is phase 2.
 *
 * The function name is kept as `halfdayInlineDecorations` for backward
 * compatibility with `age-view.ts`, but as of v0.6.2 it composes both
 * inline AND block decorations. Don't take the name too literally.
 *
 * Order matters for how CM6 layers decorations:
 *   1. Headings first — line-level decorations need to land at the line
 *      start before any mark decorations on the same range.
 *   2. Emphasis next — bold spans can contain inline-code or link spans.
 *   3. Inline-code — innermost mark styling, applied on top of emphasis.
 *   4. Links — `[text](url)` syntax collapse, independent ViewPlugin.
 *   5. Lists — list-marker repaint; the marker is plain text under lezer
 *      so this layer doesn't conflict with the inline ones above.
 *   6. Code-block — block-level line decorations + fence hides; sits
 *      after the inline pass so any inline marks inside the code block
 *      (which lezer wouldn't emit anyway) don't accidentally restyle
 *      the chip background.
 *   7. Wikilinks — last because the regex pass is the most permissive
 *      and we want the lezer-driven decorators to claim their ranges
 *      first.
 *
 * Known live-preview limitations (carried from v0.6.1, by design — match
 * typical CM6 live-preview plugins; revisit if user complaints surface):
 *
 *   - Multi-cursor: each builder reads `state.selection.main.head` and
 *     reveals syntax only for the primary cursor's line/span. Secondary
 *     cursors land on hidden syntax and the user has to move the primary
 *     to reveal it. Obsidian's own live preview behaves the same way.
 *   - Selection ranges: the `head` of a selection is the moving endpoint,
 *     not the anchor. A selection that starts inside a span and extends
 *     outside it (head outside) will hide the syntax even though the
 *     selection crosses the span. Acceptable; the user can move the
 *     caret onto the span to reveal markers before editing.
 */

import { codeBlockDecoration } from "./code-block";
import { emphasisDecoration } from "./emphasis";
import { headingsDecoration } from "./headings";
import { inlineCodeDecoration } from "./inline-code";
import { linksDecoration } from "./links";
import { listsDecoration } from "./lists";
import { wikilinksDecoration } from "./wikilinks";

export {
  codeBlockDecoration,
  emphasisDecoration,
  headingsDecoration,
  inlineCodeDecoration,
  linksDecoration,
  listsDecoration,
  wikilinksDecoration,
};

/**
 * Returns all halfday decorations as a single array, ready to spread into
 * an EditorState's `extensions` list. Inline-first, block-after, regex-
 * last.
 */
export function halfdayInlineDecorations() {
  return [
    headingsDecoration(),
    emphasisDecoration(),
    inlineCodeDecoration(),
    linksDecoration(),
    listsDecoration(),
    codeBlockDecoration(),
    wikilinksDecoration(),
  ];
}
