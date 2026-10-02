import * as path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `obsidian` has no runtime entry (types only); see tests/stubs/obsidian.ts.
    alias: { obsidian: path.join(__dirname, "tests", "stubs", "obsidian.ts") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
