import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => ({ App: class {}, Modal: class {} }));

import { unlockErrorText } from "../src/mobile-modals";
import {
  InvalidWrappedIdentityError,
  LegacyWrappedIdentityError,
  LEGACY_WRAPPED_MESSAGE,
} from "../src/crypto";

describe("unlockErrorText", () => {
  it("shows the re-create message for a legacy file, not the generic damaged text", () => {
    expect(unlockErrorText(new LegacyWrappedIdentityError())).toBe(LEGACY_WRAPPED_MESSAGE);
    expect(unlockErrorText(new InvalidWrappedIdentityError())).toMatch(/damaged/);
  });
});
