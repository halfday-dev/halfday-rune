/**
 * AgeFileView — custom Obsidian FileView for `.age` files.
 *
 * v0.3.0 (read-only): decrypts the file to memory on open and renders the
 * plaintext in a preformatted block. No editing, no writes. Used to retire
 * the two biggest v0.3 risks before layering on CM6:
 *
 *   1. `.age` extension routing — does Obsidian hand `.md.age` to us instead
 *      of treating it as an unknown binary?
 *   2. Decrypt-on-open plumbing — readBinary → Uint8Array → decryptToString
 *      round-trips cleanly inside a view lifecycle.
 *
 * v0.3.1 swaps the `<pre>` block for a CodeMirror 6 editor (still read-only).
 * v0.3.2 enables editing + cmd-S + 30s encrypted autosave.
 *
 * Threat model reminder: the plaintext lives in JS memory while the view is
 * open. That is intentional — the whole point of the plugin is an editable
 * surface that never spills plaintext to disk. On view close / file unload
 * we null out the reference so it can be GC'd.
 */

import { FileView, TFile, WorkspaceLeaf } from "obsidian";
import { decryptToString, readIdentity } from "./crypto";

export const VIEW_TYPE_AGE = "halfday-age-view";

/**
 * A plugin handle the view needs at runtime. Passing the whole plugin
 * would create a cycle; this narrow interface is enough.
 */
export interface AgeFileViewDeps {
  getIdentityPath: () => string;
}

export class AgeFileView extends FileView {
  private deps: AgeFileViewDeps;
  private plaintext: string | null = null;
  private bodyEl: HTMLPreElement | null = null;
  private statusEl: HTMLDivElement | null = null;

  constructor(leaf: WorkspaceLeaf, deps: AgeFileViewDeps) {
    super(leaf);
    this.deps = deps;
    this.allowNoFile = false;
    this.navigation = true;
  }

  getViewType(): string {
    return VIEW_TYPE_AGE;
  }

  getIcon(): string {
    return "lock";
  }

  getDisplayText(): string {
    return this.file?.name ?? "(encrypted)";
  }

  /** Build the static chrome once. File-specific content lands in onLoadFile. */
  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("halfday-age-view");

    this.statusEl = contentEl.createDiv({ cls: "halfday-age-status" });
    this.bodyEl = contentEl.createEl("pre", { cls: "halfday-age-body" });
    this.bodyEl.setAttr("spellcheck", "false");
  }

  async onLoadFile(file: TFile): Promise<void> {
    if (!this.statusEl || !this.bodyEl) return;
    this.statusEl.removeClass("halfday-age-error");
    this.statusEl.setText(`decrypting ${file.name}…`);
    this.bodyEl.setText("");

    try {
      const identityPath = this.deps.getIdentityPath();
      const identity = readIdentity(identityPath);
      const buf = await this.app.vault.readBinary(file);
      const ciphertext = new Uint8Array(buf);
      const plaintext = await decryptToString(identity, ciphertext);

      this.plaintext = plaintext;
      this.bodyEl.setText(plaintext);

      const byteLen = ciphertext.byteLength;
      this.statusEl.setText(
        `decrypted · ${plaintext.length.toLocaleString()} chars from ${byteLen.toLocaleString()} bytes · read-only (v0.3.0)`
      );
      console.log("[halfday-rune] age view decrypted", {
        path: file.path,
        plaintextLen: plaintext.length,
        ciphertextLen: byteLen,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.statusEl.setText(`decrypt failed — ${msg}`);
      this.statusEl.addClass("halfday-age-error");
      this.bodyEl.setText("");
      this.plaintext = null;
      console.error("[halfday-rune] age view decrypt failed", err);
    }
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    // drop the plaintext reference so the string can be GC'd
    this.plaintext = null;
    if (this.bodyEl) this.bodyEl.setText("");
    if (this.statusEl) {
      this.statusEl.removeClass("halfday-age-error");
      this.statusEl.setText("");
    }
  }

  async onClose(): Promise<void> {
    this.plaintext = null;
    this.bodyEl = null;
    this.statusEl = null;
    this.contentEl.empty();
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "age";
  }
}
