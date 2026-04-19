/**
 * Sidecar (.meta.md) generation for sealed notes.
 *
 * Mirrors _agent/seal.sh's generate_meta() so that plugin-sealed files and
 * CLI-sealed files produce byte-identical sidecar shape (up to the sealed_at
 * timestamp). See knowledge/projects/vault_plugin_v0_plan.md decision #7.
 *
 * Pure module — no Obsidian imports — so the logic can be unit-tested without
 * mounting a plugin.
 */

/**
 * Extract a scalar value from simple YAML frontmatter. Matches seal.sh's
 * awk-based parser: trims whitespace, strips surrounding matching quotes.
 * Returns null if the key is not found or the file has no frontmatter block.
 *
 * Frontmatter is the first `---`-delimited block at the top of the file.
 */
export function getFrontmatterField(
  content: string,
  key: string
): string | null {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") return null; // end of frontmatter, not found

    const match = line.match(
      new RegExp(`^\\s*${escapeRegex(key)}\\s*:\\s*(.*?)\\s*$`)
    );
    if (match) {
      let value = match[1];
      // strip matching surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip a leading YAML frontmatter block (if any) and return the remaining
 * body content. Frontmatter is the first `---`-delimited block at the very
 * top of the file. No frontmatter → content is returned unchanged.
 */
export function stripFrontmatter(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return content;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }
  // no closing delimiter found — treat whole file as frontmatter, no body
  return "";
}

/**
 * Structural stats over the body (post-frontmatter). Intentionally carries
 * zero content — just shape. Used to hint at the size/structure of a sealed
 * note without leaking any text.
 *
 *   - words: whitespace-separated tokens, matching awk's default NF
 *     accounting in seal.sh.
 *   - paragraphs: non-empty blocks separated by blank lines.
 */
export function shapeStats(content: string): {
  words: number;
  paragraphs: number;
} {
  const body = stripFrontmatter(content);
  const words = (body.match(/\S+/g) ?? []).length;
  const blocks = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  return { words, paragraphs: blocks.length };
}

/** Render the shape stats as the single line that lands in the sidecar. */
export function formatShape(stats: { words: number; paragraphs: number }): string {
  const pw = stats.words === 1 ? "word" : "words";
  const pp = stats.paragraphs === 1 ? "paragraph" : "paragraphs";
  return `${stats.words} ${pw} · ${stats.paragraphs} ${pp}`;
}

/**
 * Extract all outbound [[wikilinks]] from content, sorted and deduped.
 * Mirrors seal.sh: `grep -oE '\[\[[^]]+\]\]' | sort -u`.
 */
export function outboundWikilinks(content: string): string[] {
  const regex = /\[\[[^\]]+\]\]/g;
  const matches = content.match(regex) ?? [];
  const unique = Array.from(new Set(matches));
  unique.sort();
  return unique;
}

export interface SidecarInput {
  /** Full content of the original .md file (used to extract frontmatter, shape stats, links). */
  originalContent: string;
  /** Just the filename with extension, e.g. "note.md". */
  originalBasename: string;
  /**
   * Absolute filesystem path to the original .md file. Used to render the
   * decrypt command. Matches seal.sh's behavior (which uses $file, the
   * absolute path from `find`).
   */
  absolutePath: string;
  /** ISO-8601 UTC timestamp in the format seal.sh uses: YYYY-MM-DDTHH:MM:SSZ */
  sealedAt: string;
}

/**
 * Produce the full sidecar markdown body. Format matches seal.sh's
 * generate_meta() so plugin-sealed and CLI-sealed notes have byte-identical
 * sidecar shape (modulo the sealed_at timestamp).
 */
export function generateSidecar(input: SidecarInput): string {
  const { originalContent, originalBasename, absolutePath, sealedAt } = input;

  if (!originalBasename.endsWith(".md")) {
    throw new Error(
      `generateSidecar expects a .md basename, got: ${originalBasename}`
    );
  }
  const stem = originalBasename.slice(0, -".md".length);

  // frontmatter
  const fmLines: string[] = [];
  fmLines.push("---");
  fmLines.push("type: meta-sidecar");
  fmLines.push(`sealed_at: ${sealedAt}`);
  fmLines.push(`original_file: ${originalBasename}`);
  fmLines.push("privacy: open");

  const originalType = getFrontmatterField(originalContent, "type");
  if (originalType) fmLines.push(`original_type: ${originalType}`);
  const created = getFrontmatterField(originalContent, "created");
  if (created) fmLines.push(`created: ${created}`);
  const tags = getFrontmatterField(originalContent, "tags");
  if (tags) fmLines.push(`tags: ${tags}`);

  fmLines.push("---");

  // body
  const bodyLines: string[] = [];
  bodyLines.push("");
  bodyLines.push(`# ${stem} — sealed`);
  bodyLines.push("");
  bodyLines.push(
    `metadata sidecar for a sealed note. original content is in \`${originalBasename}.age\`.`
  );
  bodyLines.push("");
  bodyLines.push("decrypt with:");
  bodyLines.push("");
  bodyLines.push("```bash");
  bodyLines.push(
    `age -d -i ~/.age/vault.identity '${absolutePath}.age' > /tmp/decrypted.md`
  );
  bodyLines.push("```");
  bodyLines.push("");
  bodyLines.push("## shape");
  bodyLines.push("");
  bodyLines.push(formatShape(shapeStats(originalContent)));
  bodyLines.push("");
  bodyLines.push("## outbound links");
  bodyLines.push("");
  const links = outboundWikilinks(originalContent);
  if (links.length === 0) {
    bodyLines.push("_(none)_");
  } else {
    for (const l of links) bodyLines.push(`- ${l}`);
  }

  return [...fmLines, ...bodyLines].join("\n") + "\n";
}
