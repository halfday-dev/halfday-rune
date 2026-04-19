/**
 * AgeFileView — custom Obsidian FileView for `.age` files.
 *
 * v0.3.2 (editable + autosave): decrypts on open into a CM6 markdown
 * editor, accepts edits, and re-encrypts back to disk on cmd-S or after
 * 30s of inactivity. Round-trip-verifies every save before overwriting
 * the `.age` file — same safety property as v0.2's encryptCurrentNote.
 *
 * Save path:
 *   1. read current doc out of CM6
 *   2. encrypt(recipient, plaintext) → Uint8Array
 *   3. decryptToString(identity, ciphertext) — must byte-match plaintext
 *   4. vault.modifyBinary(<.age>, ciphertext)
 *   5. regenerate sidecar (if one exists) via vault.modify(<.meta.md>)
 *
 * If step 3 fails (round-trip mismatch), we surface a Notice and leave
 * the on-disk `.age` untouched. The user keeps their in-memory edits.
 *
 * Threat model reminder: plaintext lives in JS memory (this.plaintext +
 * the CM6 doc) while the view is open. On close / file unload we destroy
 * the EditorView and null out references so the strings can be GC'd.
 *
 * CM6 packages bundled (not external) — same trade-off as v0.3.1.
 */

import {
  FileSystemAdapter,
  FileView,
  Notice,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import * as path from "path";
import {
  decryptToString,
  encrypt,
  readIdentity,
  readRecipient,
} from "./crypto";
import { generateSidecar } from "./sidecar";

export const VIEW_TYPE_AGE = "halfday-age-view";

/** Debounce window for autosave after the last edit. */
const AUTOSAVE_DELAY_MS = 30_000;

/**
 * A plugin handle the view needs at runtime. Passing the whole plugin
 * would create a cycle; this narrow interface is enough.
 */
export interface AgeFileViewDeps {
  getIdentityPath: () => string;
  getRecipientPath: () => string;
}

type SaveReason = "manual" | "autosave" | "unload";

export class AgeFileView extends FileView {
  private deps: AgeFileViewDeps;
  private plaintext: string | null = null;
  private editor: EditorView | null = null;
  private editorHost: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;

  // dirty / autosave bookkeeping — reset on every onLoadFile
  private dirty = false;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightSave: Promise<void> | null = null;
  private lastSavedAt: Date | null = null;
  /** Byte-length of the ciphertext we last successfully wrote — shown for debugging. */
  private lastSavedBytes: number | null = null;

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
    const name = this.file?.name ?? "(encrypted)";
    // the bullet is a lightweight "dirty" marker that shows up in the tab
    // title — Obsidian re-reads getDisplayText when we call updateHeader().
    return this.dirty ? `● ${name}` : name;
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
    this.cancelAutosave();
    this.teardownEditor();
    this.dirty = false;
    this.lastSavedAt = null;
    this.lastSavedBytes = null;
    this.statusEl.removeClass("halfday-age-error");
    this.statusEl.setText(`decrypting ${file.name}…`);

    try {
      const identityPath = this.deps.getIdentityPath();
      const identity = readIdentity(identityPath);
      const buf = await this.app.vault.readBinary(file);
      const ciphertext = new Uint8Array(buf);
      const plaintext = await decryptToString(identity, ciphertext);

      this.plaintext = plaintext;
      this.lastSavedBytes = ciphertext.byteLength;
      this.mountEditor(plaintext);
      this.refreshStatus(
        `decrypted · ${plaintext.length.toLocaleString()} chars from ${ciphertext.byteLength.toLocaleString()} bytes`
      );
      this.updateTabHeader();
      console.log("[halfday-rune] age view decrypted", {
        path: file.path,
        plaintextLen: plaintext.length,
        ciphertextLen: ciphertext.byteLength,
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
    // flush unsaved edits before dropping plaintext. we await rather than
    // fire-and-forget so the encrypted bytes land before the plugin or
    // workspace unwinds further. If save throws, we surface it via Notice
    // (save() already does that) and still complete the unload — keeping
    // the view open would block Obsidian's own state transitions.
    if (this.dirty) {
      try {
        await this.save("unload");
      } catch (err) {
        console.error("[halfday-rune] flush-on-unload failed", err);
      }
    }
    this.cancelAutosave();
    this.teardownEditor();
    this.plaintext = null;
    this.dirty = false;
    this.lastSavedAt = null;
    this.lastSavedBytes = null;
    if (this.statusEl) {
      this.statusEl.removeClass("halfday-age-error");
      this.statusEl.setText("");
    }
  }

  async onClose(): Promise<void> {
    this.cancelAutosave();
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
        EditorView.lineWrapping,
        lineNumbers(),
        highlightActiveLine(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        // cmd-S (or ctrl-S) triggers an explicit save. We return true so
        // the keypress doesn't bubble up to the browser's save dialog.
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void this.save("manual");
              return true;
            },
          },
        ]),
        // track dirty state — every docChanged flips us dirty and (re)arms
        // the 30s autosave timer.
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            this.markDirty();
          }
        }),
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

  private markDirty(): void {
    const wasDirty = this.dirty;
    this.dirty = true;
    this.scheduleAutosave();
    this.refreshStatus();
    if (!wasDirty) this.updateTabHeader();
  }

  private scheduleAutosave(): void {
    this.cancelAutosave();
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      void this.save("autosave");
    }, AUTOSAVE_DELAY_MS);
  }

  private cancelAutosave(): void {
    if (this.autosaveTimer !== null) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  /**
   * Serialize saves so two concurrent triggers (autosave + cmd-S, or rapid
   * cmd-S) don't race the vault writes. Each call ends up writing whatever
   * the doc looks like at its moment — no queue depth beyond one.
   */
  private async save(reason: SaveReason): Promise<void> {
    if (!this.editor || !this.file) return;
    if (this.inFlightSave) {
      try {
        await this.inFlightSave;
      } catch {
        /* swallow; the new save will surface its own error */
      }
    }
    this.inFlightSave = this._doSave(reason);
    try {
      await this.inFlightSave;
    } finally {
      this.inFlightSave = null;
    }
  }

  private async _doSave(reason: SaveReason): Promise<void> {
    if (!this.editor || !this.file) return;
    const file = this.file;
    const startedAt = Date.now();
    const plaintext = this.editor.state.doc.toString();
    this.cancelAutosave();
    this.refreshStatus("saving…");

    try {
      const recipientPath = this.deps.getRecipientPath();
      const identityPath = this.deps.getIdentityPath();
      const recipient = readRecipient(recipientPath);
      const identity = readIdentity(identityPath);

      // encrypt
      const ciphertext = await encrypt(recipient, plaintext);

      // round-trip verify before committing to disk — mirrors v0.2's
      // safety property: if we can't read back what we just wrote,
      // don't touch the on-disk copy.
      const decoded = await decryptToString(identity, ciphertext);
      if (decoded !== plaintext) {
        throw new Error(
          `round-trip MISMATCH (plaintext ${plaintext.length} chars, decoded ${decoded.length}) — on-disk ciphertext left untouched`
        );
      }

      // Uint8Array → ArrayBuffer slice that vault.modifyBinary accepts
      const buffer = ciphertext.buffer.slice(
        ciphertext.byteOffset,
        ciphertext.byteOffset + ciphertext.byteLength
      ) as ArrayBuffer;
      await this.app.vault.modifyBinary(file, buffer);

      // sidecar: refresh the shape stats + outbound links so the sidecar
      // stays an accurate structural summary. Only if a sidecar already
      // exists — we don't CREATE one here (that's seal.sh / v0.2's job).
      const sidecarPath = this.computeSidecarPath(file.path);
      if (sidecarPath) {
        const sidecarFile = this.app.vault.getAbstractFileByPath(sidecarPath);
        if (sidecarFile instanceof TFile) {
          const adapter = this.app.vault.adapter;
          if (adapter instanceof FileSystemAdapter) {
            const vaultRoot = adapter.getBasePath();
            const originalRelativePath = file.path.replace(/\.age$/, "");
            const absolutePath = path.join(vaultRoot, originalRelativePath);
            const sealedAt = new Date()
              .toISOString()
              .replace(/\.\d{3}Z$/, "Z");
            const sidecar = generateSidecar({
              originalContent: plaintext,
              originalBasename: path.basename(originalRelativePath),
              absolutePath,
              sealedAt,
            });
            await this.app.vault.modify(sidecarFile, sidecar);
          }
        }
      }

      this.plaintext = plaintext;
      this.dirty = false;
      this.lastSavedAt = new Date();
      this.lastSavedBytes = ciphertext.byteLength;
      const dt = Date.now() - startedAt;
      this.refreshStatus(`saved in ${dt}ms (${reason})`);
      this.updateTabHeader();
      console.log("[halfday-rune] age view saved", {
        path: file.path,
        plaintextLen: plaintext.length,
        ciphertextLen: ciphertext.byteLength,
        dt,
        reason,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Halfday Rune: save failed — ${msg}`);
      this.refreshStatus(`save failed — ${msg}`, /*isError*/ true);
      console.error("[halfday-rune] age view save failed", err);
      // still dirty — let the user retry or try cmd-S
      throw err;
    }
  }

  /**
   * Map a `.age` (or `.md.age`) path to its sibling sidecar `.meta.md`.
   * Returns null if the basename doesn't match a pattern we recognize.
   *
   *   foo.md.age → foo.meta.md
   *   foo.age    → foo.meta.md (fallback)
   */
  private computeSidecarPath(agePath: string): string | null {
    if (agePath.endsWith(".md.age")) {
      return agePath.replace(/\.md\.age$/, ".meta.md");
    }
    if (agePath.endsWith(".age")) {
      return agePath.replace(/\.age$/, ".meta.md");
    }
    return null;
  }

  private refreshStatus(extra?: string, isError = false): void {
    if (!this.statusEl) return;
    const file = this.file;
    if (!file) {
      this.statusEl.setText("");
      this.statusEl.removeClass("halfday-age-error");
      return;
    }
    const dirtyMark = this.dirty ? "dirty ●" : "clean";
    const lastSaved = this.lastSavedAt
      ? ` · last saved ${this.lastSavedAt.toLocaleTimeString()}`
      : "";
    const bytes = this.lastSavedBytes !== null
      ? ` · ${this.lastSavedBytes.toLocaleString()} bytes on disk`
      : "";
    const tail = extra ? ` · ${extra}` : "";
    this.statusEl.setText(
      `${file.name} · ${dirtyMark}${lastSaved}${bytes}${tail} · v0.3.2`
    );
    if (isError) {
      this.statusEl.addClass("halfday-age-error");
    } else {
      this.statusEl.removeClass("halfday-age-error");
    }
  }

  /**
   * Nudge Obsidian to re-read getDisplayText so the tab title reflects the
   * current dirty state. `updateHeader` exists on WorkspaceLeaf in current
   * Obsidian builds but isn't in the public types — guard the call so a
   * future rename doesn't crash the plugin.
   */
  private updateTabHeader(): void {
    const leaf = this.leaf as WorkspaceLeaf & { updateHeader?: () => void };
    try {
      leaf.updateHeader?.();
    } catch (err) {
      // best-effort only; the in-view status line is the source of truth
      console.debug("[halfday-rune] updateHeader unavailable", err);
    }
  }
}
