/**
 * Static companion to load-path.test.ts: only the three Node-only modules
 * may import fs/os/path (or other Node built-ins), and nothing may import
 * them except through the dynamic loaders in node-loader.ts. Also pins that
 * no call site reads the identity or recipients except via the key source.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const srcDir = path.join(__dirname, "..", "src");
const NODE_ONLY = ["crypto-node.ts", "backup.ts", "rotate-log.ts"];

function allTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return allTs(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NODE_IMPORT =
  /(?:from\s+|import\s+|require\()["'](?:node:)?(?:fs|os|path|child_process|crypto|util|stream|zlib)(?:\/[^"']*)?["']/;

describe("Node imports stay out of the load path", () => {
  const files = allTs(srcDir);

  it("no src file outside the Node-only modules imports a Node built-in", () => {
    const offenders = files
      .filter((f) => !NODE_ONLY.includes(path.basename(f)))
      .filter((f) => NODE_IMPORT.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(srcDir, f));
    expect(offenders).toEqual([]);
  });

  it("the Node-only modules are only reached via dynamic import()", () => {
    const staticImport = /(?:from\s+|import\s+)["']\.\/(crypto-node|backup|rotate-log)["']/;
    const offenders = files
      .filter((f) => !NODE_ONLY.includes(path.basename(f)))
      .filter((f) => staticImport.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(srcDir, f));
    expect(offenders).toEqual([]);
  });

  it("identity/recipients are read only through the key source", () => {
    // readIdentity / readRecipients( may be defined in crypto-node and called
    // from keysource; every other module must go through KeySource.
    const direct = /\b(readIdentity|readRecipients)\b/;
    const offenders = files
      .filter((f) => !["crypto-node.ts", "keysource.ts"].includes(path.basename(f)))
      .filter((f) => direct.test(stripComments(fs.readFileSync(f, "utf8"))))
      .map((f) => path.relative(srcDir, f));
    expect(offenders).toEqual([]);
  });
});
