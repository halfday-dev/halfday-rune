/**
 * Journal API noteActivity() (#9): a plugin view reports that the owner is
 * typing or dictating, so rune's idle auto-lock does not fire mid-entry.
 * Real PassphraseKeySource, fake timers (Date included). Test keys only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateIdentity } from "age-encryption";
import { wrapMobileKey } from "../src/crypto";
import { KeyLockedError, PassphraseKeySource } from "../src/keysource";
import type { KeySource } from "../src/keysource";
import { ACTIVITY_THROTTLE_MS, JournalApiHost } from "../src/journal-api";
import type { JournalVault } from "../src/journal-api";

const PW = "a long random passphrase for tests 7310";
const FOLDER = "10_journal";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The vault is never touched by noteActivity(); every method fails loudly. */
const vault: JournalVault = {
  kind: async () => {
    throw new Error("vault must not be touched");
  },
  read: async () => {
    throw new Error("vault must not be touched");
  },
  create: async () => {
    throw new Error("vault must not be touched");
  },
  replace: async () => {
    throw new Error("vault must not be touched");
  },
  remove: async () => {
    throw new Error("vault must not be touched");
  },
};

async function setup(
  opts: { autoLockMinutes?: number; unlocked?: boolean; now?: () => number } = {}
) {
  const identity = await generateIdentity();
  const wrapped = await wrapMobileKey(identity, [], PW, 16);
  const state = { folder: FOLDER, keySourceGone: false };
  const prompt = vi.fn(async (attempt: (pw: string) => Promise<void>) => (await attempt(PW), true));
  const ref: { host: JournalApiHost | null } = { host: null };
  const source = new PassphraseKeySource({
    adapter: { exists: async () => true, readBinary: async () => wrapped.slice().buffer as ArrayBuffer },
    getSettings: () => ({
      mobileKeyPath: "_rune/identity.age",
      autoLockMinutes: opts.autoLockMinutes ?? 1,
      backgroundLockGraceSeconds: 60,
    }),
    prompt,
    onStateChange: (u) => ref.host?.notifyLockChange(u),
  });
  const host = new JournalApiHost({
    getKeySource: () => {
      if (state.keySourceGone) throw new Error("plugin unloaded");
      return source;
    },
    getFolder: () => state.folder,
    excludedPaths: () => ["_rune/identity.age"],
    vault,
    pathHasSymlink: null,
    isOpenDirty: () => false,
    now: opts.now,
  });
  ref.host = host;
  if (opts.unlocked ?? true) {
    await source.getIdentity(); // the owner unlocks: the idle clock starts now
    expect(prompt).toHaveBeenCalledTimes(1);
  }
  const resets = vi.spyOn(source, "noteActivity");
  return { api: host.api(), host, source, prompt, state, resets };
}

const at = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("noteActivity: resets the idle clock while unlocked", () => {
  it("the lock fires autoLockMinutes after the LAST effective call, not the first", async () => {
    const t = await setup({ autoLockMinutes: 1 });
    await at(50_000);
    t.api.noteActivity(); // effective: idle clock restarts at 50 s
    await at(40_000);
    t.api.noteActivity(); // 90 s: 40 s since the last reset, effective again
    expect(t.resets).toHaveBeenCalledTimes(2);
    await at(59_000); // 149 s: 59 s after the last reset
    expect(t.source.isUnlocked()).toBe(true);
    await at(2_000); // 151 s
    expect(t.source.isUnlocked()).toBe(false);
    expect(t.prompt).toHaveBeenCalledTimes(1);
  });

  it("without it, the same minute of typing still locks (the control)", async () => {
    const t = await setup({ autoLockMinutes: 1 });
    await at(61_000);
    expect(t.source.isUnlocked()).toBe(false);
  });

  it("the throttle holds: many calls inside 30 s are one reset", async () => {
    const t = await setup({ autoLockMinutes: 1 });
    await at(10_000);
    for (let i = 0; i < 30; i++) {
      t.api.noteActivity(); // 10 s .. 39 s, one per keystroke-second
      await at(1_000);
    }
    expect(t.resets).toHaveBeenCalledTimes(1); // only the 10 s call reached the key source
    // the lock is 60 s after 10 s, not after 39 s
    await at(29_000); // 69 s
    expect(t.source.isUnlocked()).toBe(true);
    await at(2_000); // 71 s
    expect(t.source.isUnlocked()).toBe(false);
  });

  it("the window is ACTIVITY_THROTTLE_MS: a call exactly that long after the last reset goes through", async () => {
    const t = await setup();
    t.api.noteActivity();
    await at(ACTIVITY_THROTTLE_MS - 1);
    t.api.noteActivity();
    expect(t.resets).toHaveBeenCalledTimes(1);
    await at(1);
    t.api.noteActivity();
    expect(t.resets).toHaveBeenCalledTimes(2);
  });

  it("the first call after a fresh unlock resets at once, even inside the old window", async () => {
    const t = await setup();
    t.api.noteActivity(); // reset, window open until 30 s
    await at(2_000);
    t.source.lock();
    await t.source.getIdentity(); // the owner unlocks again (prompted)
    expect(t.prompt).toHaveBeenCalledTimes(2);
    await at(1_000);
    t.api.noteActivity(); // 3 s: inside the old window, but a new unlock
    expect(t.resets).toHaveBeenCalledTimes(2);
  });

  it("a clock that went backwards ends the window instead of stretching it", async () => {
    let now = 1_000_000;
    const t = await setup({ now: () => now });
    t.api.noteActivity();
    now -= 60_000; // wall clock set back a minute
    t.api.noteActivity();
    expect(t.resets).toHaveBeenCalledTimes(2);
  });

  it("autoLockMinutes 0 (never lock) stays never: no idle timer is ever armed", async () => {
    const t = await setup({ autoLockMinutes: 0 });
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 5; i++) {
      t.api.noteActivity();
      await at(ACTIVITY_THROTTLE_MS);
    }
    expect(t.resets).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
    await at(24 * 3600_000);
    expect(t.source.isUnlocked()).toBe(true);
  });
});

