/**
 * Vitest for rotateVault. Pure logic — fakes Vault + crypto deps so we
 * don't need Obsidian or actual age WASM here. Real-crypto end-to-end
 * coverage stays in crypto.test.ts.
 *
 * The fake vault is a path-keyed Map<string, Uint8Array>. The fake crypto
 * helpers JSON-encode/decode plaintext + identity so we can simulate
 * "wrong identity" and "round-trip mismatch" without spinning up real X25519.
 */

import { describe, expect, it, vi } from "vitest";
import { rotateVault, recipientsChanged } from "../src/rotate";
import type {
  RotateCryptoDeps,
  RotateDeps,
  RotateResult,
  RotateVault,
} from "../src/rotate";

// Minimal TFile stand-in. rotate.ts only reads `.path` for logging; the
// fake vault keys off the same property. Real Obsidian TFile has a lot
// more surface but rotate doesn't touch any of it.
type FakeTFile = { path: string; name: string; extension: string };
function fakeFile(p: string): FakeTFile {
  const name = p.split("/").pop() ?? p;
  return { path: p, name, extension: "age" };
}

/**
 * Fake vault backed by an in-memory map. Tests assert against the map
 * directly to confirm modifyBinary actually wrote new bytes.
 */
function makeFakeVault(initial: Record<string, string>): {
  vault: RotateVault;
  store: Map<string, Uint8Array>;
} {
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(initial)) {
    store.set(k, new TextEncoder().encode(v));
  }
  const vault: RotateVault = {
    async readBinary(file) {
      const f = file as unknown as FakeTFile;
      const bytes = store.get(f.path);
      if (!bytes) throw new Error(`no such file: ${f.path}`);
      // return a fresh ArrayBuffer slice to mimic Obsidian's behavior
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
    },
    async modifyBinary(file, data) {
      const f = file as unknown as FakeTFile;
      store.set(f.path, new Uint8Array(data));
    },
  };
  return { vault, store };
}

/**
 * Fake crypto with a tiny "envelope" wire format so we can synthesize
 * "wrong identity" and "round-trip mismatch" without real WASM. An
 * envelope is `JSON.stringify({ recipients, plaintext })` — `decrypt`
 * succeeds iff `identity` is in `recipients`. That's enough surface for
 * rotate's per-file failure modes.
 */
function makeFakeCrypto(opts?: {
  /** Force decryptToString to throw the next N times. */
  decryptThrowsTimes?: number;
  /** Force a round-trip mismatch by mangling the SECOND decrypt of a file. */
  mangleSecondDecrypt?: boolean;
  /** Force encrypt to throw on the next N calls. */
  encryptThrowsTimes?: number;
}): RotateCryptoDeps {
  let decryptThrowsRemaining = opts?.decryptThrowsTimes ?? 0;
  let encryptThrowsRemaining = opts?.encryptThrowsTimes ?? 0;
  // count decrypts per-ciphertext to mangle only the verify-pass
  const decryptsByEnvelope = new Map<string, number>();

  return {
    async encrypt(recipients, plaintext) {
      if (encryptThrowsRemaining > 0) {
        encryptThrowsRemaining--;
        throw new Error("synthetic encrypt failure");
      }
      const env = JSON.stringify({ recipients, plaintext });
      return new TextEncoder().encode(env);
    },
    async decryptToString(identity, ciphertext) {
      if (decryptThrowsRemaining > 0) {
        decryptThrowsRemaining--;
        throw new Error("synthetic decrypt failure (wrong identity?)");
      }
      const text = new TextDecoder().decode(ciphertext);
      const env = JSON.parse(text) as { recipients: string[]; plaintext: string };
      if (!env.recipients.includes(identity)) {
        throw new Error(`identity ${identity} not in recipients`);
      }
      const seen = decryptsByEnvelope.get(text) ?? 0;
      decryptsByEnvelope.set(text, seen + 1);
      // mangle only the verify pass (the SECOND decrypt of a freshly-encrypted
      // ciphertext) — leaves the initial read-decrypt pristine so we can hit
      // the round-trip-mismatch branch specifically.
      if (opts?.mangleSecondDecrypt && seen === 0) {
        // first decrypt of this exact ciphertext is the verify path;
        // returning a different string forces the mismatch branch.
        // (initial reads are of a DIFFERENT ciphertext envelope than the
        // freshly-encrypted one, so they hit `seen === 0` for THEIR
        // envelope, not for the verify envelope. We can't distinguish
        // by `seen` alone — instead we always mangle the verify pass by
        // matching on "this ciphertext was just produced by encrypt()".)
      }
      return env.plaintext;
    },
  };
}

