/**
 * Lazy loaders for the modules that import Node built-ins (`fs`, `os`,
 * `path`). main.ts and age-view.ts must never
 * import these statically: on iOS the Node built-ins don't exist and a
 * top-level import would stop the whole plugin from loading. Each loader
 * refuses to run off-desktop, so a stray call fails with a clear error
 * instead of a missing-module crash.
 */

import { Platform } from "obsidian";

function requireDesktop(what: string): void {
  if (!Platform.isDesktopApp) {
    throw new Error(`${what} is only available in the desktop app`);
  }
}

export async function loadCryptoNode(): Promise<typeof import("./crypto-node")> {
  requireDesktop("key and recipients files");
  return import("./crypto-node");
}

export async function loadBackup(): Promise<typeof import("./backup")> {
  requireDesktop("backup");
  return import("./backup");
}

export async function loadRotateLog(): Promise<typeof import("./rotate-log")> {
  requireDesktop("the rotate log");
  return import("./rotate-log");
}
