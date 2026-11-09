import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => ({ App: class {}, Modal: class {} }));

import { unlockErrorText } from "../src/mobile-modals";
import {
  InvalidWrappedIdentityError,
  LegacyWrappedIdentityError,
  LEGACY_WRAPPED_MESSAGE,
} from "../src/crypto";
import { RecipientPinError, pinChangedMessage } from "../src/recipient-pin";

describe("unlockErrorText", () => {
  it("shows the re-create message for a legacy file, not the generic damaged text", () => {
    expect(unlockErrorText(new LegacyWrappedIdentityError())).toBe(LEGACY_WRAPPED_MESSAGE);
    expect(unlockErrorText(new InvalidWrappedIdentityError())).toMatch(/damaged/);
  });

  it("shows a recipient pin refusal's fixed text, so the owner learns why unlock stopped", () => {
    expect(unlockErrorText(new RecipientPinError(pinChangedMessage(1, 0)))).toBe(
      pinChangedMessage(1, 0)
    );
  });
});
