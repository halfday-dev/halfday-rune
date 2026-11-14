/**
 * Journal API (gabbro #107 Part B): every refusal, the round trip, and that
 * no plaintext or key material leaks. Test keys only (generated per test).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { generateIdentity, identityToRecipient } from "age-encryption";

/** Set to make the API's crypto calls throw a given error (F3 leak tests). */
const cryptoFail = vi.hoisted(() => ({
  decrypt: null as Error | null,
  encrypt: null as Error | null,
  /** Count decryptToString calls; the one at `failDecryptAt` (1-based) throws. */
  decryptCalls: 0,
  failDecryptAt: null as number | null,
  /** Runs when that call fails (e.g. another writer lands right then). */
  onDecryptFail: null as null | (() => void),
}));
vi.mock("../src/crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/crypto")>();
  return {
    ...real,
    decryptToString: async (...a: Parameters<typeof real.decryptToString>) => {
      if (cryptoFail.decrypt) throw cryptoFail.decrypt;
      if (++cryptoFail.decryptCalls === cryptoFail.failDecryptAt) {
        cryptoFail.onDecryptFail?.();
        throw new Error("read-back did not decrypt");
      }
      return real.decryptToString(...a);
    },
    encrypt: async (...a: Parameters<typeof real.encrypt>) => {
      if (cryptoFail.encrypt) throw cryptoFail.encrypt;
      return real.encrypt(...a);
    },
  };
});

import { encrypt, decryptToString, wrapMobileKey } from "../src/crypto";
import { KeyLockedError, PassphraseKeySource } from "../src/keysource";
import type { KeySource } from "../src/keysource";
import { RecipientPinError, makePin } from "../src/recipient-pin";
import type { DeviceRecord, PinStore, RecipientPin } from "../src/recipient-pin";
import {
  JournalApiError,
  JournalApiHost,
  checkJournalPath,
  validateJournalFolder,
} from "../src/journal-api";
import type { JournalApiErrorCode, JournalVault } from "../src/journal-api";
import { vaultPathHasSymlink } from "../src/crypto-node";

const FOLDER = "10_journal";
const DAY = `${FOLDER}/2026-11/13_day.md.age`;
const TEXT = "## today\nsecret journal words ✓\n";

async function setup(
  opts: {
    folder?: string;
    unlocked?: boolean;
    fixedRecipientList?: boolean;
    /** recipients besides the own key */
    others?: string[];
    symlinked?: string[];
    symlinkCheck?: "fake" | "throws" | "none";
    existing?: Record<string, string>;
    /** Use this identity (e.g. the one inside a real PassphraseKeySource). */
    identity?: string;
    /** Use this key source instead of the fake. */
    keySource?: KeySource;
  } = {}
) {
  const identity = opts.identity ?? (await generateIdentity());
  const own = await identityToRecipient(identity);
  const recipients = [own, ...(opts.others ?? [])];
  const state = { unlocked: opts.unlocked ?? true, folder: opts.folder ?? FOLDER };
  const files = new Map<string, Uint8Array>();
  const folders = new Set<string>([FOLDER, `${FOLDER}/2026-11`, "other", "_rune"]);
  for (const [p, t] of Object.entries(opts.existing ?? {})) {
    files.set(p, await encrypt(recipients, t));
  }
  const keys: KeySource & {
    getIdentity: ReturnType<typeof vi.fn>;
    getRecipients: ReturnType<typeof vi.fn>;
    peekIdentity: ReturnType<typeof vi.fn>;
    peekRecipients: ReturnType<typeof vi.fn>;
  } = {
    fixedRecipientList: opts.fixedRecipientList ?? false,
    isUnlocked: () => state.unlocked,
    lock() {},
    // the prompting, idle-resetting getters: the API must never use them
    getIdentity: vi.fn(async () => {
      throw new Error("getIdentity must not be called by the journal API");
    }),
    getRecipients: vi.fn(async () => {
      throw new Error("getRecipients must not be called by the journal API");
    }),
    peekIdentity: vi.fn(async () => {
      if (!state.unlocked) throw new KeyLockedError();
      return identity;
    }),
    peekRecipients: vi.fn(async () => {
      if (!state.unlocked) throw new KeyLockedError();
      return [...recipients];
    }),
  };
  const hooks = {
    /** Mutates bytes on their way to disk (simulates a bad write). */
    corruptWrite: false,
    failWrite: false,
    /** Every write after the first fails (the restore / cleanup). */
    failAfterFirstWrite: false,
    /** Every write after the first (the restore) lands damaged without an error. */
    corruptAfterFirstWrite: false,
    failRemove: false,
    /** remove() resolves but the file stays. */
    removeNoop: false,
    /** Runs right after a write lands (another writer arriving then). */
    afterWrite: null as null | ((p: string) => void),
    openDirty: new Set<string>(),
    /** When set, create waits for it before writing. */
    createGate: null as Promise<void> | null,
  };
  let writes = 0;
  const vault = {
    kind: vi.fn(async (p: string) =>
      files.has(p) ? ("file" as const) : folders.has(p) ? ("folder" as const) : ("none" as const)
    ),
    read: vi.fn(async (p: string) => {
      const b = files.get(p);
      if (!b) throw new Error("ENOENT");
      return b.slice().buffer as ArrayBuffer;
    }),
    create: vi.fn(async (p: string, data: ArrayBuffer) => {
      if (hooks.failWrite) throw new Error("disk full");
      // let a concurrent caller run between the check and the write
      await new Promise((r) => setTimeout(r, 5));
      if (hooks.createGate) await hooks.createGate;
      if (files.has(p)) throw new Error("File already exists.");
      files.set(p, write(data));
      hooks.afterWrite?.(p);
    }),
    replace: vi.fn(async (p: string, data: ArrayBuffer) => {
      if (hooks.failWrite) throw new Error("disk full");
      if (!files.has(p)) throw new Error("not a file");
      files.set(p, write(data));
      hooks.afterWrite?.(p);
    }),
    remove: vi.fn(async (p: string) => {
      if (hooks.failRemove) throw new Error("EPERM");
      if (!hooks.removeNoop) files.delete(p);
    }),
  } satisfies JournalVault;
  const write = (data: ArrayBuffer): Uint8Array => {
    const n = writes++;
    if (hooks.failAfterFirstWrite && n > 0) throw new Error("disk full");
    const b = new Uint8Array(data.slice(0));
    if (hooks.corruptWrite || (hooks.corruptAfterFirstWrite && n > 0)) {
      b[b.length - 1] ^= 0xff;
      hooks.corruptWrite = false; // only the new write; the restore goes through
    }
    return b;
  };
  const symlinked = new Set(opts.symlinked ?? []);
  const symlinkCheck = vi.fn(async (p: string) => {
    if (opts.symlinkCheck === "throws") throw new Error("EACCES");
    return [...symlinked].some((s) => p === s || p.startsWith(`${s}/`));
  });
  const host = new JournalApiHost({
    getKeySource: () => opts.keySource ?? keys,
    getFolder: () => state.folder,
    excludedPaths: () => ["_rune/identity.age", `${FOLDER}/identity.age`],
    vault,
    pathHasSymlink: opts.symlinkCheck === "none" ? null : symlinkCheck,
    isOpenDirty: (p) => hooks.openDirty.has(p),
  });
  const api = host.api();
  const lockNow = () => {
    state.unlocked = false;
    host.notifyLockChange(false);
  };
  return { api, host, keys, vault, files, state, identity, recipients, hooks, symlinkCheck, lockNow };
}

