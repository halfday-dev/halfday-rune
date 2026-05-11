/**
 * Halfday Rune inline decorations — v0.6.1.
 *
 * Bundles headings, emphasis (bold + italic), and inline-code into one
 * composed extension you can plug into an EditorState.
 *
 * Order matters for the lezer walk and for how CM6 layers decorations:
 *   1. headings first — line-level decorations need to land at the line
 *      start before any mark decorations on the same range
 *   2. emphasis next — bold spans can contain inline-code spans
 *   3. inline-code last — innermost styling, applied on top of emphasis
 *
 * Future block decorations (lists, code blocks, links) will compose into
 * the same returned array; the inline pass stays at the front so nesting
 * (e.g. `**bold with `code`**`) keeps rendering correctly.
 */

import { emphasisDecoration } from "./emphasis";
import { headingsDecoration } from "./headings";
import { inlineCodeDecoration } from "./inline-code";

export { emphasisDecoration, headingsDecoration, inlineCodeDecoration };

/**
 * Returns all inline decorations as a single array, ready to spread into an
 * EditorState's `extensions` list.
 */
export function halfdayInlineDecorations() {
  return [headingsDecoration(), emphasisDecoration(), inlineCodeDecoration()];
}
