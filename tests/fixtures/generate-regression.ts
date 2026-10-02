/**
 * Regenerates tests/fixtures/regression/. Run with:
 *   npx vite-node tests/fixtures/generate-regression.ts
 *
 * The committed files are the source of truth: regenerating produces
 * DIFFERENT ciphertext (age uses a fresh file key every time) and a NEW
 * throwaway identity, so only do it when the fixtures must change. Never
 * put a real identity here.
 */
import * as fs from "fs";
import * as path from "path";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { encrypt } from "../../src/crypto";

const dir = path.join(__dirname, "regression");

const unicode =
  "emoji 🌿🔐👩‍👩‍👧 / combining é ä ñ / CJK 日本語のテキスト 漢字 한국어\n";
// ~10 KB of deterministic text
const tenKb = Array.from(
  { length: 150 },
  (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog 0123456789`
).join("\n");

async function main() {
  fs.mkdirSync(dir, { recursive: true });
  const id1 = await generateIdentity();
  const id2 = await generateIdentity();
  const r1 = await identityToRecipient(id1);
  const r2 = await identityToRecipient(id2);

  fs.writeFileSync(path.join(dir, "test.identity"), `${id1}\n`);
  fs.writeFileSync(path.join(dir, "second.identity"), `${id2}\n`);
  const cases: Record<string, [string[], string]> = {
    "empty.age": [[r1], ""],
    "unicode.age": [[r1], unicode],
    "10kb.age": [[r1], tenKb],
    "two-recipients.age": [[r1, r2], "encrypted to two recipients\n"],
  };
  for (const [name, [recips, text]] of Object.entries(cases)) {
    fs.writeFileSync(path.join(dir, name), await encrypt(recips, text));
  }
}
main();