async function code(p: Promise<unknown>): Promise<JournalApiErrorCode | "resolved"> {
  try {
    await p;
    return "resolved";
  } catch (err) {
    expect(err).toBeInstanceOf(JournalApiError);
    return (err as JournalApiError).code;
  }
}

const snapshot = (files: Map<string, Uint8Array>) =>
  JSON.stringify([...files].map(([k, v]) => [k, Buffer.from(v).toString("base64")]));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cryptoFail.decrypt = null;
  cryptoFail.encrypt = null;
  cryptoFail.decryptCalls = 0;
  cryptoFail.failDecryptAt = null;
  cryptoFail.onDecryptFail = null;
});

const PW = "a long random passphrase for tests 4821";

/** A real passphrase source, unlocked, with a prompt spy. Test key only. */
async function realSource(opts: { autoLockMinutes?: number; now?: () => number } = {}) {
  const identity = await generateIdentity();
  const wrapped = await wrapMobileKey(identity, [], PW, 16);
  const prompt = vi.fn(async (attempt: (pw: string) => Promise<void>) => (await attempt(PW), true));
  const hostRef: { host: JournalApiHost | null } = { host: null };
  const source = new PassphraseKeySource({
    adapter: { exists: async () => true, readBinary: async () => wrapped.slice().buffer as ArrayBuffer },
    getSettings: () => ({
      mobileKeyPath: "_rune/identity.age",
      autoLockMinutes: opts.autoLockMinutes ?? 15,
      backgroundLockGraceSeconds: 60,
    }),
    prompt,
    onStateChange: (u) => hostRef.host?.notifyLockChange(u),
    now: opts.now,
  });
  await source.getIdentity(); // the owner unlocks once
  expect(prompt).toHaveBeenCalledTimes(1);
  return { identity, source, prompt, hostRef };
}

describe("round trip", () => {
  it("create then decrypt gives the same text; the file on disk is ciphertext", async () => {
    const t = await setup();
    await t.api.encrypt(DAY, TEXT, { mode: "create" });
    const bytes = t.files.get(DAY)!;
    expect(new TextDecoder().decode(bytes.subarray(0, 21))).toBe("age-encryption.org/v1");
    expect(Buffer.from(bytes).includes(Buffer.from("secret journal words"))).toBe(false);
    expect(await t.api.decrypt(DAY)).toBe(TEXT);
    expect(await decryptToString(t.identity, bytes)).toBe(TEXT);
  });

  it("replace rewrites an existing note to the same recipients", async () => {
    const other = await identityToRecipient(await generateIdentity());
    const t = await setup({ others: [other], existing: { [DAY]: "old" } });
    await t.api.encrypt(DAY, TEXT, { mode: "replace" });
    expect(await t.api.decrypt(DAY)).toBe(TEXT);
    expect(t.vault.replace).toHaveBeenCalledTimes(1);
    expect(t.vault.create).not.toHaveBeenCalled();
    // encrypted to the pinned set: two X25519 stanzas
    const head = new TextDecoder("latin1").decode(t.files.get(DAY)!.subarray(0, 2000));
    expect(head.match(/^-> X25519 /gm)?.length).toBe(2);
  });

  it("decrypt also opens rune's bare .age spelling", async () => {
    const p = `${FOLDER}/2026-11/13_day.age`;
    const t = await setup({ existing: { [p]: TEXT } });
    expect(await t.api.decrypt(p)).toBe(TEXT);
  });
});