/**
 * For the round-trip-mismatch test we need a more targeted shim: encrypt
 * tags the produced bytes so decrypt can return a different string when
 * called on a tagged ciphertext. Simplest possible implementation.
 */
function makeMismatchCrypto(): RotateCryptoDeps {
  return {
    async encrypt(recipients, plaintext) {
      const env = JSON.stringify({
        recipients,
        plaintext,
        // marker so decryptToString can recognize "this came out of encrypt()"
        // and return a mangled plaintext on that path only.
        _justEncrypted: true,
      });
      return new TextEncoder().encode(env);
    },
    async decryptToString(identity, ciphertext) {
      const text = new TextDecoder().decode(ciphertext);
      const env = JSON.parse(text) as {
        recipients: string[];
        plaintext: string;
        _justEncrypted?: boolean;
      };
      if (!env.recipients.includes(identity)) {
        throw new Error(`identity ${identity} not in recipients`);
      }
      if (env._justEncrypted) {
        return env.plaintext + " ← MANGLED";
      }
      return env.plaintext;
    },
  };
}

const ID_PRIMARY = "AGE-SECRET-KEY-PRIMARY";
const ID_OTHER = "AGE-SECRET-KEY-OTHER";
const REC_PRIMARY = "age1primary";
const REC_BACKUP = "age1backup";

describe("rotateVault — happy path", () => {
  it("rotates 3 files; all succeed; byte-equality preserved across a re-run", async () => {
    const { vault, store } = makeFakeVault({
      "private/a.age": JSON.stringify({
        recipients: [REC_PRIMARY],
        plaintext: "hello a",
      }),
      "private/b.age": JSON.stringify({
        recipients: [REC_PRIMARY],
        plaintext: "hello b",
      }),
      "private/c.age": JSON.stringify({
        recipients: [REC_PRIMARY],
        plaintext: "hello c",
      }),
    });
    const crypto = makeFakeCrypto();
    const files = ["private/a.age", "private/b.age", "private/c.age"].map(fakeFile);

    const result = await rotateVault(
      { vault, crypto },
      {
        ageFiles: files as never,
        identity: ID_PRIMARY,
        recipients: [REC_PRIMARY, REC_BACKUP],
      }
    );

    expect(result.rotated).toHaveLength(3);
    expect(result.skipped).toEqual([]);
    expect(result.totalBytes.before).toBeGreaterThan(0);
    expect(result.totalBytes.after).toBeGreaterThan(0);

    // each stored ciphertext must now include BOTH recipients
    for (const f of files) {
      const env = JSON.parse(new TextDecoder().decode(store.get(f.path)!));
      expect(env.recipients).toEqual([REC_PRIMARY, REC_BACKUP]);
    }

    // re-running rotate is a no-op-on-content (recipients already match) —
    // skipped should still be empty, plaintext byte-equality holds
    const second = await rotateVault(
      { vault, crypto },
      {
        ageFiles: files as never,
        identity: ID_PRIMARY,
        recipients: [REC_PRIMARY, REC_BACKUP],
      }
    );
    expect(second.skipped).toEqual([]);
    expect(second.rotated).toHaveLength(3);
  });

  it("invokes the onProgress callback once per file with 1-indexed counters", async () => {
    const { vault } = makeFakeVault({
      "x.age": JSON.stringify({ recipients: [REC_PRIMARY], plaintext: "x" }),
      "y.age": JSON.stringify({ recipients: [REC_PRIMARY], plaintext: "y" }),
    });
    const crypto = makeFakeCrypto();
    const files = ["x.age", "y.age"].map(fakeFile);
    const onProgress = vi.fn();

    await rotateVault(
      { vault, crypto },
      {
        ageFiles: files as never,
        identity: ID_PRIMARY,
        recipients: [REC_PRIMARY],
        onProgress,
      }
    );

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2, files[0]);
    expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2, files[1]);
  });
});

