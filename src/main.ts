/**
 * Halfday Obsidian Rune — v0.5.0
 *
 * Commands:
 *   - "Test round-trip (X25519)"     — v0.1, proves typage works in Electron
 *   - "Encrypt current note → .age"  — v0.2, seals an existing .md to .md.age
 *   - "New private note"             — v0.4, born-encrypted .age (plaintext
 *                                      never hits disk)
 *
 * Views:
 *   - AgeFileView (`.age` extension) — v0.3.2/0.4, decrypt-to-memory editable
 *     CodeMirror 6 editor with markdown syntax highlighting. cmd-S saves
 *     (re-encrypt + round-trip verify → overwrite .age) and a 30s debounced
 *     autosave kicks in after the last edit. Dirty state is reflected both in
 *     the status line and in the tab title bullet.
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
import {
  decryptToString,
  encrypt,
  readIdentity,
  readRecipients,
  roundTrip,
} from "./crypto";

interface HalfdayObsidianRuneSettings {
  recipientsPath: string;
  identityPath: string;
}

const DEFAULT_SETTINGS: HalfdayObsidianRuneSettings = {
  recipientsPath: "~/.age/recipients.txt",
  identityPath: "~/.age/vault.identity",
};

export default class HalfdayObsidianRune extends Plugin {
  settings: HalfdayObsidianRuneSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

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

    // v0.3.0: custom view + .age extension routing
    // v0.3.2: view also needs the recipient path so it can re-encrypt on save
    this.registerView(
      VIEW_TYPE_AGE,
      (leaf) =>
        new AgeFileView(leaf, {
          getIdentityPath: () => this.settings.identityPath,
          getRecipientsPath: () => this.settings.recipientsPath,
        })
    );
    this.registerExtensions(["age"], VIEW_TYPE_AGE);

    this.addSettingTab(new HalfdayRuneSettingTab(this.app, this));

    console.log("[halfday-rune] loaded");
  }

  onunload(): void {
    // detach any open AgeFileView instances so their plaintext buffers go away
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AGE);
    console.log("[halfday-rune] unloaded");
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
  }
}
