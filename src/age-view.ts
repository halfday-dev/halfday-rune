/**
 * AgeFileView — custom Obsidian FileView for `.age` files.
 *
 * v0.6.0 (chrome pass): the inline status banner is gone. Line numbers
 * are gone. The CM6 theme now inherits Obsidian CSS variables across
 * the board (fonts, sizes, colors, line-height) so theme switching
 * just works. Cursor is 2px and uses `--color-accent`. Tab title
 * strips the `.md.age` / `.age` suffix; the lock icon comes from
 * `getIcon()`. View-level state changes push dirty/clean + bytes +
 * last-saved up to the plugin's status-bar item via the new
 * `updateStatusBar` / `clearStatusBar` deps.
 *
 * v0.3.2 (editable + autosave): decrypts on open into a CM6 markdown
 * editor, accepts edits, and re-encrypts back to disk on cmd-S or after
 * 30s of inactivity. Round-trip-verifies every save before overwriting
 * the `.age` file — same safety property as v0.2's encryptCurrentNote.
 *
 * v0.4: sidecars are gone. Save path writes only the `.age` file.
 *
 * Save path:
 *   1. read current doc out of CM6
 *   2. encrypt(recipient, plaintext) → Uint8Array
 *   3. decryptToString(identity, ciphertext) — must byte-match plaintext
 *   4. vault.modifyBinary(<.age>, ciphertext)
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

import { FileView, Notice, Scope, TFile, WorkspaceLeaf } from "obsidian";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  keymap,
} from "@codemirror/view";
import {
  defaultHighlightStyle,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { tags } from "@lezer/highlight";
import {
  decryptToString,
  encrypt,
} from "./crypto";
import { halfdayInlineDecorations } from "./decorations";
import type { KeySource } from "./keysource";
import { KeyLockedError } from "./keysource";
import { inspectNoteForMobileSave } from "./crypto";
import { writeLayoutDebug } from "./layout-debug";

export const VIEW_TYPE_AGE = "halfday-age-view";

/** Debounce window for autosave after the last edit. */
const AUTOSAVE_DELAY_MS = 30_000;

/**
 * Custom highlight style for constructs we haven't replaced with proper
 * decorations yet.
 *
 * v0.6.2 (this pass): `tags.list` and `tags.monospace` REMOVED.
 *   - `tags.list` was the source of the bright purple list-marker bug —
 *     lists.ts now repaints ListMark ranges in `--text-muted` via the
 *     `.halfday-md-list-marker` class.
 *   - `tags.monospace` was the v0.6.1 fenced-code fallback; code-block.ts
 *     now renders fenced blocks as a proper chip with
 *     `--background-secondary` background and a per-line decoration set.
 *
 * v0.6.1: headings, strong, emphasis, and monospace rules were REMOVED
 * here (well, monospace was re-added as a fenced-code fallback and is
 * now gone for real). They're handled by halfdayInlineDecorations in
 * src/decorations/ — which gives them live-preview semantics (size +
 * weight on the line, and hide-syntax-on-cursor-leave) instead of just
 * applying token colors.
 *
 * What's still here:
 *   - tags.strikethrough — no dedicated decoration yet
 *   - tags.link / tags.url — defense-in-depth alongside the link
 *     decoration; covers bare URLs not inside Link nodes too
 *   - tags.quote — no dedicated decoration yet
 *
 * v0.6.0: heading sizes used to ride Obsidian's `--h1-size`..`--h6-size`
 * variables here; that's now done in styles.css via the
 * .halfday-md-h1..h6 classes the headings decoration applies.
 *
 * Tag set comes from @lezer/highlight; same vocabulary
 * @codemirror/lang-markdown emits.
 */
const halfdayMarkdownHighlight = HighlightStyle.define([
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: tags.link,
    color: "var(--color-accent)",
    textDecoration: "underline",
  },
  { tag: tags.url, color: "var(--color-accent)" },
  { tag: tags.quote, color: "var(--text-muted)", fontStyle: "italic" },
]);

