import { describe, it, expect, vi } from "vitest";
import { FileKeySource } from "../src/keysource";

function fakeNode() {
  return {
    readIdentity: vi.fn((p: string) => `AGE-SECRET-KEY-1FROM-${p}`),
    readRecipients: vi.fn((p: string) => [`age1from-${p}`]),
  };
}
const asLoader = (node: ReturnType<typeof fakeNode>) =>
  vi.fn(async () => node) as unknown as typeof import("../src/node-loader").loadCryptoNode;

describe("FileKeySource", () => {
  it("getIdentity reads identityPath through crypto-node", async () => {
    const node = fakeNode();
    const ks = new FileKeySource(
      () => ({ identityPath: "~/.age/id", recipientsPath: "~/.age/r" }),
      asLoader(node)
    );
    expect(await ks.getIdentity()).toBe("AGE-SECRET-KEY-1FROM-~/.age/id");
    expect(node.readIdentity).toHaveBeenCalledWith("~/.age/id");
    expect(node.readRecipients).not.toHaveBeenCalled();
  });

  it("getRecipients reads recipientsPath through crypto-node", async () => {
    const node = fakeNode();
    const ks = new FileKeySource(
      () => ({ identityPath: "~/.age/id", recipientsPath: "~/.age/r" }),
      asLoader(node)
    );
    expect(await ks.getRecipients()).toEqual(["age1from-~/.age/r"]);
    expect(node.readRecipients).toHaveBeenCalledWith("~/.age/r");
    expect(node.readIdentity).not.toHaveBeenCalled();
  });

  it("picks up a changed path on the next read and caches nothing", async () => {
    const node = fakeNode();
    const paths = { identityPath: "/a", recipientsPath: "/r" };
    const ks = new FileKeySource(() => paths, asLoader(node));
    await ks.getIdentity();
    paths.identityPath = "/b";
    expect(await ks.getIdentity()).toBe("AGE-SECRET-KEY-1FROM-/b");
    expect(node.readIdentity).toHaveBeenCalledTimes(2);
  });

  it("surfaces the underlying read errors unchanged", async () => {
    const node = fakeNode();
    node.readIdentity.mockImplementation(() => {
      throw new Error("no AGE-SECRET-KEY-1... identity found in /x");
    });
    node.readRecipients.mockImplementation(() => {
      throw new Error("recipients.txt not readable at /y: ENOENT");
    });
    const ks = new FileKeySource(
      () => ({ identityPath: "/x", recipientsPath: "/y" }),
      asLoader(node)
    );
    await expect(ks.getIdentity()).rejects.toThrow(/no AGE-SECRET-KEY-1/);
    await expect(ks.getRecipients()).rejects.toThrow(/recipients\.txt not readable/);
  });

  it("is always unlocked and lock() is a no-op", async () => {
    const node = fakeNode();
    const ks = new FileKeySource(
      () => ({ identityPath: "/a", recipientsPath: "/r" }),
      asLoader(node)
    );
    expect(ks.isUnlocked()).toBe(true);
    ks.lock();
    expect(ks.isUnlocked()).toBe(true);
    expect(await ks.getIdentity()).toBe("AGE-SECRET-KEY-1FROM-/a");
  });
});
