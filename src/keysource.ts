/**
 * Key source: the single place the plugin gets its age identity and
 * recipients from. Every encrypt/decrypt call site goes through one
 * KeySource held by the plugin, so a second source (e.g. a passphrase
 * unlocked identity held in memory on mobile) can be added without
 * touching them.
 *
 * No Node imports at the top level: FileKeySource reaches the Node file
 * helpers through the lazy loader (crypto-node, desktop only).
 */

import { identityToRecipient } from "age-encryption";
import { unwrapMobileKey } from "./crypto";
import { loadCryptoNode } from "./node-loader";

export interface KeySource {
  /** The AGE-SECRET-KEY-1... string. Rejects if it can't be provided. */
  getIdentity(): Promise<string>;
  /** The age1... recipients to encrypt to. */
  getRecipients(): Promise<string[]>;
  /** True when getIdentity() can answer without user action. */
  isUnlocked(): boolean;
  /** Drop any held secret. Nothing to drop for a file-backed source. */
  lock(): void;
  /**
   * True when writes only ever go to this source's own single recipient, so
   * a save must refuse a note whose header has other recipients (they would
   * be silently dropped). Mobile: true. Desktop: false (recipients.txt rules).
   */
  readonly soleRecipientOnly?: boolean;
}

/** The two file paths FileKeySource reads; the settings object satisfies it. */
export interface KeyFilePaths {
  identityPath: string;
  recipientsPath: string;
}

/**
 * Desktop source: reads `identityPath` / `recipientsPath` from disk on every
 * call, exactly as the call sites did before (nothing cached, same paths,
 * same errors). Paths come from a getter so a settings change is picked up
 * on the next read.
 */
export class FileKeySource implements KeySource {
  constructor(
    private getPaths: () => KeyFilePaths,
    private loadNode: typeof loadCryptoNode = loadCryptoNode
  ) {}

  async getIdentity(): Promise<string> {
    const node = await this.loadNode();
    return node.readIdentity(this.getPaths().identityPath);
  }

  async getRecipients(): Promise<string[]> {
    const node = await this.loadNode();
    return node.readRecipients(this.getPaths().recipientsPath);
  }

  isUnlocked(): boolean {
    return true;
  }

  lock(): void {
    // nothing held in memory — the identity is re-read from disk per use
  }
}

// ---------------------------------------------------------------------------
// Mobile: passphrase-unlocked, memory-only
// ---------------------------------------------------------------------------

/** getIdentity() was called while locked and the user did not unlock. */
export class KeyLockedError extends Error {
  constructor() {
    super("rune is locked");
    this.name = "KeyLockedError";
  }
}

/** The wrapped identity file is not in the vault (yet). Fixed message. */
export class UnlockFileMissingError extends Error {
  constructor() {
    super(
      "No mobile unlock file yet. Run 'Create mobile unlock copy' on desktop and let it sync."
    );
    this.name = "UnlockFileMissingError";
  }
}

/**
 * Asks the user for the passphrase. Calls `attempt(passphrase)` for each
 * try; `attempt` rejects with a fixed-message error (wrong passphrase,
 * missing file) the prompt shows while staying open. Resolves true once an
 * attempt succeeded, false if the user cancelled.
 */
export type UnlockPrompt = (
  attempt: (passphrase: string) => Promise<void>
) => Promise<boolean>;

/** Just the part of Obsidian's DataAdapter this source uses. */
export interface WrappedFileReader {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

export interface MobileKeySettings {
  mobileKeyPath: string;
  /** Idle minutes before auto-lock; 0 = never. */
  autoLockMinutes: number;
  /** Seconds in the background before locking; 0 = immediately. */
  backgroundLockGraceSeconds: number;
}

export interface PassphraseKeySourceDeps {
  adapter: WrappedFileReader;
  getSettings: () => MobileKeySettings;
  prompt: UnlockPrompt;
  /** Called after the locked/unlocked state changes. */
  onStateChange?: (unlocked: boolean) => void;
  /**
   * Runs, awaited, before an automatic or commanded lock while the identity
   * is still held (the plugin flushes unsaved edits here). Errors are
   * swallowed so a failure can never keep the identity in memory.
   */
  beforeLock?: () => Promise<void>;
  now?: () => number;
}

function nonNegInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : fallback;
}

/**
 * Mobile source. Holds the identity in a private field ONLY: never in
 * settings, data.json, localStorage, logs, Notices or error messages. The
 * passphrase is never stored at all; it exists only as the argument of one
 * unwrap attempt.
 */