describe("noteActivity: never unlocks, never prompts, reveals nothing", () => {
  it("while locked: still locked, no prompt, no timer, key source not touched", async () => {
    const t = await setup({ unlocked: false });
    expect(t.source.isUnlocked()).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(t.api.noteActivity()).toBeUndefined();
      await at(ACTIVITY_THROTTLE_MS);
    }
    expect(t.source.isUnlocked()).toBe(false);
    expect(t.prompt).not.toHaveBeenCalled();
    expect(t.resets).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(t.source.peekIdentity()).rejects.toBeInstanceOf(KeyLockedError);
  });

  it("after an auto-lock it does not bring the key back", async () => {
    const t = await setup({ autoLockMinutes: 1 });
    await at(61_000);
    expect(t.source.isUnlocked()).toBe(false);
    t.api.noteActivity();
    await at(0);
    expect(t.source.isUnlocked()).toBe(false);
    expect(t.prompt).toHaveBeenCalledTimes(1);
    expect(t.resets).not.toHaveBeenCalled();
  });

  it("returns undefined and never throws, locked or unlocked, reset or throttled", async () => {
    const t = await setup();
    const results = [t.api.noteActivity(), t.api.noteActivity()]; // reset, throttled
    t.source.lock();
    results.push(t.api.noteActivity()); // locked
    expect(results).toEqual([undefined, undefined, undefined]);
  });

  it("does nothing while the journal API is off (no folder, or an invalid one)", async () => {
    const t = await setup({ autoLockMinutes: 1 });
    t.state.folder = "";
    await at(50_000);
    t.api.noteActivity();
    t.state.folder = "../escape";
    await at(5_000);
    t.api.noteActivity();
    expect(t.resets).not.toHaveBeenCalled();
    await at(6_000); // 61 s after the unlock
    expect(t.source.isUnlocked()).toBe(false);
  });

  it("after the plugin unloads (host disposed): no effect, no error", async () => {
    const t = await setup({ autoLockMinutes: 1 });
    t.host.dispose(); // the key source here is still unlocked on purpose
    expect(() => t.api.noteActivity()).not.toThrow();
    expect(t.resets).not.toHaveBeenCalled();
  });

  it("a key source getter that throws (unloaded) is swallowed", async () => {
    const t = await setup();
    t.state.keySourceGone = true;
    expect(() => t.api.noteActivity()).not.toThrow();
    expect(t.resets).not.toHaveBeenCalled();
  });

  it("a key source with no idle clock (desktop key file) is fine", async () => {
    const keys: KeySource = {
      isUnlocked: () => true,
      lock() {},
      getIdentity: async () => "x",
      getRecipients: async () => [],
      peekIdentity: async () => "x",
      peekRecipients: async () => [],
    };
    const host = new JournalApiHost({
      getKeySource: () => keys,
      getFolder: () => FOLDER,
      excludedPaths: () => [],
      vault,
      pathHasSymlink: null,
      isOpenDirty: () => false,
    });
    expect(() => host.api().noteActivity()).not.toThrow();
  });
});

describe("PassphraseKeySource.noteActivity (unthrottled, below the API)", () => {
  it("while locked it does not even read the clock", async () => {
    const identity = await generateIdentity();
    const wrapped = await wrapMobileKey(identity, [], PW, 16);
    const now = vi.fn(() => Date.now());
    const prompt = vi.fn(async () => false);
    const source = new PassphraseKeySource({
      adapter: { exists: async () => true, readBinary: async () => wrapped.slice().buffer as ArrayBuffer },
      getSettings: () => ({ mobileKeyPath: "_rune/identity.age", autoLockMinutes: 1, backgroundLockGraceSeconds: 60 }),
      prompt,
      now,
    });
    source.noteActivity();
    expect(now).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(source.isUnlocked()).toBe(false);
    source.dispose();
    source.noteActivity();
    expect(now).not.toHaveBeenCalled();
  });

  it("while unlocked it resets the clock on every call", async () => {
    const t = await setup({ autoLockMinutes: 1 });
    await at(50_000);
    t.source.noteActivity();
    await at(50_000);
    t.source.noteActivity();
    await at(59_000); // 159 s
    expect(t.source.isUnlocked()).toBe(true);
    await at(2_000);
    expect(t.source.isUnlocked()).toBe(false);
  });
});