/**
 * Snapshot the view pushes up to the plugin's status-bar item. The
 * plugin owns the actual HTMLElement (Obsidian's status bar belongs to
 * the workspace, not any individual view), so the view just describes
 * its state and the plugin renders it.
 */
export interface AgeStatusBarState {
  filename: string;
  dirty: boolean;
  bytesOnDisk: number | null;
  lastSavedAt: Date | null;
}

/**
 * A plugin handle the view needs at runtime. Passing the whole plugin
 * would create a cycle; this narrow interface is enough.
 *
 * v0.6.0 additions: updateStatusBar / clearStatusBar replace the
 * inline `.halfday-age-status` banner that used to live inside the
 * pane. The plugin owns the bottom-of-workspace status item and the
 * view feeds it on every state change.
 */
export interface AgeFileViewDeps {
  /** The plugin's single key source (identity + recipients). */
  getKeySource: () => KeySource;
  updateStatusBar: (state: AgeStatusBarState) => void;
  clearStatusBar: () => void;
  /** Autosave debounce; defaults to 30 s (mobile passes a shorter one). */
  autosaveDelayMs?: number;
  /** Flush dirty edits when the editor loses focus (mobile). */
  flushOnBlur?: boolean;
  /**
   * Re-measure the editor when the (iOS) visual viewport or the workspace
   * resizes, e.g. when the on-screen keyboard opens. Mobile only.
   */
  remeasureOnViewport?: boolean;
}

export const UNKNOWN_RECIPIENTS_NOTICE =
  "This note is encrypted to keys your phone doesn't know about \u2014 edit it on desktop, or re-run Create mobile unlock copy";
export const NOT_YOUR_KEY_NOTICE =
  "This note isn't encrypted to your unlocked key \u2014 edit it on desktop";

class RecipientListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipientListError";
  }
}

type SaveReason = "manual" | "autosave" | "unload" | "background";

export class AgeFileView extends FileView {
  private deps: AgeFileViewDeps;
  private plaintext: string | null = null;
  private editor: EditorView | null = null;
  private editorHost: HTMLDivElement | null = null;

