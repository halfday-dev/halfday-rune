/**
 * AgeFileView — custom Obsidian FileView for `.age` files.
 *
 * v0.3.1 (read-only, CM6): decrypts the file to memory on open and mounts a
 * CodeMirror 6 editor with markdown syntax highlighting over the plaintext.
 * No editing, no writes. Editing + cmd-S + 30s encrypted autosave land in
 * v0.3.2.
 *
 * CM6 packages are bundled into main.js rather than marked external so we
 * don't depend on Obsidian's bundled version staying ABI-compatible with us.
 * The size hit is ~150 KB gzipped — acceptable for now.
 *
 * Threat model reminder: the plaintext lives in JS memory (both in our
 * `plaintext` field and inside the CM6 EditorState's document) while the view
 * is open. That is intentional — the whole point of the plugin is an
 * editable surface that never spills plaintext to disk. On view close / file
 * unload we destroy the EditorView (which drops its state) and null out our
 * reference so the strings can be GC'd.
 */

import { FileView, TFile, WorkspaceLeaf } from "obsidian";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
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
  private editor: EditorView | null = null;
  private editorHost: HTMLDivElement | null = null;
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
    this.editorHost = contentEl.createDiv({ cls: "halfday-age-editor" });
  }

  async onLoadFile(file: TFile): Promise<void> {
    if (!this.statusEl || !this.editorHost) return;
    this.teardownEditor();
    this.statusEl.removeClass("halfday-age-error");
    this.statusEl.setText(`decrypting ${file.name}…`);

    try {
      const identityPath = this.deps.getIdentityPath();
      const identity = readIdentity(identityPath);
      const buf = await this.app.vault.readBinary(file);
      const ciphertext = new Uint8Array(buf);
      const plaintext = await decryptToString(identity, ciphertext);

      this.plaintext = plaintext;
      this.mountEditor(plaintext);

      const byteLen = ciphertext.byteLength;
      this.statusEl.setText(
        `decrypted · ${plaintext.length.toLocaleString()} chars from ${byteLen.toLocaleString()} bytes · read-only (v0.3.1)`
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
      this.teardownEditor();
      this.plaintext = null;
      console.error("[halfday-rune] age view decrypt failed", err);
    }
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    // drop the plaintext reference and destroy the CM6 state so the string
    // can be GC'd. CM6 holds the doc in its EditorState — destroying the view
    // is what actually releases it.
    this.teardownEditor();
    this.plaintext = null;
    if (this.statusEl) {
      this.statusEl.removeClass("halfday-age-error");
      this.statusEl.setText("");
    }
  }

  async onClose(): Promise<void> {
    this.teardownEditor();
    this.plaintext = null;
    this.editorHost = null;
    this.statusEl = null;
    this.contentEl.empty();
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "age";
  }

  private mountEditor(doc: string): void {
    if (!this.editorHost) return;
    // fresh container each time so CM6 doesn't see leftover children
    this.editorHost.empty();

    const state = EditorState.create({
      doc,
      extensions: [
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        lineNumbers(),
        highlightActiveLine(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        // lean on Obsidian's CSS variables so the editor blends in visually
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "var(--font-text-size, 16px)",
            fontFamily: "var(--font-text, inherit)",
            backgroundColor: "var(--background-primary)",
            color: "var(--text-normal)",
          },
          ".cm-scroller": {
            fontFamily: "var(--font-text, inherit)",
            lineHeight: "1.6",
          },
          ".cm-content": {
            padding: "0.75rem 0.25rem",
          },
          ".cm-gutters": {
            backgroundColor: "var(--background-secondary)",
            color: "var(--text-muted)",
            border: "none",
          },
          ".cm-activeLine": {
            backgroundColor: "var(--background-modifier-hover)",
          },
          ".cm-activeLineGutter": {
            backgroundColor: "var(--background-modifier-hover)",
          },
        }),
      ],
    });

    this.editor = new EditorView({ state, parent: this.editorHost });
  }

  private teardownEditor(): void {
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
    if (this.editorHost) this.editorHost.empty();
  }
}