describe("locked", () => {
  it("decrypt and encrypt refuse while locked, never asking the key source", async () => {
    const t = await setup({ unlocked: false, existing: { [DAY]: "old" } });
    const before = snapshot(t.files);
    expect(await code(t.api.decrypt(DAY))).toBe("locked");
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("locked");
    expect(await code(t.api.encrypt(`${FOLDER}/new.md.age`, TEXT, { mode: "create" }))).toBe("locked");
    // getIdentity on a passphrase source would open the unlock prompt
    expect(t.keys.peekIdentity).not.toHaveBeenCalled();
    expect(t.keys.peekRecipients).not.toHaveBeenCalled();
    expect(t.vault.read).not.toHaveBeenCalled();
    expect(snapshot(t.files)).toBe(before);
  });

  it("a lock while decrypting discards the plaintext", async () => {
    const t = await setup({ existing: { [DAY]: TEXT } });
    t.keys.peekIdentity.mockImplementationOnce(async () => {
      t.lockNow(); // auto-lock fires mid-call
      return t.identity;
    });
    expect(await code(t.api.decrypt(DAY))).toBe("locked");
  });

  it("a lock while encrypting writes nothing", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    const before = snapshot(t.files);
    t.keys.peekIdentity.mockImplementationOnce(async () => {
      t.lockNow();
      return t.identity;
    });
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("locked");
    expect(t.vault.replace).not.toHaveBeenCalled();
    expect(snapshot(t.files)).toBe(before);
  });

  it("a lock before the key is needed never asks the key source", async () => {
    const t = await setup({ existing: { [DAY]: TEXT } });
    const read = t.vault.read.getMockImplementation()!;
    t.vault.read.mockImplementationOnce(async (p: string) => {
      t.lockNow(); // locks between the start of the call and the decrypt
      return read(p);
    });
    expect(await code(t.api.decrypt(DAY))).toBe("locked");
    expect(t.keys.peekIdentity).not.toHaveBeenCalled();
  });

  it("isUnlocked follows the key source", async () => {
    const t = await setup();
    expect(t.api.isUnlocked()).toBe(true);
    t.lockNow();
    expect(t.api.isUnlocked()).toBe(false);
  });
});

describe("folder setting", () => {
  it("empty folder: everything refuses", async () => {
    const t = await setup({ folder: "", existing: { [DAY]: TEXT } });
    expect(await code(t.api.decrypt(DAY))).toBe("disabled");
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("disabled");
    expect(t.vault.read).not.toHaveBeenCalled();
  });

  it("an invalid stored folder (data.json edited) refuses as off", async () => {
    for (const bad of ["../10_journal", "/", "/10_journal", ".obsidian", "a//b", 42 as unknown as string]) {
      const t = await setup({ folder: bad, existing: { [DAY]: TEXT } });
      expect(await code(t.api.decrypt(DAY))).toBe("disabled");
    }
  });

  it("validateJournalFolder normalises and refuses", () => {
    expect(validateJournalFolder("")).toEqual({ ok: true, folder: "" });
    expect(validateJournalFolder("  10_journal/ ")).toEqual({ ok: true, folder: "10_journal" });
    expect(validateJournalFolder("a/b")).toEqual({ ok: true, folder: "a/b" });
    expect(validateJournalFolder("Cafe\u0301").ok && validateJournalFolder("Cafe\u0301")).toEqual({
      ok: true,
      folder: "Caf\u00e9",
    });
    for (const bad of ["/", "/a", "~/a", "C:/a", "a/../b", "..", "./a", "a//b", "a\\b", ".obsidian", ".Obsidian/x", "a\u0000"]) {
      expect(validateJournalFolder(bad).ok, bad).toBe(false);
    }
  });

  it("a folder change applies to the next call", async () => {
    const t = await setup({ existing: { [DAY]: TEXT } });
    expect(await t.api.decrypt(DAY)).toBe(TEXT);
    t.state.folder = "other";
    expect(await code(t.api.decrypt(DAY))).toBe("outside-folder");
  });
});

