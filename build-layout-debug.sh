#!/bin/sh
# Test-build ONLY: builds the plugin with the layout diagnostic compiled in.
# Usage: ./build-layout-debug.sh /path/to/output-dir
# Release builds (npm run build) never include it (.esbuildrc.json defines it false).
set -e
OUT="${1:?usage: build-layout-debug.sh OUTPUT_DIR}"
mkdir -p "$OUT"
npx obsidian-plugin build src/main.ts -e esbuild.layout-debug.json -o "$OUT"
cp manifest.json styles.css "$OUT"/
echo "built layout-debug build in $OUT"
