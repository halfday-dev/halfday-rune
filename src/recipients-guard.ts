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

/**
 * realpath of `p`, or of its parent plus the file name when the file itself
 * does not exist yet; null when neither resolves.
 */
function resolveReal(p: string, realpath: (p: string) => string): string | null {
  try {
    return realpath(p);
  } catch {
    /* fall through to the parent */
  }
  const i = p.lastIndexOf("/");
  if (i <= 0) return null;
  try {
    return realpath(p.slice(0, i)) + p.slice(i);
  } catch {
    return null;
  }
}

/**
 * Does `configured` expand to the default main recipients file? Compared by
 * folded text, and (when `realpath` is given) also by real path, so a
 * symlinked spelling of the file still counts.
 */
export function isMainRecipientsFile(
  configured: string,
  expand: (p: string) => string,
  realpath?: (p: string) => string
): boolean {
  const norm = (p: string): string => foldPath(normalizePosix(expand(p.trim())));
  if (norm(configured) === norm(MAIN_RECIPIENTS_PATH)) return true;
  if (!realpath) return false;
  const a = resolveReal(expand(configured.trim()), realpath);
  const b = resolveReal(expand(MAIN_RECIPIENTS_PATH), realpath);
  return a !== null && b !== null && foldPath(a) === foldPath(b);
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
  /** Optional fs.realpathSync-like; desktop passes it, tests may inject. */
  realpath?: (p: string) => string;
  prevContent: string | null;
  newContent: string;
}): string[] {
  if (!isMainRecipientsFile(opts.configuredPath, opts.expand, opts.realpath)) return [];
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
