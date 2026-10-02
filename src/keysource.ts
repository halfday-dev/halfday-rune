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
