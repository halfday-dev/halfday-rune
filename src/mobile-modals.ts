/**
 * Modals for the mobile unlock copy. Passphrase inputs are type=password and
 * their values are cleared as soon as they have been handed on.
 */

import { App, Modal } from "obsidian";
import { validatePassphrasePair } from "./mobile-copy";
import type { UnlockPrompt } from "./keysource";
import { InvalidWrappedIdentityError, WrongPassphraseError } from "./crypto";

/**
 * Desktop: ask for a new passphrase twice. `onSubmit` does the work and
 * returns null on success or a fixed error message; the modal closes on
 * success and stays open (inputs cleared) on failure.
 */
export class CreateMobileCopyModal extends Modal {
  private busy = false;

  constructor(
    app: App,
    private readonly opts: { path: string; exists: boolean },
    private readonly onSubmit: (passphrase: string) => Promise<string | null>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Create mobile unlock copy" });
    contentEl.createEl("p", {
      text:
        "Makes a passphrase-protected copy of your key at " +
        `${this.opts.path}, so your phone can unlock rune. ` +
        "Use a long random passphrase from a password manager. " +
        "Anyone who gets the file can guess the passphrase offline.",
    });

    const mk = (label: string): HTMLInputElement => {
      contentEl.createEl("label", { text: label });
      const input = contentEl.createEl("input", { type: "password" });
      input.setAttribute("autocomplete", "new-password");
      input.setAttribute("autocapitalize", "off");
      input.setAttribute("spellcheck", "false");
      input.addClass("halfday-rune-prompt-input");
      return input;
    };
    const first = mk("Passphrase (20 characters or more)");
    const second = mk("Repeat passphrase");
    const status = contentEl.createDiv({ cls: "halfday-rune-error" });

    let confirmed = !this.opts.exists;
    if (this.opts.exists) {
      status.setText(
        "A mobile unlock file already exists. Creating a new one replaces it; " +
          "the old passphrase will stop working on new copies."
      );
    }

    const buttons = contentEl.createDiv({ cls: "halfday-rune-button-row" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const go = buttons.createEl("button", {
      text: this.opts.exists ? "Replace" : "Create",
      cls: "mod-cta",
    });

    const clear = (): void => {
      first.value = "";
      second.value = "";
    };

    const submit = async (): Promise<void> => {
      if (this.busy) return;
      const v = validatePassphrasePair(first.value, second.value);
      if (v.ok === false) {
        status.setText(v.error);
        return;
      }
      if (!confirmed) {
        confirmed = true;
        status.setText("Press again to replace the existing unlock file.");
        go.setText("Confirm replace");
        return;
      }
      this.busy = true;
      go.disabled = true;
      status.setText("Working…");
      // let the message paint before the scrypt work blocks the thread
      await new Promise<void>((r) => window.setTimeout(r, 30));
      const pass = first.value;
      let err: string | null;
      try {
        err = await this.onSubmit(pass);
      } catch {
        err = "Could not create the mobile unlock copy. Nothing was changed.";
      }
      clear();
      this.busy = false;
      go.disabled = false;
      if (err === null) this.close();
      else status.setText(err);
    };

    go.addEventListener("click", () => void submit());
    for (const el of [first, second]) {
      el.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
      });
    }
    window.setTimeout(() => first.focus(), 0);
  }

  onClose(): void {
    // drop the inputs (and their values) with the DOM
    this.contentEl.querySelectorAll("input").forEach((i) => {
      (i as HTMLInputElement).value = "";
    });
    this.contentEl.empty();
  }
}

/** Fixed user-facing text for an unlock failure; never includes any detail. */
function unlockErrorText(err: unknown): string {
  if (err instanceof WrongPassphraseError) return "Wrong passphrase";
  if (err instanceof InvalidWrappedIdentityError) {
    return "The unlock file is damaged or not an unlock file.";
  }
  if (err instanceof Error && err.name === "UnlockFileMissingError") {
    return err.message; // fixed text
  }
  return "Could not unlock.";
}

/**
 * Unlock modal: one password input (autocomplete=current-password so the
 * system password manager can fill it). Wrong passphrase: fixed message,
 * field cleared, modal stays open.
 */
class UnlockModal extends Modal {
  private done = false;

  constructor(
    app: App,
    private readonly attempt: (pw: string) => Promise<void>,
    private readonly finish: (ok: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Unlock rune" });
    const input = contentEl.createEl("input", { type: "password" });
    input.setAttribute("autocomplete", "current-password");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("placeholder", "Passphrase");
    input.addClass("halfday-rune-prompt-input");
    const status = contentEl.createDiv({ cls: "halfday-rune-error" });
    const buttons = contentEl.createDiv({ cls: "halfday-rune-button-row" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const go = buttons.createEl("button", { text: "Unlock", cls: "mod-cta" });

    let busy = false;
    const submit = async (): Promise<void> => {
      if (busy || !input.value) return;
      busy = true;
      go.disabled = true;
      go.setText("Unlocking…");
      status.setText("");
      const pw = input.value;
      // scrypt blocks the thread: let the label paint first
      await new Promise<void>((r) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => r()))
      );
      try {
        await this.attempt(pw);
        input.value = "";
        this.done = true;
        this.finish(true);
        this.close();
        return;
      } catch (err) {
        input.value = "";
        status.setText(unlockErrorText(err));
      }
      busy = false;
      go.disabled = false;
      go.setText("Unlock");
      input.focus();
    };
    go.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.querySelectorAll("input").forEach((i) => {
      (i as HTMLInputElement).value = "";
    });
    this.contentEl.empty();
    if (!this.done) this.finish(false);
  }
}

export function makeUnlockPrompt(app: App): UnlockPrompt {
  return (attempt) =>
    new Promise<boolean>((resolve) => {
      new UnlockModal(app, attempt, resolve).open();
    });
}
