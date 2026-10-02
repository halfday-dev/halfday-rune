/**
 * Path comparison for vault paths that may differ only by case or Unicode
 * form (macOS/iOS filesystems fold both), plus the exclusion helper rotate
 * and backup use to leave the wrapped identity file alone.
 */

export function foldPath(p: string): string {
  return p.normalize("NFC").toLowerCase();
}

export function isExcludedPath(path: string, excluded: readonly string[]): boolean {
  const f = foldPath(path);
  return excluded.some((e) => foldPath(e) === f);
}
