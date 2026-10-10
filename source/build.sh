#!/bin/bash
# Build the public site:  npm install && npm run build   (output: source/dist)
set -e
cd "$(dirname "$0")"
OUT=${OUT:-dist}
rm -rf "$OUT" && mkdir -p "$OUT/assets"
# one stamp for this build (UTC): in the code, in index.html (?v=) and in version.json,
# so pages left open notice a newer website and reload
export BUILD_STAMP=$(date -u +%Y%m%d%H%M%S)
npx esbuild src/main.tsx --bundle --splitting --format=esm --minify --target=es2020 --jsx=automatic \
  --loader:.jpg=dataurl --define:process.env.NODE_ENV='"production"' --define:__BUILD__="\"$BUILD_STAMP\"" --legal-comments=none \
  --entry-names=[name] --chunk-names=chunk-[hash] --outdir="$OUT/assets"
# app icons and manifest (adding the site to a phone's home screen)
cp -r public/. "$OUT"/
python3 tools/make_index.py "$OUT"
printf '{"build": "%s"}\n' "$BUILD_STAMP" > "$OUT/version.json"
# the published copy of the data (encrypted, like on the "data" branch)
cp ../data.json "$OUT/data.json" 2>/dev/null || true
touch "$OUT/.nojekyll"
echo "Built into source/$OUT - copy its contents to the root of the gh-pages branch."
