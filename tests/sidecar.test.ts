/**
 * Vitest for the pure sidecar generator. Mirrors seal.sh's generate_meta()
 * behavior — these tests pin the output shape so plugin-sealed and
 * CLI-sealed sidecars stay byte-identical (modulo timestamp).
 */

import { describe, expect, it } from "vitest";
import {
  formatShape,
  generateSidecar,
  getFrontmatterField,
  outboundWikilinks,
  shapeStats,
  stripFrontmatter,
} from "../src/sidecar";

describe("getFrontmatterField", () => {
  const sample = `---
type: journal
created: 2026-04-18
tags: [x, y]
privacy: ephemeral
---

body line one
`;

  it("reads a scalar field", () => {
    expect(getFrontmatterField(sample, "type")).toBe("journal");
    expect(getFrontmatterField(sample, "created")).toBe("2026-04-18");
    expect(getFrontmatterField(sample, "privacy")).toBe("ephemeral");
  });

  it("returns the raw value for inline list-style tags", () => {
    expect(getFrontmatterField(sample, "tags")).toBe("[x, y]");
  });

  it("returns null for a missing key", () => {
    expect(getFrontmatterField(sample, "nope")).toBeNull();
  });

  it("returns null when no frontmatter block exists", () => {
    expect(getFrontmatterField("just a body", "type")).toBeNull();
  });

  it("strips surrounding double quotes", () => {
    const fm = `---\ntype: "fancy: type"\n---\nbody\n`;
    expect(getFrontmatterField(fm, "type")).toBe("fancy: type");
  });

  it("strips surrounding single quotes", () => {
    const fm = `---\ntype: 'fancy: type'\n---\nbody\n`;
    expect(getFrontmatterField(fm, "type")).toBe("fancy: type");
  });

  it("handles CRLF line endings", () => {
    const fm = "---\r\ntype: journal\r\n---\r\nbody\r\n";
    expect(getFrontmatterField(fm, "type")).toBe("journal");
  });
});

describe("stripFrontmatter", () => {
  it("removes a simple frontmatter block", () => {
    expect(stripFrontmatter("---\ntype: x\n---\nbody\n")).toBe("body\n");
  });

  it("returns content unchanged when no frontmatter", () => {
    expect(stripFrontmatter("just body\n")).toBe("just body\n");
  });

  it("returns empty when frontmatter has no closing delimiter", () => {
    expect(stripFrontmatter("---\ntype: x\nbody\n")).toBe("");
  });

  it("preserves body with multiple paragraphs", () => {
    expect(stripFrontmatter("---\ntype: x\n---\n\npara 1\n\npara 2\n")).toBe(
      "\npara 1\n\npara 2\n"
    );
  });
});

describe("shapeStats", () => {
  it("counts words and paragraphs after frontmatter", () => {
    const c = `---
type: journal
---

first paragraph line one.
first paragraph line two.

second paragraph here.
`;
    expect(shapeStats(c)).toEqual({ words: 11, paragraphs: 2 });
  });

  it("ignores frontmatter words entirely", () => {
    const c = `---
type: journal
created: 2026-04-18
tags: [one, two, three]
---

body.
`;
    // only "body." counts
    expect(shapeStats(c)).toEqual({ words: 1, paragraphs: 1 });
  });

  it("returns zero on an empty body", () => {
    expect(shapeStats("---\ntype: x\n---\n")).toEqual({
      words: 0,
      paragraphs: 0,
    });
  });

  it("treats multiple blank lines as a single paragraph separator", () => {
    expect(shapeStats("a\n\n\n\nb\n")).toEqual({ words: 2, paragraphs: 2 });
  });

  it("works without any frontmatter", () => {
    expect(shapeStats("one two three\n\nfour five\n")).toEqual({
      words: 5,
      paragraphs: 2,
    });
  });

  it("counts whitespace-separated tokens, not characters", () => {
    expect(shapeStats("  many   spaces   between   words  \n")).toEqual({
      words: 4,
      paragraphs: 1,
    });
  });
});

describe("formatShape", () => {
  it("renders the single-word/single-paragraph case without pluralizing", () => {
    expect(formatShape({ words: 1, paragraphs: 1 })).toBe(
      "1 word · 1 paragraph"
    );
  });

  it("pluralizes on plural counts", () => {
    expect(formatShape({ words: 145, paragraphs: 3 })).toBe(
      "145 words · 3 paragraphs"
    );
  });

  it("handles zero (pluralized)", () => {
    expect(formatShape({ words: 0, paragraphs: 0 })).toBe(
      "0 words · 0 paragraphs"
    );
  });
});