describe("paths", () => {
  it("outside the folder, including look-alikes, refuses", async () => {
    const t = await setup({
      existing: {
        "other/x.md.age": TEXT,
        "10_journal2/x.md.age": TEXT,
        "10_JOURNAL/x.md.age": TEXT,
        "10_journal.md.age": TEXT,
      },
    });
    for (const p of ["other/x.md.age", "10_journal2/x.md.age", "10_JOURNAL/x.md.age", "10_journal.md.age", "x.md.age"]) {
      expect(await code(t.api.decrypt(p)), p).toBe("outside-folder");
      expect(await code(t.api.encrypt(p, TEXT, { mode: "replace" })), p).toBe("outside-folder");
    }
    expect(t.vault.read).not.toHaveBeenCalled();
  });

  it("checkJournalPath refuses everything when the folder is empty", () => {
    expect(() => checkJournalPath(DAY, "", [".md.age"], [])).toThrow(/off/);
  });

  it("the folder itself is not a file inside it", () => {
    expect(() => checkJournalPath(FOLDER, FOLDER, [".md.age"], [])).toThrow(JournalApiError);
  });

  it("dot-dot, dot, empty segments, absolute, backslash, non-NFC and non-strings refuse", async () => {
    const t = await setup({ existing: { "other/x.md.age": TEXT } });
    const bad = [
      `${FOLDER}/../other/x.md.age`,
      `${FOLDER}/./2026-11/13_day.md.age`,
      `${FOLDER}//13_day.md.age`,
      `/${FOLDER}/13_day.md.age`,
      `${FOLDER}\\..\\other\\x.md.age`,
      `${FOLDER}/Cafe\u0301.md.age`,
      `~/${FOLDER}/x.md.age`,
      `${FOLDER}/x\u0000.md.age`,
      "",
      42,
      null,
    ];
    for (const p of bad) {
      expect(await code(t.api.decrypt(p as string)), String(p)).toBe("bad-path");
      expect(await code(t.api.encrypt(p as string, TEXT, { mode: "create" })), String(p)).toBe("bad-path");
    }
    expect(t.vault.read).not.toHaveBeenCalled();
    expect(t.vault.create).not.toHaveBeenCalled();
  });

  it("a path through a symlink refuses and is never read or written", async () => {
    const t = await setup({ symlinked: [`${FOLDER}/2026-11`], existing: { [DAY]: TEXT } });
    expect(await code(t.api.decrypt(DAY))).toBe("symlink");
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("symlink");
    expect(t.symlinkCheck).toHaveBeenCalledWith(DAY);
    expect(t.vault.read).not.toHaveBeenCalled();
    expect(t.vault.replace).not.toHaveBeenCalled();
  });

  it("a symlink check that errors fails closed", async () => {
    const t = await setup({ symlinkCheck: "throws", existing: { [DAY]: TEXT } });
    expect(await code(t.api.decrypt(DAY))).toBe("symlink");
    expect(t.vault.read).not.toHaveBeenCalled();
  });

  it("unsupported file types refuse; encrypt writes only .md.age", async () => {
    const t = await setup({ existing: { [`${FOLDER}/x.age`]: TEXT } });
    for (const p of [`${FOLDER}/x.md`, `${FOLDER}/x.txt`, `${FOLDER}/.md.age`, `${FOLDER}/x.age.md`]) {
      expect(await code(t.api.decrypt(p)), p).toBe("unsupported-type");
    }
    expect(await code(t.api.encrypt(`${FOLDER}/x.age`, TEXT, { mode: "replace" }))).toBe("unsupported-type");
    expect(await code(t.api.encrypt(`${FOLDER}/x.md`, TEXT, { mode: "create" }))).toBe("unsupported-type");
    expect(t.vault.read).not.toHaveBeenCalled();
  });

  it("the wrapped identity file is never handled, even inside the folder", async () => {
    const t = await setup({ existing: { [`${FOLDER}/identity.age`]: TEXT } });
    expect(await code(t.api.decrypt(`${FOLDER}/identity.age`))).toBe("unsupported-type");
    expect(await code(t.api.decrypt(`${FOLDER}/IDENTITY.age`))).toBe("unsupported-type");
    expect(t.vault.read).not.toHaveBeenCalled();
  });
});