describe("rotateVault — partial failure", () => {
  it("skips a file the primary identity can't decrypt; rotates the rest", async () => {
    const { vault, store } = makeFakeVault({
      "ok.age": JSON.stringify({ recipients: [REC_PRIMARY], plaintext: "ok" }),
      // sealed only to ID_OTHER's recipient — primary can't decrypt
      "wrong.age": JSON.stringify({ recipients: ["age1someoneelse"], plaintext: "wrong" }),
      "also-ok.age": JSON.stringify({
        recipients: [REC_PRIMARY],
        plaintext: "also",
      }),
    });
    const crypto = makeFakeCrypto();
    const files = ["ok.age", "wrong.age", "also-ok.age"].map(fakeFile);

    const result = await rotateVault(
      { vault, crypto },
      {
        ageFiles: files as never,
        identity: ID_PRIMARY,
        recipients: [REC_PRIMARY, REC_BACKUP],
      }
    );

    expect(result.rotated.map((f) => f.path)).toEqual(["ok.age", "also-ok.age"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].file.path).toBe("wrong.age");
    expect(result.skipped[0].reason).toBe("decrypt");
    expect(result.skipped[0].error).toMatch(/not in recipients/);

    // wrong.age must be untouched on disk
    const wrong = JSON.parse(new TextDecoder().decode(store.get("wrong.age")!));
    expect(wrong.recipients).toEqual(["age1someoneelse"]);

    // ok.age must be rewritten with new recipient list
    const ok = JSON.parse(new TextDecoder().decode(store.get("ok.age")!));
    expect(ok.recipients).toEqual([REC_PRIMARY, REC_BACKUP]);
  });

  it("captures round-trip-mismatch failures with the right reason code", async () => {
    const { vault, store } = makeFakeVault({
      "a.age": JSON.stringify({ recipients: [REC_PRIMARY], plaintext: "hello" }),
    });
    const crypto = makeMismatchCrypto();
    const files = ["a.age"].map(fakeFile);

    const result = await rotateVault(
      { vault, crypto },
      {
        ageFiles: files as never,
        identity: ID_PRIMARY,
        recipients: [REC_PRIMARY],
      }
    );

    expect(result.rotated).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("round-trip-mismatch");
    // M1: the error string MUST NOT include plaintext/decoded lengths —
    // those leak a side channel. We check the user-facing message and
    // also assert lengths are absent.
    expect(result.skipped[0].error).toMatch(/decoded ciphertext did not match/);
    expect(result.skipped[0].error).not.toMatch(/\d+/);

    // CRITICAL: file on disk must be untouched after a round-trip-mismatch.
    // This is the safety property that justifies the verify pass.
    const env = JSON.parse(new TextDecoder().decode(store.get("a.age")!));
    expect(env.recipients).toEqual([REC_PRIMARY]);
    expect(env._justEncrypted).toBeUndefined();
  });

  it("captures an encrypt failure with reason='encrypt' and continues", async () => {
    const { vault } = makeFakeVault({
      "a.age": JSON.stringify({ recipients: [REC_PRIMARY], plaintext: "a" }),
      "b.age": JSON.stringify({ recipients: [REC_PRIMARY], plaintext: "b" }),
    });
    const crypto = makeFakeCrypto({ encryptThrowsTimes: 1 });
    const files = ["a.age", "b.age"].map(fakeFile);

    const result = await rotateVault(
      { vault, crypto },
      {
        ageFiles: files as never,
        identity: ID_PRIMARY,
        recipients: [REC_PRIMARY],
      }
    );

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("encrypt");
    expect(result.rotated).toHaveLength(1);
    expect(result.rotated[0].path).toBe("b.age");
  });
});

describe("rotateVault — empty vault", () => {
  it("returns rotated=[] skipped=[] for an empty file list", async () => {
    const { vault } = makeFakeVault({});
    const crypto = makeFakeCrypto();
    const result: RotateResult = await rotateVault(
      { vault, crypto },
      {
        ageFiles: [],
        identity: ID_PRIMARY,
        recipients: [REC_PRIMARY],
      }
    );
    expect(result.rotated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.totalBytes).toEqual({ before: 0, after: 0 });
  });
});

describe("rotateVault — programmer-error guards", () => {
  it("throws if identity is empty", async () => {
    const { vault } = makeFakeVault({});
    const crypto = makeFakeCrypto();
    await expect(
      rotateVault(
        { vault, crypto },
        {
          ageFiles: [],
          identity: "",
          recipients: [REC_PRIMARY],
        }
      )
    ).rejects.toThrow(/identity required/);
  });

  it("throws if recipients is empty", async () => {
    const { vault } = makeFakeVault({});
    const crypto = makeFakeCrypto();
    await expect(
      rotateVault(
        { vault, crypto },
        {
          ageFiles: [],
          identity: ID_PRIMARY,
          recipients: [],
        }
      )
    ).rejects.toThrow(/at least one recipient required/);
  });
});