describe("outboundWikilinks", () => {
  it("extracts, dedupes, and sorts wikilinks", () => {
    const c = `see [[banana]] and [[apple]] and [[banana]] again.`;
    expect(outboundWikilinks(c)).toEqual(["[[apple]]", "[[banana]]"]);
  });

  it("returns empty array when none present", () => {
    expect(outboundWikilinks("plain text, no links")).toEqual([]);
  });

  it("captures aliased + headed wikilinks intact", () => {
    const c = `[[note#section]] and [[note|alias]]`;
    expect(outboundWikilinks(c)).toEqual(["[[note#section]]", "[[note|alias]]"]);
  });
});

describe("generateSidecar", () => {
  const sealedAt = "2026-04-19T12:00:00Z";

  it("produces the expected shape for a typical note", () => {
    const originalContent = `---
type: journal
created: 2026-04-18
tags: [meta]
privacy: ephemeral
---

a brief reflection on the day.

connected to [[other_note]] and [[third]].
`;
    const out = generateSidecar({
      originalContent,
      originalBasename: "2026-04-18.md",
      absolutePath: "/Users/x/vault/journal/2026-04-18.md",
      sealedAt,
    });

    // frontmatter
    expect(out).toContain("type: meta-sidecar");
    expect(out).toContain(`sealed_at: ${sealedAt}`);
    expect(out).toContain("original_file: 2026-04-18.md");
    expect(out).toContain("privacy: open");
    expect(out).toContain("original_type: journal");
    expect(out).toContain("created: 2026-04-18");
    expect(out).toContain("tags: [meta]");

    // body
    expect(out).toContain("# 2026-04-18 — sealed");
    expect(out).toContain(
      "metadata sidecar for a sealed note. original content is in `2026-04-18.md.age`."
    );
    expect(out).toContain(
      "age -d -i ~/.age/vault.identity '/Users/x/vault/journal/2026-04-18.md.age' > /tmp/decrypted.md"
    );

    // shape (structural stats only — no content leakage)
    expect(out).toContain("## shape");
    // body has 11 words across 2 paragraphs (per shapeStats):
    //   "a brief reflection on the day." (6) +
    //   "connected to [[other_note]] and [[third]]." (5)
    expect(out).toContain("11 words · 2 paragraphs");
    // and crucially: the verbatim sentence must NOT appear
    expect(out).not.toContain("a brief reflection on the day.");

    // outbound links sorted + listed
    const linksIdx = out.indexOf("## outbound links");
    const linksSection = out.slice(linksIdx);
    expect(linksSection).toContain("- [[other_note]]");
    expect(linksSection).toContain("- [[third]]");
    // sorted: "[[other_note]]" < "[[third]]"
    expect(linksSection.indexOf("- [[other_note]]")).toBeLessThan(
      linksSection.indexOf("- [[third]]")
    );
  });

  it("renders _(none)_ when no outbound wikilinks", () => {
    const out = generateSidecar({
      originalContent: "---\ntype: x\n---\n\nbody no links\n",
      originalBasename: "n.md",
      absolutePath: "/v/n.md",
      sealedAt,
    });
    expect(out).toContain("_(none)_");
  });

  it("omits original_type/created/tags lines when source has no frontmatter", () => {
    const out = generateSidecar({
      originalContent: "just body, no fm\n",
      originalBasename: "n.md",
      absolutePath: "/v/n.md",
      sealedAt,
    });
    expect(out).not.toContain("original_type:");
    expect(out).not.toContain("created:");
    expect(out).not.toContain("tags:");
    // and core fields still present
    expect(out).toContain("type: meta-sidecar");
    expect(out).toContain("privacy: open");
  });

  it("throws on a non-.md basename", () => {
    expect(() =>
      generateSidecar({
        originalContent: "x",
        originalBasename: "not-md.txt",
        absolutePath: "/v/not-md.txt",
        sealedAt,
      })
    ).toThrow(/expects a \.md basename/);
  });

  it("ends with a trailing newline", () => {
    const out = generateSidecar({
      originalContent: "x",
      originalBasename: "n.md",
      absolutePath: "/v/n.md",
      sealedAt,
    });
    expect(out.endsWith("\n")).toBe(true);
  });
});