describe("encrypt modes and refusals", () => {
  it("create refuses an existing path and leaves it byte-identical", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    const before = snapshot(t.files);
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "create" }))).toBe("exists");
    expect(snapshot(t.files)).toBe(before);
    expect(t.vault.create).not.toHaveBeenCalled();
  });

  it("create refuses a path that is on disk but not indexed", async () => {
    const t = await setup();
    t.vault.kind.mockImplementation(async (p: string) => (p === DAY ? "other" : "folder"));
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "create" }))).toBe("exists");
    expect(t.vault.create).not.toHaveBeenCalled();
  });

  it("replace refuses a missing path and creates nothing", async () => {
    const t = await setup();
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("missing");
    expect(t.files.size).toBe(0);
    expect(t.vault.replace).not.toHaveBeenCalled();
    expect(t.vault.read).not.toHaveBeenCalled();
    expect(t.keys.peekRecipients).not.toHaveBeenCalled();
  });

  it("an in-memory round trip failure writes nothing", async () => {
    const stranger = await identityToRecipient(await generateIdentity());
    const t = await setup();
    t.keys.peekRecipients.mockResolvedValueOnce([stranger]); // our key could not read it back
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "create" }))).toBe("encrypt-failed");
    expect(t.vault.create).not.toHaveBeenCalled();
    expect(t.files.size).toBe(0);
  });

  it("an unexpected key source error is not passed on", async () => {
    const t = await setup();
    t.keys.peekRecipients.mockRejectedValueOnce(new Error("AGE-SECRET-KEY-1LEAKED"));
    let msg = "";
    try {
      await t.api.encrypt(DAY, TEXT, { mode: "create" });
    } catch (e) {
      msg = (e as Error).message;
      expect((e as JournalApiError).code).toBe("refused");
    }
    expect(msg).not.toContain("AGE-SECRET-KEY");
  });

  it("create refuses when the parent folder is missing", async () => {
    const t = await setup();
    expect(await code(t.api.encrypt(`${FOLDER}/nope/x.md.age`, TEXT, { mode: "create" }))).toBe("missing");
    expect(t.vault.create).not.toHaveBeenCalled();
  });

  it("decrypt of a missing file refuses", async () => {
    const t = await setup();
    expect(await code(t.api.decrypt(DAY))).toBe("missing");
  });

  it("bad text or mode refuses", async () => {
    const t = await setup();
    expect(await code(t.api.encrypt(DAY, 5 as unknown as string, { mode: "create" }))).toBe("bad-input");
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "upsert" as "create" }))).toBe("bad-input");
    expect(await code(t.api.encrypt(DAY, TEXT, undefined as unknown as { mode: "create" }))).toBe("bad-input");
    expect(t.files.size).toBe(0);
  });

  it("a recipient-pin refusal writes nothing and keeps rune's message", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    const before = snapshot(t.files);
    t.keys.peekRecipients.mockRejectedValueOnce(new RecipientPinError("Halfday Rune: recipients differ (+1 added)"));
    let err: unknown;
    try {
      await t.api.encrypt(DAY, TEXT, { mode: "replace" });
    } catch (e) {
      err = e;
    }
    expect((err as JournalApiError).code).toBe("refused");
    expect((err as Error).message).toContain("recipients differ");
    expect(snapshot(t.files)).toBe(before);
  });

  it("fixed recipient list (unlock copy): a note with an extra recipient is refused", async () => {
    const extra = await identityToRecipient(await generateIdentity());
    const t = await setup({ fixedRecipientList: true });
    t.files.set(DAY, await encrypt([...t.recipients, extra], "old"));
    const before = snapshot(t.files);
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("refused");
    expect(snapshot(t.files)).toBe(before);
  });

  it("replace refuses a file the unlocked key cannot open", async () => {
    const stranger = await identityToRecipient(await generateIdentity());
    const t = await setup();
    t.files.set(DAY, await encrypt([stranger], "theirs"));
    const before = snapshot(t.files);
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("refused");
    expect(snapshot(t.files)).toBe(before);
  });

  it("our bytes on disk that don't decrypt back: replace puts the old file back", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    const before = snapshot(t.files);
    cryptoFail.failDecryptAt = 2; // 1 = in-memory round trip, 2 = read-back
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("verify-failed");
    expect(snapshot(t.files)).toBe(before);
    expect(await t.api.decrypt(DAY)).toBe("old");
  });

  it("a damaged write is not provably ours: conflict, nothing undone", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    t.hooks.corruptWrite = true;
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("conflict");
    expect(t.vault.replace).toHaveBeenCalledTimes(1);
    expect(t.vault.remove).not.toHaveBeenCalled();
  });

  it("a failed write reports write-failed and leaves the old file", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    const before = snapshot(t.files);
    t.hooks.failWrite = true;
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("write-failed");
    expect(snapshot(t.files)).toBe(before);
  });

  it("two creates of one path race: one wins, the other is told it exists", async () => {
    const t = await setup();
    const p = `${FOLDER}/frag.md.age`;
    const results = await Promise.all([
      code(t.api.encrypt(p, "first", { mode: "create" })),
      code(t.api.encrypt(p, "second", { mode: "create" })),
    ]);
    expect(results).toEqual(["resolved", "exists"]);
    expect(await t.api.decrypt(p)).toBe("first");
  });

  it("decrypt of a file not for this key reports decrypt-failed", async () => {
    const stranger = await identityToRecipient(await generateIdentity());
    const t = await setup();
    t.files.set(DAY, await encrypt([stranger], TEXT));
    expect(await code(t.api.decrypt(DAY))).toBe("decrypt-failed");
  });
});

