# Security policy

Halfday Obsidian Rune handles cryptographic material and decrypted personal content. We take security reports seriously and ask that you report issues privately so we can address them before public disclosure.

## Reporting a vulnerability

**Please do not file a public GitHub issue for security reports.**

Send security reports to:

> **TBD: security disclosure email address — to be filled in before v0.7 community plugin submission. Suggested: `security@halfday.dev` or a dedicated address on a domain you control.**

If you'd like to encrypt your report, our PGP key is:

> **TBD: PGP key fingerprint and public key URL — to be filled in before v0.7. Suggested: publish the public key at `https://halfday.dev/pgp.asc` and list the fingerprint here.**

Please include:
- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof of concept if available.
- Your name and a way to credit you in the fix announcement (or your preference to remain anonymous).

## Expected response

- **Acknowledgment within 5 business days** of your report. If you haven't heard back by then, please feel free to follow up — your report may not have reached us.
- **Initial triage and severity assessment within 10 business days.**
- **A fix or mitigation plan communicated before any public disclosure**, with a target timeline you'll be looped into.

We follow standard coordinated-disclosure norms: you give us reasonable time to ship a fix, we credit you publicly when the fix lands.

## Scope

In scope:
- Vulnerabilities in the plugin's own code under [`src/`](./src) — crypto helpers, the AgeFileView, decoration logic, sanitization passes, the settings UI, command handlers.
- Vulnerabilities in how the plugin integrates with Obsidian — anything that would cause plaintext to leak to Obsidian's metadata cache, search index, file cache, or other unintended persistence layer.
- Vulnerabilities in the build output (`main.js`, `styles.css`, `manifest.json`) bundled for release.

Out of scope:
- Vulnerabilities in [age](https://age-encryption.org/) itself, or in the [typage](https://github.com/FiloSottile/typage) WASM port. Please report those to the upstream projects.
- Vulnerabilities in Obsidian, Electron, or your operating system.
- Vulnerabilities that require a pre-existing compromise of your local user account (e.g. "an attacker with shell access can read your identity file"). This plugin's threat model assumes your local user account is trusted; see the [threat model](./README.md#threat-model) section of the README.
- Denial-of-service from a maliciously crafted note (e.g. a 100MB single-line note, deeply nested HTML, pathological regex inputs). The plugin tries to behave gracefully but does not guarantee bounded resource usage for adversarial inputs.
- Side-channel inference from `.age` filenames, file sizes, or modification times. Those are a property of the file system, not the plugin.
- Social engineering, phishing, or anything that relies on tricking the user into running a malicious command.

## Known non-issues

These have been considered and are working as designed:
- **Cleartext lives in JS memory while a `.age` view is open.** This is intentional — the whole point of the editor is to manipulate cleartext. Closing the view discards the buffer. Halfday Rune never writes plaintext to disk for a `.age` file's lifecycle.
- **Raw HTML, `javascript:`/`data:` URLs, and image refs are not stripped from the source on save.** They're rendered inert at view time (per the v0.6.3 sanitization rules), but the bytes on disk are exactly what the user typed. This is a deliberate "what you save is what you see" property.

## Disclosure history

No disclosures yet. This section will be updated as reports come in and ship.
