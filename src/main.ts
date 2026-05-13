/**
 * Halfday Obsidian Rune — v0.5.2
 *
 * Commands:
 *   - "Test round-trip (X25519)"     — v0.1, proves typage works in Electron
 *   - "Encrypt current note → .age"  — v0.2, seals an existing .md to .md.age
 *   - "New private note"             — v0.4, born-encrypted .age (plaintext
 *                                      never hits disk)
 *   - "Rotate vault keys"            — v0.5.2, re-encrypts every .age in the
 *                                      vault to the current recipients list
 *                                      (with optional pre-rotation tar.gz
 *                                      backup). Run after adding a backup
 *                                      recipient so existing files include it.
 *
 * Views:
 *   - AgeFileView (`.age` extension) — v0.3.2/0.4, decrypt-to-memory editable
 *     CodeMirror 6 editor with markdown syntax highlighting. cmd-S saves
 *     (re-encrypt + round-trip verify → overwrite .age) and a 30s debounced
 *     autosave kicks in after the last edit. Dirty state is reflected both in
 *     the status line and in the tab title bullet.
 *
 * v0.5.2 design notes:
 *   - Rotate command shells out to `tar` for the pre-rotation backup. The
 *     archive lands at ~/halfday/logs/age-backups/age-backup-{ISO}.tar.gz —
 *     out-of-vault so iCloud doesn't churn on it. Toggle via the new
 *     `autoBackupBeforeRotate` setting (default ON).
 *   - Per-file failures during rotate skip+continue rather than abort —
 *     a bad sectoral file shouldn't lose the rest. Summary is a Notice on
 *     all-success and a modal on partial failure.
 *   - On-save Notice in the recipients editor now points at "Rotate vault
 *     keys" when a new age1 recipient was added (deferred from v0.5.1).
 *   - Path-drift warning: if `recipientsPath` was changed in the field above
 *     while the textarea still holds content from the OLD path, Save
 *     prepends a red warning to the status line — content is written to
 *     the NEW path regardless (matches user intent of "this is where my
 *     recipients live now") but the warning makes the swap explicit.
 *
 * v0.5.1 design notes:
 *   - Settings tab now has an in-place "Recipients (file content)" editor:
 *     reads recipients.txt on tab open, lets the user edit raw content
 *     (preserving comments + ordering), validates+writes on Save, refuses
 *     to save malformed input with the offending line called out inline.
 *
 * v0.5.0 design notes:
 *   - Multi-recipient: encrypt path now reads `~/.age/recipients.txt` (one
 *     age1... pubkey per line, `#` lines = comments) and produces ciphertext
 *     decryptable by ANY of the matching identities. Backup recipient (e.g.
 *     a 1Password-stored second X25519 keypair) hedges against losing the
 *     primary identity.
 *   - Single-recipient case (1 line in recipients.txt) is byte-identical to
 *     v0.4 — existing `.age` files decrypt unchanged.
 *
 * v0.4 design notes (carried):
 *   - "classified" tier dropped — born-encrypted notes via "New private note"
 *     give the same guarantee without a separate tier.
 *   - Sidecars dropped — sealed notes are opaque (single .age file, no .meta.md).
 *     `~/halfday/logs/seal.log` is the audit trail for CLI seals; in-plugin
 *     activity goes through the JS console + Notice UI.
 *
 * The encrypt command mirrors _agent/seal.sh's behavior: encrypt, round-trip
 * verify in memory, write ciphertext, then (and only then) delete the plaintext
 * original. Any failure at any stage preserves the plaintext.
 *
 * See knowledge/projects/vault_plugin_v0_plan.md for the full milestone map.
 */

import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { AgeFileView, VIEW_TYPE_AGE } from "./age-view";
import type { AgeStatusBarState } from "./age-view";
import {
  decryptToString,
  encrypt,
  parseRecipientsFile,
  readIdentity,
  readRecipients,
  readRecipientsRaw,
  roundTrip,
  statRecipientsMtime,
  validateRecipientsContent,
  writeRecipientsRaw,
} from "./crypto";
import { rotateVault, recipientsChanged } from "./rotate";
import type { RotateResult } from "./rotate";
import { backupAgeFiles, DEFAULT_BACKUP_DIR } from "./backup";
import { makeRotateLogWriter } from "./rotate-log";

interface HalfdayObsidianRuneSettings {
  recipientsPath: string;
  identityPath: string;
  /**
   * v0.5.2: tar.gz every .age file before rotation. ON by default — rotation
   * is the most destructive plugin operation and the backup is the recovery
   * story. Toggle off only if you have your own backup discipline (Time
   * Machine + offsite, etc.).
   */
  autoBackupBeforeRotate: boolean;
}

const DEFAULT_SETTINGS: HalfdayObsidianRuneSettings = {
  recipientsPath: "~/.age/recipients.txt",
  identityPath: "~/.age/vault.identity",
  autoBackupBeforeRotate: true,
};

/** Plugin version surfaced in the status bar. Keep in sync with manifest.json. */
const PLUGIN_VERSION = "0.6.3";

export default class HalfdayObsidianRune extends Plugin {
  settings: HalfdayObsidianRuneSettings;

  /**
   * v0.6.0: bottom-of-workspace status-bar item. Hidden by default;
   * AgeFileView pushes state into it via `updateStatusBar` and clears
   * it via `clearStatusBar`. There's only ever one — Obsidian's status
   * bar reflects whichever AgeFileView leaf is currently active.
   */
  private statusBarEl: HTMLElement | null = null;
  /** Latest state the active AgeFileView has pushed. Held so leaf-changes can re-render. */
  private latestStatusState: AgeStatusBarState | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("halfday-rune-statusbar");
    this.statusBarEl.style.display = "none";

    this.addCommand({
      id: "halfday-rune-test-round-trip",
      name: "Test round-trip (X25519)",
      callback: () => this.testRoundTrip(),
    });

