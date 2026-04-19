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

then symlink the plugin into the dev vault (so `npm run dev` rebuilds in place):

```bash
mkdir -p ~/Documents/halfday-rune-devvault/.obsidian/plugins
ln -s ~/halfday/obsidian-rune/halfday-obsidian-rune \
  ~/Documents/halfday-rune-devvault/.obsidian/plugins/halfday-obsidian-rune
```

(the symlink target name must match the plugin id in `manifest.json`.)

### 4. (optional) install hot-reload-plugin

obsidian-plugin-cli's dev mode pairs with [hot-reload-plugin](https://github.com/pjeby/hot-reload). install it once into the dev vault and Obsidian will reload halfday-rune automatically when `main.js` changes on disk.

## daily loop

```bash
# in one terminal
npm run dev          # esbuild watcher; rebuilds main.js on save

# in another terminal (when you want to run unit tests)
npm test             # one-shot
npm run test:watch   # vitest watch mode
```

then in Obsidian: open the command palette (cmd-p), search "Halfday Rune", and run "Test round-trip (X25519)". on success you'll see a Notice like `Halfday Rune: round-trip ok (12ms)`. on failure: a Notice with a one-line error and a stack trace in devtools (`cmd-opt-i`).

## what v0.1 proves

if "Test round-trip (X25519)" returns ok inside Obsidian, three risks are retired:

1. typage's WASM module loads in Obsidian's Electron context
2. the X25519 native path works with real keys (no SSH-recipient fallback needed)
3. `fs`/`os`/`path` access from a plugin works for files outside the vault (i.e. `~/.age/vault.*`)

if any of these fail, see "troubleshooting" below.

## troubleshooting

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
- failure modes (wrong identity, missing key lines)

tests run in pure node — they don't need Obsidian to execute. that means CI is straightforward later.

larger integration tests (custom view mount/unmount, file-write paths) are out of scope for v0.1; they enter at v0.3+ when the editor view exists.

## next milestones

after this round-trip works, see [vault_plugin_v0_plan.md](../knowledge/projects/vault_plugin_v0_plan.md) for v0.2 (encrypt current note → .age) and beyond.