  // dirty / autosave bookkeeping — reset on every onLoadFile
  private dirty = false;
  private autosaveTimer: number | null = null;
  private inFlightSave: Promise<void> | null = null;
  /** One shared flush, so close + unload (in either order) save once. */
  private flushing: Promise<void> | null = null;
  private lastSavedAt: Date | null = null;
  /** Byte-length of the ciphertext we last successfully wrote — surfaced via the status bar. */
  private lastSavedBytes: number | null = null;
  /** Bumped by every lock/teardown so an in-flight save can tell it was locked under it. */
  private lockGen = 0;
  /** Removes the viewport/workspace resize listeners (mobile). */
  private detachViewport: (() => void) | null = null;

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
    // v0.6.0: Obsidian renders this as the tab's leading glyph via its
    // lucide icon set. If a future Obsidian build stops resolving
    // "lock", `getDisplayText` is the fallback affordance — see below.
    return "lock";
  }

  getDisplayText(): string {
    const raw = this.file?.name ?? "(encrypted)";
    // v0.6.0: strip the encrypted suffixes for tab readability.
    // ".md.age" → ".md"-less display, ".age" → bare base name.
    // Order matters: ".md.age" must be tested before ".age".
    let name = raw;
    if (name.endsWith(".md.age")) {
      name = name.slice(0, -".md.age".length);
    } else if (name.endsWith(".age")) {
      name = name.slice(0, -".age".length);
    }
    // Decision (v0.6.0): rely on getIcon() for the lock glyph rather
    // than prefixing an emoji here. Obsidian's icon API is the
    // first-class affordance; emoji prefix is the fallback if it
    // ever stops rendering. To switch, prepend `🔒 ` to `name`.
    const dirtyMark = this.dirty ? "● " : "";
    return `${dirtyMark}${name}`;
  }

  /** Build the static chrome once. File-specific content lands in onLoadFile. */
  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("halfday-age-view");

    // v0.6.0: no more inline status banner. The editor host fills the
    // whole content area; metadata lives in the bottom status bar.
    this.editorHost = contentEl.createDiv({ cls: "halfday-age-editor" });

    // cmd-S (manual save). Obsidian's global hotkey manager eats Mod-S
    // before CM6's keymap can see it, so we register on the view's own
    // Scope (which takes precedence when the view has focus) rather than
    // relying solely on the CM6 binding in mountEditor(). Parent is the
    // app scope so other shortcuts still fall through.
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "s", (evt) => {
      evt.preventDefault();
      void this.save("manual");
      return false;
    });
  }

  async onLoadFile(file: TFile): Promise<void> {
    if (!this.editorHost) return;
    this.cancelAutosave();
    this.teardownEditor();
    this.dirty = false;
    this.lastSavedAt = null;
    this.lastSavedBytes = null;

    try {
      const identity = await this.deps.getKeySource().getIdentity();
      const buf = await this.app.vault.readBinary(file);
      const ciphertext = new Uint8Array(buf);
      const plaintext = await decryptToString(identity, ciphertext);

      this.plaintext = plaintext;
      this.lastSavedBytes = ciphertext.byteLength;
      this.mountEditor(plaintext);
      this.updateTabHeader();
      this.pushStatusBar();
      console.log("[halfday-rune] age view decrypted", {
        path: file.path,
        plaintextLen: plaintext.length,
        ciphertextLen: ciphertext.byteLength,
      });
    } catch (err) {
      if (err instanceof KeyLockedError) {
        // the user dismissed the unlock prompt: not an error, just locked
        this.showLocked();
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Halfday Rune: decrypt failed — ${msg}`);
      this.teardownEditor();
      this.plaintext = null;
      // status bar shows nothing useful when the decrypt itself failed —
      // there's no byte count, no dirty state to report.
      this.deps.clearStatusBar();
      console.error("[halfday-rune] age view decrypt failed", err);
    }
  }

  /**
   * Write out unsaved edits if there are any. Safe to call from any trigger
   * (close, unload, backgrounding, blur): concurrent callers share one
   * flush, and a clean view is a no-op. A failed save shows its own Notice
   * (from save()) and is swallowed here so callers always continue.
   */
  async flushIfDirty(reason: SaveReason = "unload"): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.dirty || !this.editor) return;
    this.flushing = (async () => {
      try {
        await this.save(reason);
      } catch (err) {
        console.error("[halfday-rune] flush failed", err);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    // flush unsaved edits before dropping plaintext. we await rather than
    // fire-and-forget so the encrypted bytes land before the plugin or
    // workspace unwinds further. If save throws, we surface it via Notice
    // (save() already does that) and still complete the unload.
    await this.flushIfDirty();
    this.cancelAutosave();
    this.teardownEditor();
    this.plaintext = null;
    this.dirty = false;
    this.lastSavedAt = null;
    this.lastSavedBytes = null;
    this.deps.clearStatusBar();
  }

  async onClose(): Promise<void> {
    // leaving a note on mobile (and closing a tab on desktop) goes through
    // here, possibly without onUnloadFile: flush BEFORE tearing down.
    await this.flushIfDirty();
    this.cancelAutosave();
    this.teardownEditor();
    this.plaintext = null;
    this.editorHost = null;
    this.deps.clearStatusBar();
    this.contentEl.empty();
  }

  /**
   * Called by the plugin just BEFORE the key is dropped: write out unsaved
   * edits while the identity is still available. Errors are surfaced by
   * save() itself and swallowed here; the lock proceeds regardless.
   */
  async flushBeforeLock(): Promise<void> {
    if (!this.dirty || !this.editor) return;
    const before = this.editor.state.doc.toString();
    let failed = false;
    try {
      await this.save("unload");
    } catch {
      failed = true; // save() already showed its own Notice
    }
    const typedDuring =
      this.editor !== null && this.editor.state.doc.toString() !== before;
    if (failed || typedDuring || this.dirty) {
      new Notice("rune locked — your last edit could not be saved");
    }
  }

  /**
   * Called when the key has been locked: discard the decrypted text and
   * editor, and show a locked state with an Unlock button.
   */
  showLocked(): void {
    this.lockGen++;
    this.cancelAutosave();
    this.teardownEditor();
    this.plaintext = null;
    this.dirty = false;
    this.lastSavedAt = null;
    this.lastSavedBytes = null;
    this.deps.clearStatusBar();
    this.updateTabHeader();
    if (!this.editorHost) return;
    const host = this.editorHost;
    host.empty();
    const box = host.createDiv({ cls: "halfday-age-locked" });
    box.createEl("p", { text: "Locked. Unlock rune to read this note." });
    const btn = box.createEl("button", { text: "Unlock", cls: "mod-cta" });
    btn.addEventListener("click", () => {
      const f = this.file;
      if (f) void this.onLoadFile(f);
    });
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
        // v0.6.0: lineNumbers() removed. Obsidian's markdown views don't
        // show them; ours shouldn't either.
        highlightActiveLine(),
        // GFM = Strikethrough + Table + TaskList + Autolink. The default
        // markdown() is CommonMark-only, which means `~~strike~~` never
        // emits a strikethrough tag and the halfdayMarkdownHighlight rule
        // for tags.strikethrough above never fires. Enabling GFM unlocks
        // it (plus tables, task lists, and autolinks). All four are part
        // of what feels like "obsidian-flavored" markdown to users.
        markdown({ extensions: GFM }),
        // v0.6.2: full halfday decoration stack — headings, emphasis,
        // inline-code, links, lists, fenced code blocks, wikilinks. Despite
        // the name (kept for back-compat with v0.6.1), this now composes
        // both inline AND block decorations. Each module owns its own
        // ViewPlugin + DecorationSet; CM6 layers them in the rendered
        // output. Composed before syntaxHighlighting so any tokens the
        // decorations don't touch still pick up default colors as a
        // fallback.
        ...halfdayInlineDecorations(),
        // remaining tag-based styling — strikethrough, links/urls (defense-
        // in-depth alongside the link decoration; also covers bare URLs
        // outside Link nodes), and quotes. tags.list + tags.monospace were
        // removed in v0.6.2 — lists.ts and code-block.ts handle them.
        syntaxHighlighting(halfdayMarkdownHighlight),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        // cmd-S handler is *also* registered at the CM6 layer as a backup;
        // the authoritative one lives on this.scope (onOpen) because
        // Obsidian's global hotkey manager intercepts cmd-S before CM6
        // gets a look-in. Returning true stops browser save dialog if we
        // ever do catch it here.
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
        EditorView.domEventHandlers({
          blur: () => {
            if (this.deps.flushOnBlur) void this.flushIfDirty("background");
            return false;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            this.markDirty();
          }
        }),
        // v0.6.0: full theme inheritance from Obsidian CSS vars. Nothing
        // hardcoded — light/dark + community themes adapt without a
        // plugin reload. Heading scale + line-height are picked up by
        // halfdayMarkdownHighlight (above) using the same vars.
        // Defense-in-depth note: every var below has a literal fallback for
        // the load-bearing legibility props (background, body color, cursor
        // color). Obsidian's core stylesheet always defines these on body,
        // but a degenerate community theme that strips them would otherwise
        // fall through to user-agent defaults — unstyled white background
        // under a dark theme, invisible caret, etc. Cosmetic-only props
        // (line-height, selection) don't carry fallbacks: the worst case is
        // a slightly off-spec render, not invisible content.
        EditorView.theme({
          "&": {
            height: "100%",
            fontFamily: "var(--font-text)",
            fontSize: "var(--font-text-size)",
            backgroundColor: "var(--background-primary, #1e1e1e)",
            color: "var(--text-normal, #dcddde)",
            // v0.6.1 paragraph-breathing bump: Obsidian's --line-height-normal
            // is typically 1.6; that renders dense in our pane. Scale by 1.15
            // so blank lines (paragraph separators) take up more vertical
            // space. Calc keeps theme-awareness — if a community theme sets
            // --line-height-normal to 1.8, we end up at 2.07 which still
            // reads as "obsidian-y" rather than off-brand.
            lineHeight: "calc(var(--line-height-normal, 1.6) * 1.15)",
          },
          ".cm-scroller": {
            // the editor itself is the scroll container
            overflow: "auto",
            fontFamily: "inherit",
            lineHeight: "inherit",
          },
          ".cm-content": {
            // Obsidian's editor uses generous horizontal padding on wide
            // screens; we lean on the same spacing tokens so we inherit
            // any theme tweaks rather than baking pixel values in.
            padding: "var(--size-4-8, 2rem) var(--size-4-12, 4rem)",
            // caret-color tracks the cursor color so native browser
            // fallback (where CM6's overlay isn't visible yet) matches.
            caretColor: "var(--color-accent, #7f6df2)",
          },
          // v0.6.0: cursor — 2px and tinted with the theme accent so it's
          // legible against both light and dark backgrounds. CM6's default
          // blink (~1.2s) is fine; we don't override it.
          ".cm-cursor, .cm-dropCursor": {
            borderLeftColor: "var(--color-accent, #7f6df2)",
            borderLeftWidth: "2px",
          },
          ".cm-activeLine": {
            backgroundColor: "var(--background-modifier-hover)",
          },
          "&.cm-focused .cm-selectionBackground, ::selection": {
            backgroundColor: "var(--text-selection)",
          },
        }),
      ],
    });

    this.editor = new EditorView({ state, parent: this.editorHost });
    this.attachViewportListeners();
  }

  /**
   * CM6 only renders the lines inside its measured viewport. When the iOS
   * keyboard opens, the visual viewport shrinks; if CM measures while the
   * layout is mid-resize it can settle on a tiny viewport and leave the rest
   * blank. Ask it to re-measure on every viewport / workspace resize. This
   * only re-renders; the document is untouched.
   */
  attachViewportListeners(): void {
    this.detachViewport?.();
    this.detachViewport = null;
    if (!this.deps.remeasureOnViewport) return;
    let nudgeTimers: ReturnType<typeof setTimeout>[] = [];
    let debugTimer: ReturnType<typeof setTimeout> | null = null;
    const remeasure = (): void => {
      this.editor?.requestMeasure();
      // iOS WebKit can lay lines out (the caret has a position there) yet not
      // paint them after the keyboard resizes the viewport: nudge a repaint
      // once the resize settles.
      nudgeTimers.forEach(clearTimeout);
      nudgeTimers = [120, 450].map((ms) => setTimeout(() => this.forceRepaint(), ms));
    };
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    vv?.addEventListener("resize", remeasure);
    vv?.addEventListener("scroll", remeasure);
    const ref = this.app?.workspace?.on("resize", remeasure);
    const debugOnResize = (): void => {
      if (debugTimer !== null) clearTimeout(debugTimer);
      debugTimer = setTimeout(() => {
        // __RUNE_LAYOUT_DEBUG__ is a build-time constant: this whole call is removed
        // from release bundles.
        if (typeof __RUNE_LAYOUT_DEBUG__ !== "undefined" && __RUNE_LAYOUT_DEBUG__ === true && this.editor && this.editorHost) {
          void writeLayoutDebug(this.editor, this.editorHost, this.app.vault.adapter);
        }
      }, 800);
    };
    if (typeof __RUNE_LAYOUT_DEBUG__ !== "undefined" && __RUNE_LAYOUT_DEBUG__ === true) vv?.addEventListener("resize", debugOnResize);
    this.detachViewport = () => {
      nudgeTimers.forEach(clearTimeout);
      if (debugTimer !== null) clearTimeout(debugTimer);
      if (typeof __RUNE_LAYOUT_DEBUG__ !== "undefined" && __RUNE_LAYOUT_DEBUG__ === true) vv?.removeEventListener("resize", debugOnResize);
      vv?.removeEventListener("resize", remeasure);
      vv?.removeEventListener("scroll", remeasure);
      if (ref) this.app.workspace.offref(ref);
    };
  }

  /**
   * Repaint without touching focus (hiding the editor would drop the iOS
   * keyboard): re-measure, force a reflow, and flip the scroller's opacity
   * for one frame so WebKit repaints its tiles.
   */
  private forceRepaint(): void {
    const ed = this.editor;
    if (!ed) return;
    ed.requestMeasure();
    const sc = ed.scrollDOM as HTMLElement | undefined;
    if (!sc?.style) return;
    void (ed.contentDOM as HTMLElement | undefined)?.offsetHeight;
    sc.style.opacity = "0.999";
    const restore = (): void => {
      sc.style.opacity = "";
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
    else setTimeout(restore, 16);
  }

  private teardownEditor(): void {
    this.lockGen++;
    this.detachViewport?.();
    this.detachViewport = null;
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
    this.pushStatusBar();
    if (!wasDirty) this.updateTabHeader();
  }

  private scheduleAutosave(): void {
    this.cancelAutosave();
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      void this.save("autosave");
    }, this.deps.autosaveDelayMs ?? AUTOSAVE_DELAY_MS);
  }

  private cancelAutosave(): void {
    if (this.autosaveTimer !== null) {
      window.clearTimeout(this.autosaveTimer);
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
    if (this.inFlightSave !== null) {
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
    const gen = this.lockGen;
    this.cancelAutosave();

    try {
      const keys = this.deps.getKeySource();
      const recipients = await keys.getRecipients();
      const identity = await keys.getIdentity();

      // Mobile encrypts to the wrapped recipient list. Before overwriting
      // an existing note, require that our key opens it and that it has no
      // more recipient stanzas than the list has entries; otherwise a
      // recipient added on desktop since the copy was made would be silently
      // dropped. Refuse (and write nothing).
      if (keys.fixedRecipientList) {
        const existing = new Uint8Array(await this.app.vault.readBinary(file));
        const note = await inspectNoteForMobileSave(identity, existing);
        if (!note.ok) throw new RecipientListError(NOT_YOUR_KEY_NOTICE);
        if (note.x25519Stanzas + note.otherStanzas > recipients.length) {
          throw new RecipientListError(UNKNOWN_RECIPIENTS_NOTICE);
        }
      }

      // encrypt — multi-recipient capable; single-recipient is identical to v0.4
      const ciphertext = await encrypt(recipients, plaintext);

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

      // Locked (or the editor torn down) while the write was in flight: the
      // bytes are on disk, but do not resurrect any decrypted state.
      if (gen !== this.lockGen || !this.editor) return;

      this.plaintext = plaintext;
      this.dirty = false;
      this.lastSavedAt = new Date();
      this.lastSavedBytes = ciphertext.byteLength;
      const dt = Date.now() - startedAt;
      this.updateTabHeader();
      this.pushStatusBar();
      console.log("[halfday-rune] age view saved", {
        path: file.path,
        plaintextLen: plaintext.length,
        ciphertextLen: ciphertext.byteLength,
        dt,
        reason,
      });
    } catch (err) {
      if (err instanceof RecipientListError) {
        new Notice(err.message);
        this.pushStatusBar();
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Halfday Rune: save failed — ${msg}`);
      console.error("[halfday-rune] age view save failed", err);
      // still dirty — let the user retry or try cmd-S. Push state so
      // the status bar reflects the lingering dirtiness.
      this.pushStatusBar();
      throw err;
    }
  }

  /**
   * v0.6.0: push the current view state to the plugin's status-bar
   * item. The plugin renders the dot, the bytes, the saved time, and
   * the version string — view just describes its state.
   */
  private pushStatusBar(): void {
    const file = this.file;
    if (!file) {
      this.deps.clearStatusBar();
      return;
    }
    this.deps.updateStatusBar({
      filename: file.name,
      dirty: this.dirty,
      bytesOnDisk: this.lastSavedBytes,
      lastSavedAt: this.lastSavedAt,
    });
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
      // best-effort only; the tab title is cosmetic, save state is the
      // source of truth.
      console.debug("[halfday-rune] updateHeader unavailable", err);
    }
  }
}
