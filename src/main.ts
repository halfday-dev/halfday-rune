/**
 * Halfday Obsidian Rune — v0.3.2
 *
 * Commands:
 *   - "Test round-trip (X25519)"  — v0.1, proves typage works in Electron
 *   - "Encrypt current note → .age" — v0.2, seals an existing .md to .md.age
 *
 * Views:
 *   - AgeFileView (`.age` extension) — v0.3.2, decrypt-to-memory editable
 *     CodeMirror 6 editor with markdown syntax highlighting. cmd-S saves
 *     (re-encrypt + round-trip verify → overwrite .age + sidecar) and a
 *     30s debounced autosave kicks in after the last edit. Dirty state is
 *     reflected both in the status line and in the tab title bullet.
 *
 * The encrypt command mirrors _agent/seal.sh's behavior: encrypt, round-trip
 * verify in memory, write ciphertext + sidecar, then (and only then) delete
 * the plaintext original. Any failure at any stage preserves the plaintext.
 *
 * See knowledge/projects/vault_plugin_v0_plan.md for the full milestone map.
 */

import {
  App,
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import * as path from "path";
import { AgeFileView, VIEW_TYPE_AGE } from "./age-view";
import {
  decryptToString,
  encrypt,
  readIdentity,
  readRecipient,
  roundTrip,
} from "./crypto";
import { generateSidecar } from "./sidecar";

interface HalfdayObsidianRuneSettings {
  recipientPath: string;
  identityPath: string;
}

const DEFAULT_SETTINGS: HalfdayObsidianRuneSettings = {
  recipientPath: "~/.age/vault.recipient",
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

    // v0.3.0: custom view + .age extension routing
    // v0.3.2: view also needs the recipient path so it can re-encrypt on save
    this.registerView(
      VIEW_TYPE_AGE,
      (leaf) =>
        new AgeFileView(leaf, {
          getIdentityPath: () => this.settings.identityPath,
          getRecipientPath: () => this.settings.recipientPath,
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
      const recipient = readRecipient(this.settings.recipientPath);
      const identity = readIdentity(this.settings.identityPath);
      const decoded = await roundTrip(recipient, identity, plaintext);
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
   * v0.2: Encrypt the active note to a sibling .age file, write a sidecar,
   * and delete the plaintext. Mirrors seal.sh's safety property — if any
   * step fails, the plaintext is preserved and we clean up partial state.
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
      const sidecarPath = file.path.replace(/\.md$/, ".meta.md");

      if (this.app.vault.getAbstractFileByPath(sealedPath)) {
        new Notice(
          `Halfday Rune: refusing to overwrite existing ${sealedPath}`
        );
        return;
      }
      if (this.app.vault.getAbstractFileByPath(sidecarPath)) {
        new Notice(
          `Halfday Rune: refusing — sidecar already exists at ${sidecarPath}`
        );
        return;
      }

      const recipient = readRecipient(this.settings.recipientPath);
      const identity = readIdentity(this.settings.identityPath);

      // ---- encrypt ----
      const plaintext = await this.app.vault.read(file);
      const ciphertext = await encrypt(recipient, plaintext);

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

      // ---- compute absolute path for sidecar (desktop-only) ----
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) {
        new Notice(
          "Halfday Rune: desktop-only for v0.2 (no mobile support yet)"
        );
        return;
      }
      const vaultRoot = adapter.getBasePath();
      const absolutePath = path.join(vaultRoot, file.path);

      const sealedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const sidecar = generateSidecar({
        originalContent: plaintext,
        originalBasename: file.name,
        absolutePath,
        sealedAt,
      });

      // ---- write .age ----
      // Uint8Array → ArrayBuffer slice that Obsidian accepts
      const buffer = ciphertext.buffer.slice(
        ciphertext.byteOffset,
        ciphertext.byteOffset + ciphertext.byteLength
      ) as ArrayBuffer;
      await this.app.vault.createBinary(sealedPath, buffer);

      // ---- write sidecar; if this fails, clean up the .age ----
      try {
        await this.app.vault.create(sidecarPath, sidecar);
      } catch (err) {
        // best-effort cleanup so we don't leave an .age without a sidecar
        const orphan = this.app.vault.getAbstractFileByPath(sealedPath);
        if (orphan instanceof TFile) {
          try {
            await this.app.vault.delete(orphan);
          } catch (cleanupErr) {
            console.error(
              "[halfday-rune] failed to clean up orphan .age after sidecar write failed",
              cleanupErr
            );
          }
        }
        throw err;
      }

      // ---- delete original plaintext ----
      await this.app.vault.delete(file);

      const dt = Date.now() - started;
      new Notice(
        `Halfday Rune: sealed ${file.name} → ${file.name}.age (${dt}ms)`
      );
      console.log("[halfday-rune] sealed", {
        file: file.path,
        sealedPath,
        sidecarPath,
        dt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Halfday Rune: encrypt failed — ${msg}`);
      console.error("[halfday-rune] encrypt failed", err);
    }
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
        "Encrypts and decrypts notes using a dedicated X25519 age identity. " +
        "Configure paths to your recipient (public) and identity (private) files below. " +
        "Generate a keypair with `age-keygen -o ~/.age/vault.identity` and extract the " +
        "public key into `~/.age/vault.recipient`.",
    });

    new Setting(containerEl)
      .setName("Recipient path")
      .setDesc(
        'File containing your age recipient (a line starting with "age1..."). Tilde expands to your home directory.'
      )
      .addText((text) =>
        text
          .setPlaceholder("~/.age/vault.recipient")
          .setValue(this.plugin.settings.recipientPath)
          .onChange(async (value) => {
            this.plugin.settings.recipientPath = value.trim();
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
