import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { wrapIdentity } from "../src/crypto";
import {
  PassphraseKeySource,
  KeyLockedError,
  UnlockFileMissingError,
  type MobileKeySettings,
} from "../src/keysource";

const PW = "a long random passphrase 98765";
const PATH = "_rune/identity.age";

let identity: string;
let wrapped: Uint8Array;
beforeEach(async () => {
  identity = await generateIdentity();
  wrapped = await wrapIdentity(identity, PW, 16);
});

function make(over: Partial<MobileKeySettings> = {}, files: Record<string, Uint8Array> | null = null) {
  const settings: MobileKeySettings = {
    mobileKeyPath: PATH,
    autoLockMinutes: 15,
    backgroundLockGraceSeconds: 60,
    ...over,
  };
  const fileMap = files ?? { [PATH]: wrapped };
  const attempts: string[] = [];
  const errors: unknown[] = [];
  const state: boolean[] = [];
  let queue: string[] = [PW];
  const ks = new PassphraseKeySource({
    adapter: {
      exists: async (p) => p in fileMap,
      readBinary: async (p) => fileMap[p].slice().buffer as ArrayBuffer,
    },
    getSettings: () => settings,
    prompt: async (attempt) => {
      while (queue.length) {
        const pw = queue.shift()!;
        attempts.push(pw);
        try {
          await attempt(pw);
          return true;
        } catch (e) {
          errors.push(e);
        }
      }
      return false; // cancelled
    },
    onStateChange: (u) => state.push(u),
  });
  return { ks, settings, attempts, errors, state, setQueue: (q: string[]) => (queue = q) };
}

describe("PassphraseKeySource", () => {
  it("is locked, then unlocks on demand and derives the recipient", async () => {
    const { ks, state } = make();
    expect(ks.isUnlocked()).toBe(false);
    expect(await ks.getIdentity()).toBe(identity);
    expect(ks.isUnlocked()).toBe(true);
    expect(await ks.getRecipients()).toEqual([await identityToRecipient(identity)]);
    expect(state).toEqual([true]);
  });

  it("a wrong passphrase stays locked with the fixed error and allows a retry", async () => {
    const t = make();
    t.setQueue(["wrong passphrase wrong 1234", PW]);
    expect(await t.ks.getIdentity()).toBe(identity);
    expect(t.errors).toHaveLength(1);
    expect((t.errors[0] as Error).message).toBe("Wrong passphrase");
    expect(t.attempts).toHaveLength(2);
  });

  it("cancelling the prompt throws KeyLockedError and stays locked", async () => {
    const t = make();
    t.setQueue(["wrong passphrase wrong 1234"]);
    await expect(t.ks.getIdentity()).rejects.toBeInstanceOf(KeyLockedError);
    expect(t.ks.isUnlocked()).toBe(false);
    await expect(t.ks.getRecipients()).rejects.toBeInstanceOf(KeyLockedError);
  });

  it("a missing unlock file gives the fixed message", async () => {
    const t = make({}, {});
    await expect(t.ks.getIdentity()).rejects.toBeInstanceOf(KeyLockedError);
    expect(t.errors[0]).toBeInstanceOf(UnlockFileMissingError);
    expect((t.errors[0] as Error).message).toMatch(/Create mobile unlock copy/);
  });

  it("lock() drops the identity, notifies, and the next get prompts again", async () => {
    const t = make();
    await t.ks.getIdentity();
    t.ks.lock();
    expect(t.ks.isUnlocked()).toBe(false);
    expect(t.state).toEqual([true, false]);
    t.setQueue([PW]);
    expect(await t.ks.getIdentity()).toBe(identity);
    expect(t.attempts).toHaveLength(2);
  });

  it("concurrent gets while locked share one prompt", async () => {
    const t = make();
    const [a, b] = await Promise.all([t.ks.getIdentity(), t.ks.getIdentity()]);
    expect(a).toBe(identity);
    expect(b).toBe(identity);
    expect(t.attempts).toHaveLength(1);
  });

  it("does not expose the identity through serialisation or enumerable fields", async () => {
    const t = make();
    await t.ks.getIdentity();
    expect(JSON.stringify(t.ks)).toBe("{}");
    for (const k of Object.keys(t.ks)) {
      expect(String((t.ks as unknown as Record<string, unknown>)[k])).not.toContain("AGE-SECRET-KEY");
    }
  });

  it("dispose() locks and refuses to prompt again", async () => {
    const t = make();
    await t.ks.getIdentity();
    t.ks.dispose();
    t.setQueue([PW]);
    await expect(t.ks.getIdentity()).rejects.toBeInstanceOf(KeyLockedError);
    expect(t.attempts).toHaveLength(1);
  });
});

describe("auto-lock timers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("locks after the idle minutes; each get resets the clock", async () => {
    const t = make({ autoLockMinutes: 2 });
    await t.ks.getIdentity();
    await vi.advanceTimersByTimeAsync(90_000);
    await t.ks.getIdentity(); // reset
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.ks.isUnlocked()).toBe(true);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(t.ks.isUnlocked()).toBe(false);
  });

  it("autoLockMinutes 0 never idle-locks", async () => {
    const t = make({ autoLockMinutes: 0 });
    await t.ks.getIdentity();
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(t.ks.isUnlocked()).toBe(true);
  });

  it("background: locks after the grace period; coming back sooner cancels", async () => {
    const t = make({ backgroundLockGraceSeconds: 60, autoLockMinutes: 0 });
    await t.ks.getIdentity();
    t.ks.setBackgrounded(true);
    await vi.advanceTimersByTimeAsync(30_000);
    t.ks.setBackgrounded(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.ks.isUnlocked()).toBe(true);
    t.ks.setBackgrounded(true);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(t.ks.isUnlocked()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.ks.isUnlocked()).toBe(false);
  });

  it("grace 0 locks immediately when backgrounded", async () => {
    const t = make({ backgroundLockGraceSeconds: 0, autoLockMinutes: 0 });
    await t.ks.getIdentity();
    t.ks.setBackgrounded(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.ks.isUnlocked()).toBe(false);
  });

  it("a suspended webview (timers never fired) still locks on return by wall clock", async () => {
    const t = make({ backgroundLockGraceSeconds: 60, autoLockMinutes: 0 });
    await t.ks.getIdentity();
    t.ks.setBackgrounded(true);
    vi.setSystemTime(Date.now() + 10 * 60_000); // jump without running timers
    t.ks.setBackgrounded(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.ks.isUnlocked()).toBe(false);
  });

  it("beforeLock runs while the identity is still held, and a throwing hook cannot keep it", async () => {
    let heldDuring: boolean | null = null;
    const ref: { ks?: PassphraseKeySource } = {};
    const fileMap = { [PATH]: wrapped };
    ref.ks = new PassphraseKeySource({
      adapter: {
        exists: async (p) => p in fileMap,
        readBinary: async (p) => (fileMap as Record<string, Uint8Array>)[p].slice().buffer as ArrayBuffer,
      },
      getSettings: () => ({ mobileKeyPath: PATH, autoLockMinutes: 15, backgroundLockGraceSeconds: 60 }),
      prompt: async (attempt) => (await attempt(PW), true),
      beforeLock: async () => {
        heldDuring = ref.ks!.isUnlocked();
        throw new Error("flush failed");
      },
    });
    await ref.ks.getIdentity();
    await ref.ks.lockGracefully();
    expect(heldDuring).toBe(true);
    expect(ref.ks.isUnlocked()).toBe(false);
  });
});