describe("no leaks", () => {
  it("nothing logs, and no error carries plaintext or key material", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    const t = await setup({ existing: { [DAY]: TEXT } });
    const errors: string[] = [];
    const tryIt = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        errors.push(String((e as Error).message), String((e as Error).stack));
      }
    };
    await tryIt(t.api.decrypt(DAY));
    await tryIt(t.api.encrypt(DAY, TEXT, { mode: "replace" }));
    t.hooks.corruptWrite = true;
    await tryIt(t.api.encrypt(DAY, TEXT, { mode: "replace" }));
    t.hooks.failWrite = true;
    await tryIt(t.api.encrypt(DAY, TEXT, { mode: "replace" }));
    t.hooks.failWrite = false;
    await tryIt(t.api.encrypt(`${FOLDER}/x.md`, TEXT, { mode: "create" }));
    t.lockNow();
    await tryIt(t.api.decrypt(DAY));
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(e).not.toContain("secret journal words");
      expect(e).not.toContain("AGE-SECRET-KEY");
      expect(e).not.toContain("disk full"); // underlying errors are not passed on
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("the public object exposes only the API, frozen, with no key source", async () => {
    const t = await setup();
    expect(Object.isFrozen(t.api)).toBe(true);
    expect(Object.keys(t.api).sort()).toEqual(["apiVersion", "decrypt", "encrypt", "isUnlocked", "onLockChange"]);
    expect(t.api.apiVersion).toBe(1);
    expect(JSON.stringify(t.api)).not.toContain("AGE-SECRET-KEY");
    expect(() => {
      (t.api as unknown as Record<string, unknown>).decrypt = async () => "x";
    }).toThrow();
  });
});

describe("lock events", () => {
  it("onLockChange fires on unlock and lock, survives a throwing listener, and unsubscribes", async () => {
    const t = await setup();
    const seen: boolean[] = [];
    t.api.onLockChange(() => {
      throw new Error("bad listener");
    });
    const off = t.api.onLockChange((u) => seen.push(u));
    t.host.notifyLockChange(true);
    t.host.notifyLockChange(false);
    off();
    t.host.notifyLockChange(true);
    expect(seen).toEqual([true, false]);
  });

  it("dispose (plugin unload) reports locked and refuses every call", async () => {
    const t = await setup({ existing: { [DAY]: TEXT } });
    const seen: boolean[] = [];
    t.api.onLockChange((u) => seen.push(u));
    t.host.dispose();
    expect(seen).toEqual([false]);
    expect(t.api.isUnlocked()).toBe(false);
    expect(await code(t.api.decrypt(DAY))).toBe("locked");
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("locked");
    // refused up front, even though the key source itself still says unlocked
    expect(t.vault.read).not.toHaveBeenCalled();
    expect(t.vault.kind).not.toHaveBeenCalled();
  });
});

