# halfday-obsidian-rune — dev guide

quick reference for building, running, and testing the plugin during v0 development.

scaffold lives at `~/halfday/obsidian-rune/halfday-obsidian-rune/` (per the v0 plan; you may move it later).

## one-time setup

### 1. install dependencies

```bash
cd ~/halfday/obsidian-rune/halfday-obsidian-rune
npm install
```

this installs `age-encryption` (the typage WASM port), the obsidian plugin tooling, vitest, and TypeScript 5.

### 2. generate the X25519 keypair (if not already done by the seal handoff)

```bash
mkdir -p ~/.age && chmod 700 ~/.age
age-keygen -o ~/.age/vault.identity
chmod 600 ~/.age/vault.identity
grep '^# public key:' ~/.age/vault.identity | sed 's/^# public key: //' > ~/.age/vault.recipient
```

if the seal handoff already created these, leave them alone — the plugin shares the same keypair.

### 3. set up the dev vault

we don't iterate against the real vault. spin up a throwaway:

```bash
mkdir -p ~/Documents/halfday-rune-devvault
open -a Obsidian ~/Documents/halfday-rune-devvault
# in obsidian: settings → community plugins → enable, then turn off restricted mode
```

two ways to get the plugin into the vault — pick one:

**option A (recommended): let `npm run dev` copy it for you.** obsidian-plugin-cli's dev mode watches `src/main.ts` and copies the built `main.js` (plus `manifest.json`) directly into `<vault>/.obsidian/plugins/halfday-obsidian-rune/`. it will also prompt you once to auto-install pjeby's [hot-reload](https://github.com/pjeby/hot-reload) plugin. no symlink needed.

**option B: symlink + `npm run build`.** if you'd rather iterate with explicit builds:

```bash
mkdir -p ~/Documents/halfday-rune-devvault/.obsidian/plugins
ln -s ~/halfday/obsidian-rune/halfday-obsidian-rune \
  ~/Documents/halfday-rune-devvault/.obsidian/plugins/halfday-obsidian-rune
```

the symlink target name must match the plugin id in `manifest.json`. you then run `npm run build` manually each time. install hot-reload separately if you want it.

## daily loop

option A:

```bash
# in one terminal
npm run dev          # watches src/main.ts, copies main.js + manifest.json into the dev vault on save

# in another terminal (when you want to run unit tests)
npm test             # one-shot
npm run test:watch   # vitest watch mode
```

option B:

```bash
npm run build        # one-shot; writes main.js to the plugin root (symlinked into the vault)
npm test             # unit tests
```

production build for shipping:

```bash
npm run build        # minified main.js at the plugin root (same command, just no watcher)
```

then in Obsidian: open the command palette (cmd-p), search "Halfday Rune". the plugin ships two commands:

- **Test round-trip (X25519)** — v0.1. encrypts and decrypts a hardcoded string. no files touched. on success: `Halfday Rune: round-trip ok (12ms)`.
- **Encrypt current note → .age** — v0.2. active `.md` only. refuses if the file is already `.age`, if frontmatter has `privacy: open`, or if a sibling `.md.age` / `.meta.md` already exists. on success: `Halfday Rune: sealed foo.md → foo.md.age (34ms)` and the original disappears.

and one custom view:

- **AgeFileView** (`.age` extension) — v0.3.0. opening any `.age` file in the vault routes it through our view instead of Obsidian's binary fallback. the plugin decrypts the file to memory and shows the plaintext in a read-only preformatted block. status line at top reports decrypt outcome. no editing yet (v0.3.1 swaps in CM6; v0.3.2 enables edit + save).

failures surface as Notices with a one-line error; full stack traces go to devtools (`cmd-opt-i`).

> **v0.3 dev tip:** prefer **option B (symlink)** during v0.3 work so `styles.css` stays in sync alongside `main.js` / `manifest.json`. `obsidian-plugin dev` only copies `main.js` + `manifest.json` into the vault — it does not copy `styles.css`, and the AgeFileView reads nicer with its styles applied.

## what v0.1 proves

if "Test round-trip (X25519)" returns ok inside Obsidian, three risks are retired:

1. typage's WASM module loads in Obsidian's Electron context
2. the X25519 native path works with real keys (no SSH-recipient fallback needed)
3. `fs`/`os`/`path` access from a plugin works for files outside the vault (i.e. `~/.age/vault.*`)

if any of these fail, see "troubleshooting" below.

## what v0.2 proves

if "Encrypt current note → .age" runs cleanly on a throwaway `.md`, these risks are retired:

1. the file-write path works — `.md.age` (binary) and `.meta.md` (text) both land via the Obsidian vault API
2. round-trip byte-verify-then-delete matches seal.sh's safety property — on any failure, the plaintext survives
3. the sidecar is byte-compatible with what `seal.sh` produces for the same input (frontmatter shape, `## shape` stats line, sorted+deduped wikilinks)

sanity sequence on a dev vault (don't do this on your real vault):

```
1. create a throwaway note with some [[wikilinks]]
2. cmd-p → "Halfday Rune: Encrypt current note → .age"
3. expect: foo.md disappears, foo.md.age and foo.meta.md appear
4. inspect foo.meta.md — should have `type: meta-sidecar`, `privacy: open`, etc.
5. CLI verify: age -d -i ~/.age/vault.identity /path/to/foo.md.age
```

point 5 is how you prove v0.2 output is CLI-compatible. if that decrypt round-trips, the plugin and seal.sh are interchangeable for non-classified sealing.

## what v0.3.0 proves

if clicking an `.age` file in the file pane opens it in the AgeFileView with the plaintext visible, three risks are retired:

1. `registerExtensions(["age"], ...)` actually routes `.age` (and therefore `.md.age`) to our view instead of Obsidian's binary fallback
2. `vault.readBinary()` in a FileView's `onLoadFile` hook returns a buffer typage can decrypt with no pre-processing
3. plaintext stays in JS memory only — no vault write happens during open

sanity sequence on a dev vault:

```
1. seal a throwaway note (see v0.2 sequence above) so you have a foo.md.age
2. click foo.md.age in the file pane
3. expect: lock-icon tab titled "foo.md.age", status line "decrypted · N chars from M bytes · read-only (v0.3.0)", plaintext below
4. close the tab, reopen — should decrypt again fresh
5. change identityPath in settings to a wrong identity, reopen the file — status should show "decrypt failed — …" (plaintext cleared, no crash)
```

if step 2 gives you the binary fallback (hex dump / "cannot display"), `registerExtensions` didn't take — check for conflicting plugins and try reloading Obsidian.

## troubleshooting

### plugin doesn't appear in obsidian / "failed to load"

the plugin folder needs `main.js` + `manifest.json` at its root. if you only copied source (`src/main.ts` etc.) without building, obsidian has nothing to load. run `npm run build` (or `npm run dev` and let it copy for you), then in obsidian: settings → community plugins → click the refresh icon → enable the plugin.

if `npm run build` errors with "Unexpected arguments": the `package.json` build script regressed to invoking flags that obsidian-plugin-cli@0.4.5 doesn't support (e.g. `--with-stylesheet`). the correct invocation is `obsidian-plugin build src/main.ts -o .` — single positional entry point, `-o .` to output `main.js` at the plugin root rather than `dist/main.js`.

### "Cannot find module 'age-encryption'"

`npm install` didn't run inside the plugin dir, or it ran in the *parent* directory. the dependency must be in `halfday-obsidian-rune/package.json`, not `~/halfday/obsidian-rune/package.json`.

```bash
cd ~/halfday/obsidian-rune/halfday-obsidian-rune
cat package.json | jq .dependencies
# expected: { "age-encryption": "^0.3.0" }
npm install
```

### "no age1... recipient found"

the recipient file is empty or missing. re-run the keygen step from setup, or check whichever path you've configured under settings.

### "no AGE-SECRET-KEY-1... identity found"

same diagnosis for the identity file.

### round-trip MISMATCH

if encryption succeeded but decryption returned different bytes, that's a serious bug in typage or the helpers. file the round-trip plaintext + decoded output (visible in devtools console) before doing anything else — this is the kind of crypto bug that wants a minimal repro.

### typage WASM fails to load

if the plugin throws during `Encrypter.encrypt` with something WASM-related, this is the v0.1 risk we explicitly tested for. capture the stack trace and we'll pivot — likely options include preloading the WASM via a polyfill, swapping to a different age binding, or deferring the plugin until typage releases an electron-friendly build.

## test strategy

`tests/crypto.test.ts` covers:

- the pure helpers (`expandHome`, `readRecipient`, `readIdentity`)
- end-to-end round-trip with a generated keypair
- v0.2 split primitives (`encrypt` + `decryptToString`) including byte-exact large-buffer round-trips and wrong-identity rejection

`tests/sidecar.test.ts` covers the pure sidecar generator:

- frontmatter parsing (quoted/unquoted, CRLF, missing keys, no-frontmatter files)
- `stripFrontmatter` / `shapeStats` / `formatShape` — the structural-stats line that replaced the old themes-heuristic (intentionally content-free so sidecars don't leak a preview of sealed text)
- wikilink extraction (dedupe + sort, aliased forms, empty case)
- full sidecar shape — matches seal.sh's generate_meta output

tests run in pure node — they don't need Obsidian to execute. that means CI is straightforward later.

Obsidian-side integration (active-file selection, vault.createBinary / create / delete, metadataCache.frontmatter.privacy checks, view mount/unmount) is covered by manual smoke in a dev vault. larger integration tests (CM6 mount, dirty tracking, autosave race conditions) enter at v0.3.1+ when the editor view exists.

## next milestones

- **v0.3.1** — swap `AgeFileView`'s `<pre>` body for a CodeMirror 6 editor with markdown syntax highlighting (still read-only). needs an esbuild config with `@codemirror/*` + `@lezer/*` as externals so we reuse Obsidian's bundled CM6 at runtime rather than duplicating it.
- **v0.3.2** — make the CM6 editor editable, wire cmd-S + 30s encrypted autosave, dirty-state tab title, re-encrypt + round-trip verify on every save. sidecar shape stats update on save.
- **v0.4+** — see [vault_plugin_v0_plan.md](../knowledge/projects/vault_plugin_v0_plan.md) for classified tier, multi-recipient management, and mobile story.