    this.addCommand({
      id: "halfday-rune-encrypt-current",
      name: "Encrypt current note → .age",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.encryptCurrentNote(file);
        return true;
      },
    });

    // v0.4: born-encrypted note. Prompts for a filename, creates a .age
    // file directly via vault.createBinary, and opens it in the AgeFileView.
    // No plaintext ever hits disk — this is the replacement for the old
    // "classified" tier.
    this.addCommand({
      id: "halfday-rune-new-private-note",
      name: "New private note",
      callback: () => this.newPrivateNote(),
    });

    // v0.5.2: rotate every .age file in the vault to the current
    // recipients list. Pre-flight confirm dialog + optional pre-rotation
    // tar.gz backup are intentional friction — this is the most destructive
    // plugin operation we ship.
    this.addCommand({
      id: "halfday-rune-rotate-keys",
      name: "Rotate vault keys",
      callback: () => this.rotateKeys(),
    });

    // v0.6.3: inverse of "Encrypt current note → .age". Reads a .age
    // file, decrypts it, writes a sibling .md, and (optionally) deletes
    // the .age. Two modes via the confirm modal — atomic replacement
    // (default) or scratch-only (keeps the .age intact). Refuses to
    // clobber an existing .md at the target path.
    this.addCommand({
      id: "halfday-rune-decrypt-to-md",
      name: "Decrypt current .age → .md",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "age") return false;
        if (!checking) this.decryptCurrentAge(file);
        return true;
      },
    });

    // v0.3.0: custom view + .age extension routing
    // v0.3.2: view also needs the recipient path so it can re-encrypt on save
    this.registerView(
      VIEW_TYPE_AGE,
      (leaf) =>
        new AgeFileView(leaf, {
          getIdentityPath: () => this.settings.identityPath,
          getRecipientsPath: () => this.settings.recipientsPath,
          updateStatusBar: (state) => this.updateAgeStatusBar(state),
          clearStatusBar: () => this.clearAgeStatusBar(),
        })
    );
    this.registerExtensions(["age"], VIEW_TYPE_AGE);

    // v0.6.0: hide the status-bar item whenever the active leaf is NOT
    // an AgeFileView. The view pushes fresh state on load/save/dirty so
    // we don't need to poll — but if the user clicks away from an
    // AgeFileView pane the bar should disappear.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const isAgeView = leaf?.view instanceof AgeFileView;
        if (!isAgeView) {
          this.hideAgeStatusBar();
        } else if (this.latestStatusState) {
          // Same plugin instance, different leaf — re-render in case we
          // were hidden. Each AgeFileView pushes state on focus via
          // pushStatusBar() too, but this covers the gap before the
          // view's own listeners fire.
          this.renderStatusBar(this.latestStatusState);
        }
      })
    );

    this.addSettingTab(new HalfdayRuneSettingTab(this.app, this));

    console.log("[halfday-rune] loaded");
  }

  onunload(): void {
    // detach any open AgeFileView instances so their plaintext buffers go away
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AGE);
    this.statusBarEl = null;
    this.latestStatusState = null;
    console.log("[halfday-rune] unloaded");
  }

  /**
   * v0.6.0: AgeFileView pushes state changes here. Owns rendering of
   * the dot, the bytes, the saved time, and the version. Kept simple —
   * one row of muted text + a colored dot on the left.
   */
  private updateAgeStatusBar(state: AgeStatusBarState): void {
    this.latestStatusState = state;
    this.renderStatusBar(state);
  }

  private clearAgeStatusBar(): void {
    this.latestStatusState = null;
    this.hideAgeStatusBar();
  }

  private hideAgeStatusBar(): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    this.statusBarEl.style.display = "none";
  }

  private renderStatusBar(state: AgeStatusBarState): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    this.statusBarEl.style.display = "";

    // dot: green when clean, orange when dirty. Use Obsidian's theme palette
    // vars so community themes can re-skin without plugin changes. Fallbacks
    // are the previous hardcoded hex literals so degenerate themes (or
    // partial overrides) still render visibly.
    const dot = this.statusBarEl.createSpan({
      cls: "halfday-rune-statusbar-dot",
    });
    dot.style.backgroundColor = state.dirty
      ? "var(--color-orange, #f59e0b)"
      : "var(--color-green, #4ade80)";

    this.statusBarEl.createSpan({
      cls: "halfday-rune-statusbar-state",
      text: state.dirty ? "dirty" : "clean",
    });

    if (state.bytesOnDisk !== null) {
      this.statusBarEl.createSpan({
        cls: "halfday-rune-statusbar-bytes",
        text: `${state.bytesOnDisk.toLocaleString()} bytes`,
      });
    }

    if (state.lastSavedAt) {
      const t = state.lastSavedAt.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      this.statusBarEl.createSpan({
        cls: "halfday-rune-statusbar-saved",
        text: `saved ${t}`,
      });
    }

    this.statusBarEl.createSpan({
      cls: "halfday-rune-statusbar-version",
      text: `v${PLUGIN_VERSION}`,
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * v0.1: Load configured recipient + identity, round-trip a unique test
   * string, and report success/failure via Notice. No files touched.
   */
  async testRoundTrip(): Promise<void> {
    const started = Date.now();
    const plaintext = `halfday-rune round-trip ${new Date().toISOString()}`;
    try {
      const recipients = readRecipients(this.settings.recipientsPath);
      const identity = readIdentity(this.settings.identityPath);
      const decoded = await roundTrip(recipients, identity, plaintext);
      const dt = Date.now() - started;
      if (decoded === plaintext) {
        new Notice(`Halfday Rune: round-trip ok (${dt}ms)`);
        console.log("[halfday-rune] round-trip ok", { dt, plaintext });
      } else {
        new Notice("Halfday Rune: round-trip MISMATCH — see console");
        console.error("[halfday-rune] round-trip mismatch", {
          plaintext,
          decoded,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Halfday Rune: round-trip failed — ${msg}`);
      console.error("[halfday-rune] round-trip failed", err);
    }
  }

  /**
   * v0.2 / updated in v0.4: Encrypt the active note to a sibling .age file
   * and delete the plaintext. Mirrors seal.sh's safety property — if any
   * step fails, the plaintext is preserved.
   *
   * v0.4 change: no sidecar is written anymore. Sealed notes are opaque.
   *
   * Refuses:
   *   - files that are already .age
   *   - files with `privacy: open` frontmatter
   *   - notes whose sibling .md.age already exists (no clobber)
   */
  async encryptCurrentNote(file: TFile): Promise<void> {
    const started = Date.now();
    try {
      // ---- preflight ----
      if (file.extension !== "md") {
        new Notice(
          `Halfday Rune: can only encrypt .md files (got .${file.extension})`
        );
        return;
      }

      const privacy = this.app.metadataCache.getFileCache(file)?.frontmatter
        ?.privacy;
      if (privacy === "open") {
        new Notice(
          "Halfday Rune: refusing to encrypt — this note is marked privacy: open"
        );
        return;
      }

      const sealedPath = `${file.path}.age`;

      if (this.app.vault.getAbstractFileByPath(sealedPath)) {
        new Notice(
          `Halfday Rune: refusing to overwrite existing ${sealedPath}`
        );
        return;
      }

      const recipients = readRecipients(this.settings.recipientsPath);
      const identity = readIdentity(this.settings.identityPath);

      // ---- encrypt ----
      const plaintext = await this.app.vault.read(file);
      const ciphertext = await encrypt(recipients, plaintext);

      // ---- round-trip verify in memory ----
      const decoded = await decryptToString(identity, ciphertext);
      if (decoded !== plaintext) {
        new Notice(
          "Halfday Rune: round-trip MISMATCH — plaintext preserved, see console"
        );
        console.error("[halfday-rune] encrypt round-trip mismatch", {
          file: file.path,
          plaintextLen: plaintext.length,
          decodedLen: decoded.length,
        });
        return;
      }

      // ---- write .age ----
      // Uint8Array → ArrayBuffer slice that Obsidian accepts
      const buffer = ciphertext.buffer.slice(
        ciphertext.byteOffset,
        ciphertext.byteOffset + ciphertext.byteLength
      ) as ArrayBuffer;
      await this.app.vault.createBinary(sealedPath, buffer);

      // ---- delete original plaintext ----
      // ciphertext + round-trip verify are durable before this point, so a
      // failure here leaves an .age on disk but the user still has the .md —
      // preferable to the inverse.
      await this.app.vault.delete(file);

      const dt = Date.now() - started;
      new Notice(
        `Halfday Rune: sealed ${file.name} → ${file.name}.age (${dt}ms)`
      );
      console.log("[halfday-rune] sealed", {
        file: file.path,
        sealedPath,
        dt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Halfday Rune: encrypt failed — ${msg}`);
      console.error("[halfday-rune] encrypt failed", err);
    }
  }

  /**
   * v0.4: Create a born-encrypted note. Plaintext never touches disk.
   *
   * Flow:
   *   1. Prompt for a filename (no extension needed; we append `.age`).
   *   2. Encrypt an empty string with the configured recipient.
   *   3. Round-trip verify in memory — bail if mismatch.
   *   4. vault.createBinary(name.age, ciphertext).
   *   5. Open it in AgeFileView so the user can start typing straight away.
   *
   * Refuses to clobber an existing file at the target path.
   */
  async newPrivateNote(): Promise<void> {
    const folder =
      this.app.workspace.getActiveFile()?.parent?.path ?? "";
    const suggested = this.suggestPrivateNoteName(folder);

    const filename = await promptForFilename(this.app, {
      title: "New private note",
      description:
        "Creates a born-encrypted .age file. Plaintext never hits disk. " +
        '".age" will be appended automatically if you leave it off.',
      defaultValue: suggested,
    });
    if (filename === null) return; // user cancelled

    const trimmed = filename.trim();
    if (!trimmed) {
      new Notice("Halfday Rune: filename required");
      return;
    }

    // normalize to a .age path, always rooted in folder (if any)
    const withExt = trimmed.endsWith(".age") ? trimmed : `${trimmed}.age`;
    const targetPath = folder ? `${folder}/${withExt}` : withExt;

    if (this.app.vault.getAbstractFileByPath(targetPath)) {
      new Notice(`Halfday Rune: already exists: ${targetPath}`);
      return;
    }

    try {
      const recipients = readRecipients(this.settings.recipientsPath);
      const identity = readIdentity(this.settings.identityPath);

      const emptyPlaintext = "";
      const ciphertext = await encrypt(recipients, emptyPlaintext);

      // round-trip verify in memory before touching disk
      const decoded = await decryptToString(identity, ciphertext);
      if (decoded !== emptyPlaintext) {
        new Notice(
          "Halfday Rune: round-trip MISMATCH on new note — aborting, nothing written"
        );
        console.error("[halfday-rune] new-private-note round-trip mismatch");
        return;
      }

      const buffer = ciphertext.buffer.slice(
        ciphertext.byteOffset,
        ciphertext.byteOffset + ciphertext.byteLength
      ) as ArrayBuffer;
      const created = await this.app.vault.createBinary(targetPath, buffer);

      // open in our view so the user can start typing; AgeFileView handles
      // the empty-doc decrypt path fine because we just verified it.
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(created);

      new Notice(`Halfday Rune: created ${targetPath}`);
      console.log("[halfday-rune] new private note", {
        path: targetPath,
        bytes: ciphertext.byteLength,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Halfday Rune: new private note failed — ${msg}`);
      console.error("[halfday-rune] new private note failed", err);
    }
  }

  /**
   * v0.5.2: Rotate every `.age` file in the vault to the current recipient
   * list. Two-stage flow:
   *
   *   1. Walk the vault for `.age` files; resolve recipients + identity from
   *      settings; if anything is missing or malformed, bail with a Notice
   *      BEFORE showing the confirm dialog (no friction-then-error).
   *   2. Show RotateConfirmModal with the file count + planned backup path.
   *      On confirm: optional tar.gz backup → rotate loop → summary
   *      (Notice on all-success, modal on partial failure).
   *
   * Per-file failures don't abort. The rotate logic itself lives in
   * src/rotate.ts so the loop is unit-testable without Obsidian.
   */
  async rotateKeys(): Promise<void> {
    // ---- preflight: collect inputs and fail loud if anything's broken ----
    let recipients: string[];
    let identity: string;
    try {
      recipients = readRecipients(this.settings.recipientsPath);
      identity = readIdentity(this.settings.identityPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Halfday Rune: rotate aborted — ${msg}`);
      console.error("[halfday-rune] rotate preflight failed", err);
      return;
    }

    const ageFiles = this.app.vault
      .getFiles()
      .filter((f) => f.extension === "age");

    if (ageFiles.length === 0) {
      new Notice("Halfday Rune: no .age files in vault — nothing to rotate");
      return;
    }

    // We can't know the absolute vault path from a TFile alone. Adapter has it.
    // This cast is the same one the Obsidian docs use for fs interop.
    const adapter = this.app.vault.adapter as unknown as {
      basePath?: string;
      getBasePath?: () => string;
    };
    const vaultBase =
      typeof adapter.getBasePath === "function"
        ? adapter.getBasePath()
        : adapter.basePath ?? "";

    // F1: if neither getBasePath() nor .basePath resolved a non-empty path,
    // we'd silently `tar -C ""` against Electron's cwd — wrong vault, possibly
    // archiving Obsidian's app bundle. Bail BEFORE any user-visible friction.
    if (!vaultBase) {
      new Notice(
        "Halfday Rune: cannot determine vault path — rotation aborted. Please file a bug.",
        10_000
      );
      console.error("[halfday-rune] rotate aborted — vaultBase empty", {
        adapterKind: this.app.vault.adapter?.constructor?.name,
      });
      return;
    }

    const planned = {
      fileCount: ageFiles.length,
      recipientCount: recipients.length,
      autoBackup: this.settings.autoBackupBeforeRotate,
      backupDir: DEFAULT_BACKUP_DIR,
    };

    const proceed = await confirmRotate(this.app, planned);
    if (!proceed) {
      console.log("[halfday-rune] rotate cancelled at confirm");
      return;
    }

    // F2/F4: persistent breadcrumb for the run. Survives modal-close so the
    // user can find skipped-file reasons hours later. Created lazily — first
    // append() ensures the parent dir.
    const rotateLog = makeRotateLogWriter();
    rotateLog.start({
      files: planned.fileCount,
      recipients: planned.recipientCount,
      autoBackup: planned.autoBackup,
    });

    // ---- backup ----
    let backupNote = "";
    if (planned.autoBackup) {
      try {
        const result = await backupAgeFiles(
          vaultBase,
          ageFiles.map((f) => f.path),
          DEFAULT_BACKUP_DIR
        );
        backupNote = `backup: ${result.path} (${result.bytes.toLocaleString()} bytes)`;
        console.log("[halfday-rune] rotate backup written", result);
        rotateLog.backup({ ok: true, path: result.path, bytes: result.bytes });
        new Notice(`Halfday Rune: backup written → ${result.path}`, 6_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(
          `Halfday Rune: rotate aborted — backup failed: ${msg}\nLog: ${rotateLog.path}`,
          10_000
        );
        console.error("[halfday-rune] rotate backup failed", err);
        rotateLog.backup({ ok: false, err: msg });
        // close out the log so the file ends with a clean END line
        rotateLog.end({ rotated: 0, skipped: 0 });
        return;
      }
    } else {
      backupNote = "backup skipped (autoBackupBeforeRotate=false)";
      console.log("[halfday-rune] rotate backup skipped per setting");
    }

    // ---- rotate ----
    const startedAt = Date.now();
    const result = await rotateVault(
      {
        vault: this.app.vault,
        crypto: { encrypt, decryptToString },
        logger: {
          log: (msg, ctx) => console.log(msg, ctx),
          error: (msg, ctx) => console.error(msg, ctx),
        },
        fileLog: {
          ok: (m) => rotateLog.file({ ok: true, ...m }),
          skip: (m) => rotateLog.file({ ok: false, ...m }),
        },
      },
      { ageFiles, identity, recipients }
    );
    const dt = Date.now() - startedAt;

    rotateLog.end({
      rotated: result.rotated.length,
      skipped: result.skipped.length,
    });

    // ---- surface ----
    console.log("[halfday-rune] rotate complete", {
      rotated: result.rotated.length,
      skipped: result.skipped.length,
      bytesBefore: result.totalBytes.before,
      bytesAfter: result.totalBytes.after,
      dt,
      backupNote,
      logPath: rotateLog.path,
    });

    if (result.skipped.length === 0) {
      // F2/F4: surface the log path on success too — the user might want
      // to verify which files were touched without diving into devtools.
      new Notice(
        `Halfday Rune: rotated ${result.rotated.length} file${
          result.rotated.length === 1 ? "" : "s"
        } in ${dt}ms\nLog: ${rotateLog.path}`,
        8_000
      );
    } else {
      // Modal so per-file failures stay visible without scrollback.
      new RotateSummaryModal(this.app, result, {
        dt,
        backupNote,
        logPath: rotateLog.path,
      }).open();
    }
  }

  /**
   * v0.6.3: Inverse of v0.2's encrypt command. Reads a .age file,
   * decrypts it with vault.identity, writes the plaintext as a sibling
   * .md, and (optionally) deletes the .age.
   *
   * Target path resolution:
   *   - `notes/foo.md.age` → `notes/foo.md` (strip the `.age` suffix)
   *   - `notes/foo.age`    → `notes/foo.md` (replace the `.age` ext)
   *   - any other shape   — refuses (defensive; shouldn't happen
   *     because the command's checkCallback only enables on .age files)
   *
   * Refuses to clobber an existing `.md` at the target path. Surfaces
   * the conflict via Notice — the user can rename the conflicting file
   * and retry.
   *
   * Two modes via DecryptConfirmModal:
   *   - "Decrypt and delete .age" (default — atomic replacement,
   *     inverse of the encrypt command's flow)
   *   - "Decrypt to scratch only" (writes .md, keeps the .age)
   *
   * Failure handling: if the decrypt itself throws (wrong identity,
   * corrupt ciphertext, etc.), nothing is written. If the .md write
   * succeeds but the subsequent .age delete fails, the .md stays on
   * disk and the user sees a Notice — same trade-off as the encrypt
   * command (preferable to losing the source).
   */
  async decryptCurrentAge(file: TFile): Promise<void> {
    const started = Date.now();
    try {
      if (file.extension !== "age") {
        new Notice(
          `Halfday Rune: can only decrypt .age files (got .${file.extension})`
        );
        return;
      }

      // Resolve target path. ".md.age" → ".md"; bare ".age" → ".md".
      // We keep the parent folder intact in both cases.
      let targetPath: string;
      if (file.path.endsWith(".md.age")) {
        targetPath = file.path.slice(0, -".age".length);
      } else if (file.path.endsWith(".age")) {
        targetPath = file.path.slice(0, -".age".length) + ".md";
      } else {
        new Notice(`Halfday Rune: unexpected file path: ${file.path}`);
        return;
      }

      if (this.app.vault.getAbstractFileByPath(targetPath)) {
        new Notice(
          `Halfday Rune: refusing to overwrite existing ${targetPath}`,
          8_000
        );
        return;
      }

      const mode = await promptForDecryptMode(this.app, {
        sourcePath: file.path,
        targetPath,
      });
      if (mode === null) return; // user cancelled

      // ---- decrypt ----
      const identity = readIdentity(this.settings.identityPath);
      const buf = await this.app.vault.readBinary(file);
      const ciphertext = new Uint8Array(buf);
      const plaintext = await decryptToString(identity, ciphertext);

      // ---- write .md ----
      const created = await this.app.vault.create(targetPath, plaintext);

      // ---- optional .age delete ----
      if (mode === "replace") {
        try {
          await this.app.vault.delete(file);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(
            `Halfday Rune: decrypted to ${targetPath} but failed to delete ${file.name} — ${msg}`,
            10_000
          );
          console.error("[halfday-rune] decrypt .age delete failed", err);
          return;
        }
      }

      // ---- open the new .md so the user lands on it ----
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(created);

      const dt = Date.now() - started;
      const verb = mode === "replace" ? "decrypted (replaced)" : "decrypted (scratch)";
      new Notice(`Halfday Rune: ${verb} ${targetPath} (${dt}ms)`);
      console.log("[halfday-rune] decrypt to md", {
        source: file.path,
        target: targetPath,
        mode,
        bytes: plaintext.length,
        dt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Halfday Rune: decrypt failed — ${msg}`);
      console.error("[halfday-rune] decrypt to md failed", err);
    }
  }

  /**
   * Suggest `untitled.age`, `untitled-2.age`, … that doesn't already exist
   * in the chosen folder. The user can overwrite this in the prompt.
   */
  private suggestPrivateNoteName(folder: string): string {
    const base = "untitled";
    const candidate = (n: number) =>
      n === 1 ? `${base}.age` : `${base}-${n}.age`;
    for (let i = 1; i < 1000; i++) {
      const name = candidate(i);
      const full = folder ? `${folder}/${name}` : name;
      if (!this.app.vault.getAbstractFileByPath(full)) return name;
    }
    return `${base}-${Date.now()}.age`;
  }
}

/**
 * Tiny modal that asks for a single text value and resolves with the string
 * (null on cancel). Kept inline — not worth a second file.
 */
class FilenamePromptModal extends Modal {
  private value: string;
  private resolved = false;
  private readonly opts: {
    title: string;
    description: string;
    defaultValue: string;
  };
  private readonly resolver: (value: string | null) => void;

  constructor(
    app: App,
    opts: { title: string; description: string; defaultValue: string },
    resolver: (value: string | null) => void
  ) {
    super(app);
    this.opts = opts;
    this.resolver = resolver;
    this.value = opts.defaultValue;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.opts.title });
    contentEl.createEl("p", { text: this.opts.description });

    const input = contentEl.createEl("input", { type: "text" });
    input.value = this.opts.defaultValue;
    input.style.width = "100%";
    input.style.marginTop = "0.5rem";
    input.addEventListener("input", () => {
      this.value = input.value;
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.resolve(this.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.resolve(null);
      }
    });

    const buttons = contentEl.createDiv();
    buttons.style.display = "flex";
    buttons.style.gap = "0.5rem";
    buttons.style.justifyContent = "flex-end";
    buttons.style.marginTop = "1rem";

    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.resolve(null));

    const okBtn = buttons.createEl("button", { text: "Create", cls: "mod-cta" });
    okBtn.addEventListener("click", () => this.resolve(this.value));

    // select the "untitled" portion so the user can overwrite in place
    setTimeout(() => {
      input.focus();
      const dotAge = input.value.lastIndexOf(".age");
      if (dotAge > 0) input.setSelectionRange(0, dotAge);
      else input.select();
    }, 0);
  }

  onClose(): void {
    // user closed without choosing (e.g. clicked outside)
    this.resolve(null);
    this.contentEl.empty();
  }

  private resolve(value: string | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolver(value);
    this.close();
  }
}

async function promptForFilename(
  app: App,
  opts: { title: string; description: string; defaultValue: string }
): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new FilenamePromptModal(app, opts, resolve);
    modal.open();
  });
}

/**
 * v0.6.3: Confirm modal for "Decrypt current .age → .md".
 *
 * Two outcomes:
 *   - "replace" — decrypt to .md AND delete the .age (atomic; the
 *     inverse of "Encrypt current note → .age"). Highlighted as the
 *     mod-cta button but NOT auto-focused — Cancel is, so accidental
 *     Enter on the modal cancels rather than deletes.
 *   - "scratch" — decrypt to .md and leave the .age intact. Useful for
 *     one-off inspection or when the user wants to keep the sealed
 *     copy around as the canonical version.
 *   - `null` — Cancel / Esc / click-outside. Nothing happens.
 *
 * "Replace" is presented as the .mod-cta button because it's the
 * inverse of the encrypt flow — symmetry with that command's behaviour
 * is the least surprising default for a user reaching for this
 * command. The scratch option sits beside it so users who want it can
 * pick it without dropping into a settings menu.
 */
type DecryptMode = "replace" | "scratch";

interface DecryptPlan {
  sourcePath: string;
  targetPath: string;
}

class DecryptConfirmModal extends Modal {
  private chosen: DecryptMode | null = null;
  private readonly plan: DecryptPlan;
  private readonly resolver: (m: DecryptMode | null) => void;

  constructor(
    app: App,
    plan: DecryptPlan,
    resolver: (m: DecryptMode | null) => void
  ) {
    super(app);
    this.plan = plan;
    this.resolver = resolver;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Decrypt .age → .md" });

    const summary = contentEl.createEl("p");
    summary.createSpan({ text: "Decrypt " });
    summary.createEl("code", { text: this.plan.sourcePath });
    summary.createSpan({ text: " to " });
    summary.createEl("code", { text: this.plan.targetPath });
    summary.createSpan({ text: "." });

    contentEl.createEl("p", {
      text:
        "Atomic mode: decrypt to .md AND delete the .age. This is the inverse of 'Encrypt current note → .age'.",
    });
    contentEl.createEl("p", {
      text:
        "Scratch mode: decrypt to .md and leave the .age intact. Use this for one-off inspection or if you want to keep the sealed copy as the canonical version.",
    });

    const buttons = contentEl.createDiv();
    buttons.style.display = "flex";
    buttons.style.gap = "0.5rem";
    buttons.style.justifyContent = "flex-end";
    buttons.style.marginTop = "1rem";

    // Cancel comes first in keyboard order and is auto-focused so
    // hitting Enter on the modal doesn't accidentally delete the
    // .age. Same destructive-default avoidance as the rotate-keys
    // confirm modal.
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const scratchBtn = buttons.createEl("button", {
      text: "Decrypt to scratch only",
    });
    scratchBtn.addEventListener("click", () => {
      this.chosen = "scratch";
      this.close();
    });

    const replaceBtn = buttons.createEl("button", {
      text: "Decrypt and delete .age",
      cls: "mod-cta",
    });
    replaceBtn.addEventListener("click", () => {
      this.chosen = "replace";
      this.close();
    });

    contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    setTimeout(() => cancelBtn.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolver(this.chosen);
  }
}

async function promptForDecryptMode(
  app: App,
  plan: DecryptPlan
): Promise<DecryptMode | null> {
  return new Promise((resolve) => {
    const modal = new DecryptConfirmModal(app, plan, resolve);
    modal.open();
  });
}

/**
 * v0.5.2: Pre-flight confirmation for the rotate command. Friction is
 * intentional — rotation re-encrypts every .age file and we want the user
 * to see the file count + backup destination before they commit.
 *
 * Resolves true on "Rotate", false on Cancel / dismiss.
 */
interface RotatePlan {
  fileCount: number;
  recipientCount: number;
  autoBackup: boolean;
  backupDir: string;
}

class RotateConfirmModal extends Modal {
  private result: boolean = false;
  private readonly plan: RotatePlan;
  private readonly resolver: (proceed: boolean) => void;

  constructor(app: App, plan: RotatePlan, resolver: (p: boolean) => void) {
    super(app);
    this.plan = plan;
    this.resolver = resolver;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Rotate vault keys" });

    const summary = contentEl.createEl("p");
    summary.createSpan({
      text: `About to re-encrypt `,
    });
    summary.createEl("strong", {
      text: `${this.plan.fileCount} .age file${this.plan.fileCount === 1 ? "" : "s"}`,
    });
    summary.createSpan({
      text: ` to your current ${this.plan.recipientCount} recipient${
        this.plan.recipientCount === 1 ? "" : "s"
      }.`,
    });

    if (this.plan.autoBackup) {
      const p = contentEl.createEl("p");
      p.createSpan({ text: "A tar.gz backup will be created first at " });
      p.createEl("code", { text: this.plan.backupDir });
      p.createSpan({ text: "/age-backup-{ISO}.tar.gz before any file is touched." });
    } else {
      // M3: when auto-backup is OFF the modal needs to look and read
      // differently. Sharper copy + de-emphasized proceed button so the
      // user can't Enter-key past it without noticing.
      const p = contentEl.createEl("p", {
        cls: "halfday-rune-warning",
      });
      p.setText(
        "Backup is OFF. Existing .age files will be re-encrypted with no " +
          "safety net. A failure mid-rotation could leave you with " +
          "partially-rotated files and no recovery archive."
      );
    }

    contentEl.createEl("p", {
      text:
        "Files the primary identity can't decrypt (e.g. sealed to a recipient you no longer hold) " +
        "will be skipped with a logged reason — they remain readable by whichever identity matches.",
    });

    // F9: re-run safety. The rotate operation is idempotent at the
    // ciphertext-content level (re-encrypting twice produces the same
    // recipient list); telling the user this up front lowers the
    // psychological cost of cancelling halfway and starting over.
    contentEl.createEl("p", {
      text:
        "Safe to re-run on a partially-rotated vault — already-rotated files will just rotate again.",
    });

    const buttons = contentEl.createDiv();
    buttons.style.display = "flex";
    buttons.style.gap = "0.5rem";
    buttons.style.justifyContent = "flex-end";
    buttons.style.marginTop = "1rem";

    // M2: Cancel comes first in the button row AND in tab order, and it's
    // the auto-focused button. macOS HIG + Obsidian's own delete dialog
    // do the same — "destructive defaults" is an anti-pattern.
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    // M3: when backup is off, drop `mod-cta` (so it's not the visually
    // emphasized button) AND change the label to make the missing
    // safety net legible from the button alone.
    const proceedLabel = this.plan.autoBackup ? "Rotate" : "Rotate without backup";
    const proceedCls = this.plan.autoBackup ? "mod-cta" : "";
    const okBtn = buttons.createEl("button", {
      text: proceedLabel,
      cls: proceedCls,
    });
    okBtn.addEventListener("click", () => {
      this.result = true;
      this.close();
    });

    // F10: explicit Escape handler. Click-outside already dismissed via
    // onClose; this just makes the keyboard path symmetric with
    // FilenamePromptModal and explicit for screen-readers / keyboard
    // users who expect Esc to cancel.
    contentEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    // M2: focus Cancel by default. Hitting Enter on the modal now triggers
    // Cancel, which is the safe outcome for a destructive operation.
    setTimeout(() => cancelBtn.focus(), 0);
  }

  // F6: simplified resolution. Cancel + Esc + click-outside all flow
  // through `close() → onClose()`, which is the single resolver. The
  // proceed button sets `this.result = true` then closes; everything
  // else leaves `result` at its default `false`.
  onClose(): void {
    this.contentEl.empty();
    this.resolver(this.result);
  }
}

async function confirmRotate(app: App, plan: RotatePlan): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new RotateConfirmModal(app, plan, resolve);
    modal.open();
  });
}

/**
 * v0.5.2: Shown only on PARTIAL failure (the all-success path uses a Notice).
 * Lists the rotated count + every skipped file with its failure reason.
 * Verbose by design — the user needs paths to act on, and console scrollback
 * is unreliable when Obsidian is busy.
 */
class RotateSummaryModal extends Modal {
  private readonly result: RotateResult;
  private readonly meta: { dt: number; backupNote: string; logPath: string };

  constructor(
    app: App,
    result: RotateResult,
    meta: { dt: number; backupNote: string; logPath: string }
  ) {
    super(app);
    this.result = result;
    this.meta = meta;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Rotate vault keys — partial success" });

    const stats = contentEl.createEl("p");
    stats.createEl("strong", {
      text: `${this.result.rotated.length} rotated, ${this.result.skipped.length} skipped`,
    });
    stats.createSpan({ text: ` in ${this.meta.dt}ms` });

    contentEl.createEl("p", { text: this.meta.backupNote });

    // F2/F4: log path inline, prefixed and selectable.
    const logLine = contentEl.createEl("p");
    logLine.createSpan({ text: "Log: " });
    logLine.createEl("code", { text: this.meta.logPath });

    if (this.result.skipped.length > 0) {
      contentEl.createEl("h3", { text: "Skipped files" });
      const list = contentEl.createEl("ul");
      list.style.maxHeight = "260px";
      list.style.overflowY = "auto";
      list.style.fontFamily = "var(--font-monospace, monospace)";
      list.style.fontSize = "var(--font-ui-small, 13px)";
      for (const s of this.result.skipped) {
        const li = list.createEl("li");
        li.createEl("strong", { text: s.file.path });
        li.createSpan({ text: ` — ${s.reason}: ${s.error}` });
      }
    }

    contentEl.createEl("p", {
      text:
        "Skipped files were left untouched on disk. Common cause: the file " +
        "was sealed to a recipient your primary identity doesn't hold. " +
        "Decrypt with the matching identity and re-seal, or remove the " +
        "stale file before rotating again.",
    });

    const buttons = contentEl.createDiv();
    buttons.style.display = "flex";
    buttons.style.gap = "0.5rem";
    buttons.style.justifyContent = "flex-end";
    buttons.style.marginTop = "1rem";

    // F5: copy-log-path button. Lets the user paste the path into a
    // terminal / Finder Go-to-folder. The button stays in this slot for
    // any future copy-failure-list addition.
    const copyBtn = buttons.createEl("button", { text: "Copy log path" });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard
        .writeText(this.meta.logPath)
        .then(() => new Notice("Halfday Rune: log path copied"))
        .catch((err) => {
          console.error("[halfday-rune] clipboard write failed", err);
          new Notice("Halfday Rune: copy failed — see console");
        });
    });

    const okBtn = buttons.createEl("button", {
      text: "Close",
      cls: "mod-cta",
    });
    okBtn.addEventListener("click", () => this.close());
    setTimeout(() => okBtn.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class HalfdayRuneSettingTab extends PluginSettingTab {
  plugin: HalfdayObsidianRune;

  constructor(app: App, plugin: HalfdayObsidianRune) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Halfday Obsidian Rune" });
    containerEl.createEl("p", {
      text:
        "Encrypts and decrypts notes using one or more X25519 age recipients. " +
        "Configure paths to your recipients file (public keys) and identity (private key) below. " +
        "Generate a keypair with `age-keygen -o ~/.age/vault.identity` and put each recipient " +
        "(public key) line in `~/.age/recipients.txt`. Lines starting with `#` are treated as " +
        "comments — useful for labeling each recipient (e.g. `# main mac` on the line above its key).",
    });

    new Setting(containerEl)
      .setName("Recipients file path")
      .setDesc(
        'File containing one or more age recipient lines (each starting with "age1..."). ' +
          'Lines starting with "#" are comments. Tilde expands to your home directory. ' +
          "If the file is missing or malformed, encrypt-related commands will fail loudly."
      )
      .addText((text) =>
        text
          .setPlaceholder("~/.age/recipients.txt")
          .setValue(this.plugin.settings.recipientsPath)
          .onChange(async (value) => {
            this.plugin.settings.recipientsPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Identity path")
      .setDesc(
        "File containing your age identity (AGE-SECRET-KEY-1...). The plugin reads this on demand; it is never written anywhere."
      )
      .addText((text) =>
        text
          .setPlaceholder("~/.age/vault.identity")
          .setValue(this.plugin.settings.identityPath)
          .onChange(async (value) => {
            this.plugin.settings.identityPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // v0.5.2: pre-rotation backup toggle. ON by default — see RotateConfirmModal
    // copy. The backup lands at ~/halfday/logs/age-backups/, out-of-vault.
    new Setting(containerEl)
      .setName("Auto-backup before rotate")
      .setDesc(
        "When running 'Rotate vault keys', tar.gz every .age file to " +
          "~/halfday/logs/age-backups/ before re-encrypting. Recommended ON. " +
          "Turn off only if you have your own backup discipline."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoBackupBeforeRotate)
          .onChange(async (value) => {
            this.plugin.settings.autoBackupBeforeRotate = value;
            await this.plugin.saveSettings();
          })
      );

    // v0.5.1: in-place editor for recipients.txt content. The path field
    // above controls WHICH file this textarea operates on. We use raw
    // containerEl primitives rather than a Setting row because Obsidian's
    // standard Setting layout cramps a multi-line textarea.
    this.renderRecipientsEditor(containerEl);
  }

  /**
   * v0.5.1: Render the "Recipients (file content)" section. Reads
   * recipients.txt from disk on tab open, lets the user edit it inline,
   * validates on save, writes verbatim (preserving comments + blank
   * lines + ordering).
   *
   * Status messages render inline below the buttons. Validation errors
   * keep the textarea contents intact so the user can fix and retry.
   *
   * v0.5.2 carryovers:
   *   - on-save Notice when a new age1 recipient was added, pointing at
   *     "Rotate vault keys" so existing files pick up the new key
   *   - path-drift warning when `recipientsPath` was changed in the field
   *     above while the textarea still holds content from the OLD path:
   *     prepends a red warning to the status line on Save
   */
  private renderRecipientsEditor(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Recipients (file content)" });
    containerEl.createEl("p", {
      text:
        "Edit your recipients file directly. One age1... recipient per line; lines starting with # are preserved as comments. Save validates the entire file before writing — malformed input refuses to save with the offending line called out below.",
    });

    const textareaEl = containerEl.createEl("textarea", {
      cls: "halfday-rune-recipients-textarea",
    });
    textareaEl.rows = 10;
    textareaEl.spellcheck = false;
    textareaEl.style.width = "100%";
    textareaEl.style.fontFamily = "var(--font-monospace, monospace)";
    textareaEl.style.fontSize = "var(--font-ui-small, 13px)";
    textareaEl.style.padding = "0.5em";

    // status / error line. Emptied + cleared on every successful action.
    const statusEl = containerEl.createEl("div", {
      cls: "halfday-rune-recipients-status",
    });
    statusEl.style.marginTop = "0.5em";
    statusEl.style.fontSize = "var(--font-ui-small, 13px)";
    statusEl.style.minHeight = "1.5em";

    const setStatus = (msg: string, isError = false): void => {
      statusEl.setText(msg);
      if (isError) {
        statusEl.addClass("halfday-rune-error");
      } else {
        statusEl.removeClass("halfday-rune-error");
      }
    };

    // v0.5.2: track which path the textarea content was loaded from, so
    // Save can warn if the path field has been edited since load.
    let lastLoadedFromPath: string = this.plugin.settings.recipientsPath;
    // v0.6.3: capture mtime on populate so Save can detect external
    // edits before stomping them. `null` means "file didn't exist when
    // we loaded" — first-write semantics; we don't enforce the mtime
    // check in that case because there's nothing to stomp.
    let lastLoadedMtime: number | null = null;

    // initial load from disk
    const loadFromDisk = (announce: boolean = false): void => {
      try {
        const result = readRecipientsRaw(
          this.plugin.settings.recipientsPath
        );
        textareaEl.value = result.content;
        lastLoadedFromPath = this.plugin.settings.recipientsPath;
        try {
          lastLoadedMtime = statRecipientsMtime(
            this.plugin.settings.recipientsPath
          );
        } catch {
          // stat failed for a reason other than ENOENT — leave mtime
          // null. The on-save check will then refuse to enforce
          // staleness (best-effort), but the read above already
          // surfaced the deeper problem if there was one.
          lastLoadedMtime = null;
        }
        if (!result.exists) {
          setStatus(
            `recipients.txt does not exist yet at ${this.plugin.settings.recipientsPath} — paste your age1... recipients above and click Save to create it.`
          );
        } else if (announce) {
          setStatus(
            `loaded ${result.content.length.toLocaleString()} bytes from ${this.plugin.settings.recipientsPath}`
          );
        } else {
          setStatus("");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        textareaEl.value = "";
        setStatus(`read failed: ${msg}`, /*isError*/ true);
        console.error("[halfday-rune] recipients read failed", err);
      }
    };
    loadFromDisk(/*announce*/ false);

    // buttons row
    const buttonsEl = containerEl.createDiv();
    buttonsEl.style.display = "flex";
    buttonsEl.style.gap = "0.5rem";
    buttonsEl.style.marginTop = "0.5rem";

    const saveBtn = buttonsEl.createEl("button", {
      text: "Save recipients",
      cls: "mod-cta",
    });
    saveBtn.addEventListener("click", () => {
      const content = textareaEl.value;
      const validation = validateRecipientsContent(content);
      if (!validation.ok) {
        setStatus(`✗ ${validation.error}`, /*isError*/ true);
        return;
      }

      // v0.6.3: modified-on-disk detector. If the file's mtime
      // advanced between populate and Save, someone (or some other
      // process) edited it externally. Refuse the save and offer a
      // Reload affordance — the standard "external edits detected"
      // pattern.
      //
      // We skip this check when:
      //   - mtime was null at load (file didn't exist; first-write
      //     semantics — nothing to stomp)
      //   - the path field changed since load (the existing v0.5.2
      //     drift warning already covers this; mtime check against a
      //     DIFFERENT file's mtime would be misleading)
      const pathSameAsLoaded =
        this.plugin.settings.recipientsPath === lastLoadedFromPath;
      if (pathSameAsLoaded && lastLoadedMtime !== null) {
        let currentMtime: number | null = null;
        try {
          currentMtime = statRecipientsMtime(
            this.plugin.settings.recipientsPath
          );
        } catch (err) {
          // If we can't stat, fall through to the write — the write
          // will surface the same I/O error in a clearer place.
          console.warn("[halfday-rune] mtime stat failed", err);
        }
        if (currentMtime !== null && currentMtime > lastLoadedMtime) {
          setStatus(
            `✗ ${this.plugin.settings.recipientsPath} was modified on disk since you opened this tab — click "Reload from disk" to pick up the external edit (your current textarea contents will be lost), then re-apply your changes.`,
            /*isError*/ true
          );
          new Notice(
            "Halfday Rune: recipients.txt was modified externally — refusing to overwrite. Reload from disk to merge.",
            10_000
          );
          return;
        }
      }

      // v0.5.2: capture the pre-write disk content for the on-save Notice's
      // recipient-diff. Best-effort — if read fails (path changed to
      // somewhere we can't read, file doesn't exist yet), we just skip the
      // diff and surface a generic save Notice.
      let prevRecipients: string[] = [];
      try {
        const prev = readRecipientsRaw(this.plugin.settings.recipientsPath);
        if (prev.exists) {
          prevRecipients = parseRecipientsFile(prev.content);
        }
      } catch {
        // malformed prior content / unreadable — diff against empty,
        // which means every recipient in the new content reads as "added"
        // and we'll still surface the rotate-keys hint. Acceptable.
      }

      // v0.5.2: path-drift detection. Done BEFORE write because the write
      // commits to the (possibly drifted) path regardless — this just
      // makes the swap visible.
      const drifted =
        this.plugin.settings.recipientsPath !== lastLoadedFromPath;

      try {
        writeRecipientsRaw(
          this.plugin.settings.recipientsPath,
          content
        );

        const driftPrefix = drifted
          ? `⚠ recipients file path was changed since load (${lastLoadedFromPath} → ${this.plugin.settings.recipientsPath}) — saved to the NEW path with the editor's contents. `
          : "";
        setStatus(
          `${driftPrefix}✓ saved ${content.length.toLocaleString()} bytes to ${this.plugin.settings.recipientsPath}`,
          /*isError*/ drifted
        );
        // textarea now reflects what's on disk at the new path
        lastLoadedFromPath = this.plugin.settings.recipientsPath;
        // v0.6.3: refresh the mtime baseline so subsequent saves
        // don't see OUR write as a stale-edit conflict.
        try {
          lastLoadedMtime = statRecipientsMtime(
            this.plugin.settings.recipientsPath
          );
        } catch {
          lastLoadedMtime = null;
        }

        // v0.5.2: on-save Notice for recipient list changes. Diff against
        // the pre-write disk content (parseRecipientsFile already did
        // dedup + comment stripping). Surfaces additions AND removals —
        // a removed recipient is security-relevant (existing .age headers
        // still encode it; rotation is the only way to drop it
        // everywhere).
        let newRecipients: string[] = [];
        try {
          newRecipients = parseRecipientsFile(content);
        } catch {
          // shouldn't happen — validateRecipientsContent already passed.
        }
        const diff = recipientsChanged(prevRecipients, newRecipients);
        const addedAny = diff.added.length > 0;
        const removedAny = diff.removed.length > 0;
        if (addedAny && removedAny) {
          new Notice(
            "Halfday Rune: recipient list changed (added + removed). Existing sealed files reflect the OLD list — run 'Rotate vault keys' to sync.",
            10_000
          );
        } else if (addedAny) {
          new Notice(
            "Halfday Rune: recipient added. Existing sealed files don't include it yet — run 'Rotate vault keys' to add it everywhere.",
            10_000
          );
        } else if (removedAny) {
          new Notice(
            "Halfday Rune: recipient removed from list. Existing sealed files still contain it in their header — run 'Rotate vault keys' to drop it.",
            10_000
          );
        } else {
          new Notice("Halfday Rune: recipients saved");
        }
        console.log("[halfday-rune] recipients saved", {
          path: this.plugin.settings.recipientsPath,
          bytes: content.length,
          added: diff.added,
          removed: diff.removed,
          drifted,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`✗ write failed: ${msg}`, /*isError*/ true);
        console.error("[halfday-rune] recipients write failed", err);
      }
    });

    const reloadBtn = buttonsEl.createEl("button", {
      text: "Reload from disk",
    });
    reloadBtn.addEventListener("click", () => {
      loadFromDisk(/*announce*/ true);
    });
  }
}
