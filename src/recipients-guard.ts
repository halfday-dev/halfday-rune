/**
 * Guard for the main recipients file (default ~/.age/recipients.txt). Adding
 * a key there silently widens who can read every note and backup, so the
 * settings editor asks first. Pure (no Node imports): path expansion is
 * injected, so it is unit-testable.
 */

import { parseRecipientsFile } from "./crypto";
import { foldPath } from "./path-fold";

export const MAIN_RECIPIENTS_PATH = "~/.age/recipients.txt";

function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

/** Does `configured` expand to the default main recipients file? */
export function isMainRecipientsFile(
  configured: string,
  expand: (p: string) => string
): boolean {
  const norm = (p: string): string => foldPath(normalizePosix(expand(p.trim())));
  return norm(configured) === norm(MAIN_RECIPIENTS_PATH);
}

/**
 * The recipients a Save would ADD to the main file (empty when the file is
 * not the main one, or when nothing is added: removals and no-op saves never
 * need confirmation). An unreadable previous file counts as empty, so every
 * recipient reads as added (the cautious direction).
 */
export function addedToMainFile(opts: {
  configuredPath: string;
  expand: (p: string) => string;
  prevContent: string | null;
  newContent: string;
}): string[] {
  if (!isMainRecipientsFile(opts.configuredPath, opts.expand)) return [];
  let prev: string[] = [];
  try {
    if (opts.prevContent !== null) prev = parseRecipientsFile(opts.prevContent);
  } catch {
    prev = [];
  }
  let next: string[] = [];
  try {
    next = parseRecipientsFile(opts.newContent);
  } catch {
    return [];
  }
  return next.filter((r) => !prev.includes(r));
}

export function mainFileConfirmText(path: string, added: readonly string[]): string {
  return (
    `This is your main recipients file (${path}) — every note and backup ` +
    `will also be encrypted to ${added.length === 1 ? "this key" : "these keys"}:\n` +
    added.join("\n")
  );
}

/**
 * Decide whether a Save may proceed. Calls `confirm` only when a recipient
 * would be added to the main file; otherwise resolves true without asking.
 */
export async function confirmRecipientsSave(
  opts: Parameters<typeof addedToMainFile>[0],
  confirm: (path: string, added: string[]) => Promise<boolean>
): Promise<boolean> {
  const added = addedToMainFile(opts);
  if (added.length === 0) return true;
  return confirm(opts.configuredPath, added);
}
