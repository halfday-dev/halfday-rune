import { App, Modal } from "obsidian";
import { mainFileConfirmText } from "./recipients-guard";

/** Asks the owner to confirm adding keys to the main recipients file. */
export class ConfirmMainRecipientsModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly path: string,
    private readonly added: string[],
    private readonly done: (ok: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Add to your main recipients file?" });
    const [first, ...rest] = mainFileConfirmText(this.path, this.added).split("\n");
    contentEl.createEl("p", { text: first });
    const list = contentEl.createEl("pre");
    list.setText(rest.join("\n"));
    const buttons = contentEl.createDiv({ cls: "halfday-rune-button-row" });
    const cancel = buttons.createEl("button", { text: "Cancel", cls: "mod-cta" });
    cancel.addEventListener("click", () => this.close());
    const go = buttons.createEl("button", { text: "Add key and save" });
    go.addEventListener("click", () => {
      this.settle(true);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.settle(false);
  }

  private settle(ok: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.done(ok);
  }
}

/** What the confirm-set modal shows. */
export interface RecipientSetPrompt {
  /** The full set to confirm (sorted, own recipient included). */
  recipients: string[];
  fingerprint: string;
  /** Change since the last VERIFIED confirmed set; null when there is none. */
  diff: { added: string[]; removed: string[] } | null;
  /** Extra line above the list (why we are asking). */
  note?: string;
}

/**
 * Asks the owner to confirm the exact set of keys rune may encrypt to. Shows
 * the count, fingerprint and every key; keys new since the last confirmed
 * set are listed separately so they cannot hide in a long list. Cancel is
 * the default.
 */
export class ConfirmRecipientSetModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly p: RecipientSetPrompt,
    private readonly done: (ok: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Confirm the keys rune encrypts to" });
    if (this.p.note) contentEl.createEl("p", { text: this.p.note });
    contentEl.createEl("p", {
      text:
        `rune will encrypt every note to ${this.p.recipients.length === 1 ? "this key" : `these ${this.p.recipients.length} keys`} ` +
        `(fingerprint ${this.p.fingerprint}) and refuse any other set until you confirm again. ` +
        "If you do not recognise every key, cancel.",
    });
    if (this.p.diff && this.p.diff.added.length > 0) {
      contentEl.createEl("p", { text: "New since you last confirmed:" });
      contentEl.createEl("pre").setText(this.p.diff.added.join("\n"));
    }
    if (this.p.diff && this.p.diff.removed.length > 0) {
      contentEl.createEl("p", { text: "Removed since you last confirmed:" });
      contentEl.createEl("pre").setText(this.p.diff.removed.join("\n"));
    }
    contentEl.createEl("p", { text: "The full set:" });
    contentEl.createEl("pre").setText(this.p.recipients.join("\n"));
    const buttons = contentEl.createDiv({ cls: "halfday-rune-button-row" });
    const cancel = buttons.createEl("button", { text: "Cancel", cls: "mod-cta" });
    cancel.addEventListener("click", () => this.close());
    const go = buttons.createEl("button", { text: "These are my keys" });
    go.addEventListener("click", () => {
      this.settle(true);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.settle(false);
  }

  private settle(ok: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.done(ok);
  }
}