export class PassphraseKeySource implements KeySource {
  readonly soleRecipientOnly = true;
  #identity: string | null = null;
  #recipients: string[] = [];
  private pending: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = 0;
  private hiddenAt: number | null = null;
  private disposed = false;

  constructor(private readonly deps: PassphraseKeySourceDeps) {}

  /** Never serialise the held identity, whatever calls JSON.stringify on us. */
  toJSON(): Record<string, never> {
    return {};
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  isUnlocked(): boolean {
    return this.#identity !== null;
  }

  async getIdentity(): Promise<string> {
    await this.ensureUnlocked();
    const id = this.#identity;
    if (id === null) throw new KeyLockedError();
    this.touch();
    return id;
  }

  async getRecipients(): Promise<string[]> {
    const id = await this.getIdentity();
    return [await identityToRecipient(id)];
  }

  private async ensureUnlocked(): Promise<void> {
    if (this.#identity !== null) return;
    if (this.disposed) throw new KeyLockedError();
    if (!this.pending) {
      this.pending = (async () => {
        try {
          const ok = await this.deps.prompt((pw) => this.tryUnlock(pw));
          if (!ok || this.#identity === null) throw new KeyLockedError();
        } finally {
          this.pending = null;
        }
      })();
    }
    return this.pending;
  }

  /** One unlock attempt. Throws WrongPassphraseError / UnlockFileMissingError / InvalidWrappedIdentityError. */
  private async tryUnlock(passphrase: string): Promise<void> {
    // a modal still open after unload must not be able to re-arm the key
    if (this.disposed) throw new KeyLockedError();
    const path = this.deps.getSettings().mobileKeyPath;
    if (!(await this.deps.adapter.exists(path))) throw new UnlockFileMissingError();
    const wrapped = new Uint8Array(await this.deps.adapter.readBinary(path));
    const key = await unwrapMobileKey(wrapped, passphrase);
    if (this.disposed) throw new KeyLockedError();
    this.#identity = key.identity;
    this.#recipients = key.recipients;
    this.hiddenAt = null;
    this.touch();
    this.deps.onStateChange?.(true);
  }

  /** Reset the idle clock (called on every successful get and on unlock). */
  private touch(): void {
    this.lastActivity = this.now();
    this.clearTimer("idleTimer");
    const minutes = nonNegInt(this.deps.getSettings().autoLockMinutes, 15);
    if (minutes > 0 && this.#identity !== null) {
      this.idleTimer = setTimeout(() => void this.lockGracefully(), minutes * 60_000);
    }
  }

  private clearTimer(which: "idleTimer" | "graceTimer"): void {
    const t = this[which];
    if (t !== null) clearTimeout(t);
    this[which] = null;
  }

  /**
   * Feed document visibility here. Hidden starts the background grace timer
   * (0 = lock now); visible cancels it. On visible we also re-check the wall
   * clock, because a suspended mobile webview does not run timers.
   */
  setBackgrounded(hidden: boolean): void {
    if (this.#identity === null) {
      this.hiddenAt = null;
      return;
    }
    if (hidden) {
      if (this.hiddenAt === null) this.hiddenAt = this.now();
      const grace = nonNegInt(this.deps.getSettings().backgroundLockGraceSeconds, 60);
      this.clearTimer("graceTimer");
      if (grace === 0) {
        void this.lockGracefully();
      } else {
        this.graceTimer = setTimeout(() => void this.lockGracefully(), grace * 1000);
      }
      return;
    }
    // visible again
    this.clearTimer("graceTimer");
    const s = this.deps.getSettings();
    const grace = nonNegInt(s.backgroundLockGraceSeconds, 60) * 1000;
    const idleMs = nonNegInt(s.autoLockMinutes, 15) * 60_000;
    const t = this.now();
    const away = this.hiddenAt !== null && t - this.hiddenAt >= grace;
    const idle = idleMs > 0 && t - this.lastActivity >= idleMs;
    this.hiddenAt = null;
    if (away || idle) void this.lockGracefully();
  }

  /** Lock after giving the plugin a chance to flush unsaved edits. */
  async lockGracefully(): Promise<void> {
    if (this.#identity === null) return;
    try {
      await this.deps.beforeLock?.();
    } catch {
      /* never let a failed flush keep the key in memory */
    }
    this.lock();
  }

  /** Plugin unload: lock now and refuse to prompt again. */
  dispose(): void {
    this.disposed = true;
    this.lock();
  }

  /** Drop the identity immediately. */
  lock(): void {
    this.clearTimer("idleTimer");
    this.clearTimer("graceTimer");
    this.hiddenAt = null;
    if (this.#identity === null) return;
    this.#identity = null;
    this.#recipients = [];
    this.deps.onStateChange?.(false);
  }
}
