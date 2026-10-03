import { describe, it, expect, vi } from "vitest";
import { generateIdentity, identityToRecipient } from "age-encryption";
import {
  addedToMainFile,
  confirmRecipientsSave,
  isMainRecipientsFile,
} from "../src/recipients-guard";

const HOME = "/Users/throwaway";
const expand = (p: string) =>
  p === "~" ? HOME : p.startsWith("~/") ? HOME + "/" + p.slice(2) : p;

const rec = async () => identityToRecipient(await generateIdentity());

describe("isMainRecipientsFile", () => {
  it("matches the default however it is spelled", () => {
    for (const p of [
      "~/.age/recipients.txt",
      HOME + "/.age/recipients.txt",
      HOME + "/.age/../.age/recipients.txt",
      HOME + "//.age/./recipients.txt",
      HOME + "/.AGE/Recipients.txt",
      " ~/.age/recipients.txt ",
    ]) {
      expect(isMainRecipientsFile(p, expand), p).toBe(true);
    }
  });
  it("does not match other files", () => {
    for (const p of ["~/.age/other.txt", "/tmp/test/recipients.txt", "~/.age/sub/recipients.txt", "recipients.txt"]) {
      expect(isMainRecipientsFile(p, expand), p).toBe(false);
    }
  });
});

describe("main recipients file guard", () => {
  it("prompts only when a key is added, naming the added key", async () => {
    const a = await rec();
    const b = await rec();
    const confirm = vi.fn(async () => true);
    const base = { configuredPath: "~/.age/recipients.txt", expand };

    // add
    const added = await confirmRecipientsSave(
      { ...base, prevContent: `${a}\n`, newContent: `${a}\n${b}\n` },
      confirm
    );
    expect(added).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("~/.age/recipients.txt", [b]);

    // no-op (comments and ordering do not count)
    confirm.mockClear();
    expect(await confirmRecipientsSave({ ...base, prevContent: `${a}\n${b}\n`, newContent: `# hi\n${b}\n${a}\n` }, confirm)).toBe(true);
    // removal
    expect(await confirmRecipientsSave({ ...base, prevContent: `${a}\n${b}\n`, newContent: `${a}\n` }, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a declined confirmation blocks the save", async () => {
    const a = await rec();
    const ok = await confirmRecipientsSave(
      { configuredPath: "~/.age/recipients.txt", expand, prevContent: "", newContent: `${a}\n` },
      async () => false
    );
    expect(ok).toBe(false);
  });

  it("a missing or unreadable previous file reads as everything added", async () => {
    const a = await rec();
    expect(addedToMainFile({ configuredPath: "~/.age/recipients.txt", expand, prevContent: null, newContent: `${a}\n` })).toEqual([a]);
    expect(addedToMainFile({ configuredPath: "~/.age/recipients.txt", expand, prevContent: "garbage!!", newContent: `${a}\n` })).toEqual([a]);
  });

  it("never prompts for a path other than the main file", async () => {
    const a = await rec();
    const confirm = vi.fn(async () => false);
    expect(await confirmRecipientsSave({ configuredPath: "/tmp/test/recipients.txt", expand, prevContent: "", newContent: `${a}\n` }, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
