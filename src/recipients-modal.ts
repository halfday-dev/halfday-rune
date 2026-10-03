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