describe("fix round 1", () => {
  it("F1: API calls never reset the idle auto-lock (real PassphraseKeySource, fake timers)", async () => {
    const r = await realSource({ autoLockMinutes: 1 });
    const t = await setup({ identity: r.identity, keySource: r.source, existing: { [DAY]: TEXT } });
    r.hostRef.host = t.host;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // the owner uses rune once more under fake time: this arms the 1-minute idle timer
    await r.source.getIdentity();
    const seen: boolean[] = [];
    t.api.onLockChange((u) => seen.push(u));
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await t.api.decrypt(DAY)).toBe(TEXT);
      await t.api.encrypt(DAY, TEXT, { mode: "replace" });
    }
    expect(r.source.isUnlocked()).toBe(true); // 40 s
    await vi.advanceTimersByTimeAsync(20_000); // 60 s after the owner's last use
    expect(r.source.isUnlocked()).toBe(false);
    expect(seen).toEqual([false]);
    expect(await code(t.api.decrypt(DAY))).toBe("locked");
    expect(r.prompt).toHaveBeenCalledTimes(1); // only the owner's unlock, none from the API
  });

  it("F2a: replace refuses while the file is open with unsaved edits, before touching the key", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    const before = snapshot(t.files);
    t.hooks.openDirty.add(DAY);
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("open-in-editor");
    expect(t.keys.peekRecipients).not.toHaveBeenCalled();
    expect(snapshot(t.files)).toBe(before);
    // other files are unaffected
    await t.api.encrypt(`${FOLDER}/other.md.age`, TEXT, { mode: "create" });
  });

  it("F2a: the owner starting to edit mid-call stops the write", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    const before = snapshot(t.files);
    t.keys.peekRecipients.mockImplementationOnce(async () => {
      t.hooks.openDirty.add(DAY);
      return [...t.recipients];
    });
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("open-in-editor");
    expect(t.vault.replace).not.toHaveBeenCalled();
    expect(snapshot(t.files)).toBe(before);
  });

  it("F3: crypto and key errors never leak plaintext or the identity", async () => {
    const t = await setup({ existing: { [DAY]: TEXT } });
    const poison = () => new Error(`underlying: ${TEXT} ${t.identity}`);
    const caught: { code: string; text: string }[] = [];
    const grab = async (p: Promise<unknown>) => {
      try {
        await p;
        caught.push({ code: "resolved", text: "" });
      } catch (e) {
        caught.push({ code: (e as JournalApiError).code, text: `${(e as Error).message}\n${(e as Error).stack}` });
      }
    };
    cryptoFail.decrypt = poison();
    await grab(t.api.decrypt(DAY));
    cryptoFail.decrypt = null;
    cryptoFail.encrypt = poison();
    await grab(t.api.encrypt(DAY, TEXT, { mode: "replace" }));
    cryptoFail.encrypt = null;
    t.keys.peekIdentity.mockRejectedValueOnce(poison());
    await grab(t.api.decrypt(DAY));
    expect(caught.map((c) => c.code)).toEqual(["decrypt-failed", "encrypt-failed", "locked"]);
    for (const c of caught) {
      expect(c.text).not.toContain("secret journal words");
      expect(c.text).not.toContain(t.identity);
      expect(c.text).not.toContain("AGE-SECRET-KEY");
      expect(c.text).not.toContain("underlying");
    }
  });

  it("F5: lock then re-unlock mid-call is refused by the lock generation", async () => {
    const t = await setup({ existing: { [DAY]: TEXT } });
    const read = t.vault.read.getMockImplementation()!;
    t.vault.read.mockImplementationOnce(async (p: string) => {
      t.lockNow();
      t.state.unlocked = true; // unlocked again before the call goes on
      t.host.notifyLockChange(true);
      return read(p);
    });
    expect(await code(t.api.decrypt(DAY))).toBe("locked");
    expect(t.api.isUnlocked()).toBe(true);
    expect(t.keys.peekIdentity).not.toHaveBeenCalled();
  });

  it("F5: a lock while an encrypt is queued never prompts (real PassphraseKeySource)", async () => {
    const r = await realSource();
    const t = await setup({ identity: r.identity, keySource: r.source });
    r.hostRef.host = t.host;
    let release!: () => void;
    t.hooks.createGate = new Promise<void>((res) => (release = res));
    const p = `${FOLDER}/frag.md.age`;
    const a = t.api.encrypt(p, "first", { mode: "create" });
    const b = t.api.encrypt(p, "second", { mode: "replace" }); // queued behind a
    await vi.waitFor(() => expect(t.vault.create).toHaveBeenCalled());
    await r.source.lockGracefully();
    release();
    await a; // its bytes were already on their way to disk
    expect(await code(b)).toBe("locked");
    expect(r.prompt).toHaveBeenCalledTimes(1); // only the owner's own unlock
    expect(r.source.isUnlocked()).toBe(false);
  });

  it("F6: clearing or narrowing the folder stops a queued write", async () => {
    for (const change of ["", "other"]) {
      const t = await setup();
      let release!: () => void;
      t.hooks.createGate = new Promise<void>((res) => (release = res));
      const a = t.api.encrypt(`${FOLDER}/x.md.age`, "first", { mode: "create" });
      const b = t.api.encrypt(`${FOLDER}/x.md.age`, "second", { mode: "replace" });
      await vi.waitFor(() => expect(t.vault.create).toHaveBeenCalled());
      t.state.folder = change;
      release();
      await a;
      expect(await code(b), change).toBe(change === "" ? "disabled" : "outside-folder");
      expect(t.keys.peekRecipients).toHaveBeenCalledTimes(1); // b refused before touching the key
      expect(t.vault.replace).not.toHaveBeenCalled();
    }
  });

  it("F6: a folder change during the encrypt stops the write", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    const before = snapshot(t.files);
    t.keys.peekRecipients.mockImplementationOnce(async () => {
      t.state.folder = "";
      return [...t.recipients];
    });
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("disabled");
    expect(t.vault.replace).not.toHaveBeenCalled();
    expect(snapshot(t.files)).toBe(before);
  });

  it("F7: a create whose own bytes fail the read-back is removed", async () => {
    const t = await setup();
    cryptoFail.failDecryptAt = 2; // 1 = in-memory round trip, 2 = read-back
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "create" }))).toBe("verify-failed");
    expect(t.files.has(DAY)).toBe(false);
    expect(t.vault.remove).toHaveBeenCalledWith(DAY);
    // and a retry can create it
    await t.api.encrypt(DAY, TEXT, { mode: "create" });
    expect(await t.api.decrypt(DAY)).toBe(TEXT);
  });

  it("F7: create read-back fails and the removal fails too: restore-failed", async () => {
    const t = await setup();
    cryptoFail.failDecryptAt = 2;
    t.hooks.failRemove = true;
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "create" }))).toBe("restore-failed");
  });

  it("F7: a removal that reports success but leaves the file is restore-failed (kind check)", async () => {
    const t = await setup();
    cryptoFail.failDecryptAt = 2;
    t.hooks.removeNoop = true;
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "create" }))).toBe("restore-failed");
  });

  it("F7: replace read-back fails and the restore fails too: restore-failed", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    cryptoFail.failDecryptAt = 2;
    t.hooks.failAfterFirstWrite = true;
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("restore-failed");
  });

  it("F7: a restore that reports success but lands different bytes is restore-failed", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    cryptoFail.failDecryptAt = 2;
    t.hooks.corruptAfterFirstWrite = true;
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("restore-failed");
  });
});

