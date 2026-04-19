/**
 * Halfday Obsidian Rune — v0.1
 *
 * v0.1 scope: prove the crypto works inside Obsidian's Electron runtime.
 * Adds a single command ("Halfday Rune: test round-trip") that reads a
 * configured age X25519 recipient + identity, encrypts a test string,
 * decrypts it, and shows a Notice on success or failure.
 *
 * No files touched on disk. No editor changes. This milestone exists
 * solely to retire the "does typage work in Obsidian?" risk.
 *
 * See knowledge/projects/vault_plugin_v0_plan.md for the full milestone map.
 */

import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { readIdentity, readRecipient, roundTrip } from "./crypto";

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

    this.addSettingTab(new HalfdayRuneSettingTab(this.app, this));

    console.log("[halfday-rune] loaded");
  }

  onunload(): void {
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
   * Load configured recipient + identity, round-trip a unique test string,
   * and report success/failure via Notice.
   *
   * Surface everything in a Notice so the result is visible even if devtools
   * aren't open. Detailed info still goes to console.
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