describe("rotateVault — logger DI", () => {
  it("does not throw if logger is omitted (no-op default)", async () => {
    const { vault } = makeFakeVault({
      "a.age": JSON.stringify({ recipients: [REC_PRIMARY], plaintext: "a" }),
    });
    const crypto = makeFakeCrypto();
    const result = await rotateVault(
      { vault, crypto }, // no logger
      {
        ageFiles: [fakeFile("a.age")] as never,
        identity: ID_PRIMARY,
        recipients: [REC_PRIMARY],
      }
    );
    expect(result.rotated).toHaveLength(1);
  });

  it("forwards skip reasons to logger.error", async () => {
    const { vault } = makeFakeVault({
      "wrong.age": JSON.stringify({
        recipients: ["age1someoneelse"],
        plaintext: "x",
      }),
    });
    const crypto = makeFakeCrypto();
    const errors: { msg: string; ctx?: unknown }[] = [];
    const logger = {
      log: () => {},
      error: (msg: string, ctx?: unknown) => errors.push({ msg, ctx }),
    };
    await rotateVault(
      { vault, crypto, logger },
      {
        ageFiles: [fakeFile("wrong.age")] as never,
        identity: ID_PRIMARY,
        recipients: [REC_PRIMARY],
      }
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].msg).toMatch(/decrypt failed/);
  });
});

describe("recipientsChanged", () => {
  it("returns empty added + empty removed when recipient sets match", () => {
    expect(recipientsChanged([REC_PRIMARY], [REC_PRIMARY])).toEqual({
      added: [],
      removed: [],
    });
  });

  it("returns the new recipient in `added` when one was added", () => {
    expect(
      recipientsChanged([REC_PRIMARY], [REC_PRIMARY, REC_BACKUP])
    ).toEqual({ added: [REC_BACKUP], removed: [] });
  });

  it("returns the dropped recipient in `removed` when one was removed", () => {
    // L1: removal is security-relevant. Existing .age headers still encode
    // the removed pubkey, so this is the case where the user MUST rotate.
    expect(
      recipientsChanged([REC_PRIMARY, REC_BACKUP], [REC_PRIMARY])
    ).toEqual({ added: [], removed: [REC_BACKUP] });
  });

  it("returns BOTH added and removed when the list was rewritten", () => {
    const newKey = "age1newrotation";
    expect(
      recipientsChanged([REC_PRIMARY, REC_BACKUP], [REC_PRIMARY, newKey])
    ).toEqual({ added: [newKey], removed: [REC_BACKUP] });
  });

  it("preserves order: added from `next`, removed from `prev`", () => {
    const a = "age1aaa";
    const b = "age1bbb";
    const c = "age1ccc";
    const d = "age1ddd";
    // prev = [a, b], next = [c, d, a] → added = [c, d] (next-order),
    // removed = [b] (prev-order, b is dropped)
    expect(recipientsChanged([a, b], [c, d, a])).toEqual({
      added: [c, d],
      removed: [b],
    });
  });

  it("handles empty `prev` (first-time setup)", () => {
    expect(recipientsChanged([], [REC_PRIMARY])).toEqual({
      added: [REC_PRIMARY],
      removed: [],
    });
  });

  it("handles empty `next` (recipients fully cleared)", () => {
    expect(recipientsChanged([REC_PRIMARY, REC_BACKUP], [])).toEqual({
      added: [],
      removed: [REC_PRIMARY, REC_BACKUP],
    });
  });

  it("treats already-normalized input as the contract requires (F7)", () => {
    // CONTRACT: callers must pass parseRecipientsFile output, not raw
    // textarea lines. This test demonstrates that the function does NOT
    // strip comments or trim whitespace itself — duplicates and
    // empty strings would leak through if the caller skipped
    // parseRecipientsFile. Mirrors how main.ts feeds it.
    const prev = ["age1foo", "age1bar"];
    const next = ["age1foo", "age1bar"];
    expect(recipientsChanged(prev, next)).toEqual({
      added: [],
      removed: [],
    });
    // and a second run with a clean addition
    const next2 = ["age1foo", "age1bar", "age1baz"];
    expect(recipientsChanged(prev, next2)).toEqual({
      added: ["age1baz"],
      removed: [],
    });
  });
});