describe("fix round 2", () => {
  const theirsFor = async (t: Awaited<ReturnType<typeof setup>>) => encrypt(t.recipients, "their entry");

  it("N1: another writer lands before the read-back on create: their file survives, conflict", async () => {
    const t = await setup();
    const theirs = await theirsFor(t);
    t.hooks.afterWrite = (p) => t.files.set(p, theirs);
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "create" }))).toBe("conflict");
    expect(t.files.get(DAY)).toBe(theirs);
    expect(t.vault.remove).not.toHaveBeenCalled();
  });

  it("N1: another writer lands before the read-back on replace: their bytes survive, conflict", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    const theirs = await theirsFor(t);
    t.hooks.afterWrite = (p) => t.files.set(p, theirs);
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("conflict");
    expect(t.files.get(DAY)).toBe(theirs);
    expect(t.vault.replace).toHaveBeenCalledTimes(1); // no restore over them
  });

  it("N1: another writer lands during the undo (create): their file is not deleted", async () => {
    const t = await setup();
    const theirs = await theirsFor(t);
    cryptoFail.failDecryptAt = 2;
    cryptoFail.onDecryptFail = () => t.files.set(DAY, theirs);
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "create" }))).toBe("conflict");
    expect(t.files.get(DAY)).toBe(theirs);
    expect(t.vault.remove).not.toHaveBeenCalled();
  });

  it("N1: another writer lands during the undo (replace): the old file is not written over them", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    const theirs = await theirsFor(t);
    cryptoFail.failDecryptAt = 2;
    cryptoFail.onDecryptFail = () => t.files.set(DAY, theirs);
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("conflict");
    expect(t.files.get(DAY)).toBe(theirs);
    expect(t.vault.replace).toHaveBeenCalledTimes(1);
  });

  it("N1: success needs our exact bytes, not just the same text (another writer's identical entry is a conflict)", async () => {
    const t = await setup();
    const sameTextTheirs = await encrypt(t.recipients, TEXT); // different ciphertext, same plaintext
    t.hooks.afterWrite = (p) => t.files.set(p, sameTextTheirs);
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "create" }))).toBe("conflict");
    expect(t.files.get(DAY)).toBe(sameTextTheirs);
  });

  it("N1: an unreadable file after the write touches nothing: restore-failed", async () => {
    const t = await setup({ existing: { [DAY]: "old" } });
    t.hooks.afterWrite = (p) => t.files.delete(p);
    expect(await code(t.api.encrypt(DAY, TEXT, { mode: "replace" }))).toBe("restore-failed");
    expect(t.vault.replace).toHaveBeenCalledTimes(1);
    expect(t.vault.remove).not.toHaveBeenCalled();
  });

  it("T1: the recipient pin changing after unlock makes an API encrypt refuse", async () => {
    const identity = await generateIdentity();
    const own = await identityToRecipient(identity);
    const extra = await identityToRecipient(await generateIdentity());
    const wrapped = await wrapMobileKey(identity, [], PW, 16);
    let pin: RecipientPin | undefined;
    let record: DeviceRecord = { kind: "none" };
    const store: PinStore = {
      get: () => pin,
      save: async (p) => {
        pin = p;
        record = { kind: "ok", recipients: p.recipients, seq: p.seq ?? 0 };
      },
      record: () => record,
      adopt: (p) => {
        record = { kind: "ok", recipients: p.recipients, seq: p.seq ?? 0 };
      },
      confirmFirst: async () => true,
    };
    const source = new PassphraseKeySource({
      adapter: { exists: async () => true, readBinary: async () => wrapped.slice().buffer as ArrayBuffer },
      getSettings: () => ({ mobileKeyPath: "_rune/identity.age", autoLockMinutes: 15, backgroundLockGraceSeconds: 60 }),
      prompt: async (attempt) => (await attempt(PW), true),
      pin: store,
    });
    await source.getIdentity(); // unlock: first use pins [own]
    const t = await setup({ identity, keySource: source });
    await t.api.encrypt(`${FOLDER}/a.md.age`, TEXT, { mode: "create" }); // pinned set: fine
    // a newer, validly MACed confirmation for a different set arrives (another device)
    pin = await makePin(identity, [own, extra], (pin?.seq ?? 0) + 1);
    let err: unknown;
    try {
      await t.api.encrypt(`${FOLDER}/b.md.age`, TEXT, { mode: "create" });
    } catch (e) {
      err = e;
    }
    expect((err as JournalApiError).code).toBe("refused");
    expect((err as Error).message).toMatch(/differ from the set you confirmed/);
    expect(t.files.has(`${FOLDER}/b.md.age`)).toBe(false);
  });
});

describe("vaultPathHasSymlink (real filesystem, scratch dir)", () => {
  it("finds a symlinked folder or file, allows a missing last component, throws on a missing folder", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "rune-journal-"));
    try {
      fs.mkdirSync(path.join(base, "j", "real"), { recursive: true });
      fs.mkdirSync(path.join(base, "outside"));
      fs.writeFileSync(path.join(base, "outside", "x.md.age"), "x");
      fs.symlinkSync(path.join(base, "outside"), path.join(base, "j", "link"));
      fs.symlinkSync(path.join(base, "outside", "x.md.age"), path.join(base, "j", "real", "f.md.age"));
      expect(vaultPathHasSymlink(base, "j/link/x.md.age")).toBe(true);
      expect(vaultPathHasSymlink(base, "j/real/f.md.age")).toBe(true);
      expect(vaultPathHasSymlink(base, "j/real/new.md.age")).toBe(false);
      expect(() => vaultPathHasSymlink(base, "j/nope/new.md.age")).toThrow();
      expect(() => vaultPathHasSymlink("", "j/real/new.md.age")).toThrow();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
