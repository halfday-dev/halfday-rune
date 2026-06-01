# Halfday Obsidian Rune

X25519 [age](https://age-encryption.org/) encryption for Obsidian notes.

Open a `.age` file in your vault and Halfday Rune decrypts it in memory, mounts a CodeMirror editor on the cleartext, and re-encrypts on save. Plaintext never touches disk for born-encrypted notes; for converted notes it lives on disk only as ciphertext.

> 🌐 **[halfday.dev/products/rune](https://halfday.dev/products/rune)** — full product page, screenshots, and the launch story.

Status: pre-release. The plugin is in active development by [halfday](https://halfday.dev). v0.7 will submit it to the Obsidian Community Plugins catalog.

## Why Rune

Your Obsidian vault is plaintext on disk. That used to be fine. In 2026 it isn't: AI desktop tools (Claude Desktop via MCP filesystem servers, Cursor's codebase indexing, ChatGPT's macOS Work-with-Apps), cloud sync providers, indexers like Microsoft Recall, and the growing pile of agents with disk access can all read your notes. Obsidian Sync is end-to-end encrypted in transit but the local files are plaintext.

Rune encrypts at rest using [age](https://age-encryption.org/). Plaintext exists only in editor memory while a note is open; close the tab and it's gone from the process. New notes can be born-encrypted (plaintext never on disk at all). Multi-recipient support means you encrypt to both your daily-driver key and a backup, so losing one device doesn't lose the vault. Rotate-keys re-encrypts every `.age` file to your current recipients when you change the set.

Full case in the launch post: [Using Obsidian Securely in the AI Era](https://halfday.dev/blog/halfday-rune-secure-obsidian-ai-era).

---

## What it does

- **Open `.age` files inline.** A custom view decrypts the file with your age identity and shows the cleartext in a normal-looking editor.
- **Live-preview markdown.** Headings, bold, italic, inline code, links, wikilinks, fenced code blocks, and lists render the same way they do in any Obsidian note.
- **Save re-encrypts in memory.** `cmd-S` (or 30s of inactivity) encrypts the buffer, round-trip-verifies, then overwrites the `.age` on disk. If verification fails, the on-disk file is left untouched.
- **Multi-recipient encryption.** Encrypt to any number of age recipients (your daily-driver key + an offline backup, say). Decrypt with any matching identity.
- **Four commands** registered in the command palette:
  - `Halfday Rune: Test round-trip (X25519)` — proves your keys + the typage WASM stack work without touching any files.
  - `Halfday Rune: Encrypt current note → .age` — seals an existing `.md` to `.md.age`, deletes the plaintext after round-trip verify.
  - `Halfday Rune: New private note` — born-encrypted `.age` file; plaintext never on disk.
  - `Halfday Rune: Decrypt current .age → .md` — inverse of the encrypt command. Two modes: replace (delete `.age` after writing `.md`) or scratch (keep both).
  - `Halfday Rune: Rotate vault keys` — re-encrypts every `.age` file in the vault to your current recipients list. Optional pre-rotation `tar.gz` backup.

---

## Install

### Manual (today — pre-community-catalog)

1. Download `manifest.json`, `main.js`, and `styles.css` from the latest [release](https://github.com/halfday-dev/halfday-obsidian-rune/releases) (TBD: link will go live with the v0.7 submission).
2. Copy them into `<your-vault>/.obsidian/plugins/halfday-rune/`.
3. Enable the plugin in **Settings → Community plugins**. (You'll need **Settings → Community plugins → "Turn on community plugins"** if you've never enabled one before.)

### Community catalog (post-v0.7)

Once submitted and approved, install via **Settings → Community plugins → Browse → Halfday Obsidian Rune**.

---

## Setup

Halfday Rune needs an age recipient list and a matching identity on disk. The defaults match what the halfday CLI sealer uses, so if you already use `seal.sh` you're done.

### Keys

```bash
# generate an X25519 keypair
mkdir -p ~/.age && chmod 700 ~/.age
age-keygen -o ~/.age/vault.identity
chmod 600 ~/.age/vault.identity

# extract the public recipient line into recipients.txt
grep '^# public key:' ~/.age/vault.identity \
  | sed 's/^# public key: //' > ~/.age/recipients.txt
```

`~/.age/recipients.txt` is the canonical recipient list. One `age1...` recipient per line; `#`-prefixed lines are comments. Adding a backup recipient is just adding another line — the plugin will encrypt new notes to all listed recipients, and `Rotate vault keys` updates already-sealed files.

### Plugin settings

Halfday Rune's settings tab has three fields:
- **Recipients file path** — defaults to `~/.age/recipients.txt`.
- **Identity path** — defaults to `~/.age/vault.identity`.
- **Auto-backup before rotate** — on by default. Creates a tar.gz of every `.age` file at `~/halfday/logs/age-backups/` before running `Rotate vault keys`.

There's also an inline "Recipients (file content)" editor — paste your `age1...` lines, save, and the plugin writes them to disk verbatim (preserving comments and ordering). Save validates the whole file before writing; malformed input refuses to save with the offending line called out inline.

### Usage

- **Edit an existing `.age` file:** click it in the file tree. The custom view decrypts to memory, mounts an editor, and saves with `cmd-S` (or after 30s).
- **Create a new private note:** command palette → `Halfday Rune: New private note`, enter a filename, hit Create. Plaintext never touches disk.
- **Encrypt an existing `.md`:** command palette → `Halfday Rune: Encrypt current note → .age`. The plaintext is replaced with `<name>.md.age` after round-trip verify.
- **Decrypt a `.age` back to plaintext:** command palette → `Halfday Rune: Decrypt current .age → .md`. Modal asks whether to delete the `.age` after writing.

---

## Threat model

Halfday Rune exists because **plaintext on disk is the primary risk for a vault that contains personal reflection, therapy notes, or anything else you wouldn't paste into an LLM**. The plugin treats your local disk as semi-trusted (the OS protects your home directory) but treats anything that touches a cloud-sync provider, an LLM context window, or another process's memory as adversarial.

### What it protects

- **At-rest content of sealed notes.** `.age` files on disk are byte-compatible with the standard age CLI: ChaCha20-Poly1305 over an X25519 + HKDF key-agreement. The plaintext is recoverable only by an identity holder.
- **Plaintext leakage to Obsidian's metadata cache and search index.** `.age` files are routed through Halfday Rune's custom view; they never reach Obsidian's `MarkdownView`, file cache, or backlinks resolver. There is no `[[wikilink]]` graph routing, no backlink, no full-text search index for sealed notes.
- **Auto-load network leaks.** The v0.6.3 sanitization pass refuses to auto-load remote images, refuses to render `javascript:` or `data:` URLs as clickable affordances, refuses to transclude `![[embed]]` references, and renders raw HTML (`<script>`, `<iframe>`, `<b>`, …) as literal text rather than parsed markup.
- **Plaintext on encrypt.** "Encrypt current note → .age" round-trip-verifies the ciphertext before deleting the plaintext source. If verification fails, the plaintext is preserved.
- **Plaintext on rotate.** "Rotate vault keys" round-trip-verifies each file before overwriting it, optionally tar.gz-backs-up the whole vault's `.age` files first, and continues on per-file failure rather than aborting.

### What it does NOT protect

- **Cleartext in JS memory while a `.age` view is open.** The whole point of the live editor is to manipulate cleartext; while a `.age` file is open in a Halfday Rune view, its content lives in the CodeMirror document and in the plugin's heap. Closing the view discards the buffer; the plugin never writes plaintext to a temp file, swap, or recovery file. Browser/OS memory dumps, debugger access, or a malicious extension running in the same Electron process can still see it.
- **Your identity file at rest.** `~/.age/vault.identity` is unencrypted on disk. The threat model assumes your local user account is not adversarial. If disk theft is in scope, wrap the identity with `age -p` or use age-plugin-se (Secure Enclave) when that integration ships.
- **Side-channel inference from filenames or directory layout.** A note named `therapy_2026_q1.md.age` reveals "I went to therapy in Q1 2026" to anyone who can read your filesystem listing. Halfday Rune doesn't rename or scramble paths.
- **The age cryptography itself.** Halfday Rune wraps [typage](https://github.com/FiloSottile/typage) (the TypeScript port of [age](https://age-encryption.org/)); cryptographic correctness is age's responsibility, not ours.
- **Obsidian, Electron, or your operating system.** A compromised Obsidian build, a malicious community plugin running in the same context, or a kernel-level adversary defeats this plugin trivially.
- **Cloud sync providers (iCloud, Dropbox, etc.).** Sync replicates `.age` ciphertext, not plaintext, so confidentiality holds — but a sync provider with timing visibility can correlate edit patterns. If that's in scope, host your vault locally.

### Sanitization rules (v0.6.3)

Decrypted markdown flows through these passes before rendering:
- **Raw HTML rendered as literal monospace text.** No `<script>`, `<iframe>`, `<object>`, `<embed>` ever evaluates. Inline tags (`<b>`, `<i>`, …) render as visible angle-bracket source, not as styled markup.
- **`javascript:` and `data:` link schemes get no link affordance.** No accent color, no underline, no hidden-URL trick. The raw `[text](javascript:...)` source stays visible verbatim so what you see is what's on disk.
- **Remote and local images are deferred.** `![alt](url)` is replaced with a placeholder chip reading `[image: alt — url]`. Moving the cursor onto the span reveals the raw markdown for editing. No HTTP request fires. v0.6.3 does not distinguish local-vault images from remote — both are deferred uniformly.
- **`![[embed]]` is inert.** The `!` prefix bypasses the wikilink decoration entirely. The text renders as literal prose. No transclusion is performed; transclusion would require resolving the embed against Obsidian's metadata cache, which the rest of the plugin spends a lot of effort avoiding.

---

## Reporting security issues

See [SECURITY.md](./SECURITY.md). In short: please report security issues privately (not via a public GitHub issue) and we'll get back to you.

---

## License

[Apache 2.0](./LICENSE). Copyright 2026 — see the LICENSE file for the copyright holder line.

---

## Contributing

Halfday Rune is built in TypeScript with [obsidian-plugin-cli](https://github.com/marcusolsson/obsidian-plugin-cli) for the build, [esbuild](https://esbuild.github.io/) under the hood, and [vitest](https://vitest.dev/) for unit tests.

```bash
npm install
npm run dev        # watch-mode build into the plugin folder
npm test           # vitest run
npx tsc --noEmit   # type-check
```

The plugin design plan and milestone history live in the [vault_plugin_v0_plan](https://github.com/halfday-dev/halfday-obsidian-rune/wiki/vault_plugin_v0_plan) document (link TBD).

---

<sub>Plugin scaffold initially generated by [create-obsidian-plugin](https://www.npmjs.com/package/create-obsidian-plugin).</sub>
