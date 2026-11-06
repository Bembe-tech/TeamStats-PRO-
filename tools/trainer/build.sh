#!/usr/bin/env bash
# Builds TRAINER.PRO: OpenFront's client at the pinned commit + our patch, without
# OpenFront's proprietary assets, into trainer/play/ (served by trainer.js at /trainer/play/).
# usage: tools/trainer/build.sh [openfront checkout dir]
# Needs git, node and npm. Run it on a computer or in the cloud, then commit trainer/play/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMMIT="$(cat "$HERE/OPENFRONT_COMMIT")"
SRC="${1:-$ROOT/tools/of-trainer}"
OUT="$ROOT/trainer/play"
# Maps of OpenFront's ranked 1v1 (MapPlaylist.get1v1Config). Folder names in resources/maps.
MAPS="australia iceland asia europeclassic"

if [ ! -d "$SRC/.git" ]; then
  git clone --filter=blob:none https://github.com/openfrontio/OpenFrontIO "$SRC"
fi
cd "$SRC"
git fetch --depth 1 origin "$COMMIT" 2>/dev/null || true
git checkout -f "$COMMIT"
git clean -fdq -e node_modules
git apply "$HERE/openfront.patch"
# Proprietary OpenFront assets (logo, font, music) are not licensed for other projects.
rm -rf proprietary && mkdir proprietary
cp -r "$HERE/brand/." resources/
npm ci --ignore-scripts --engine-strict=false --no-audit --no-fund
npx vite build

rm -rf "$OUT" && mkdir -p "$OUT"
cp -r static/. "$OUT/"
# Only the 1v1 maps (all maps are ~600 MB).
for d in "$OUT"/_assets/maps/*/; do
  name="$(basename "$d")"
  case " $MAPS " in *" $name "*) ;; *) rm -rf "$d" ;; esac
done
rm -rf "$OUT/press" "$OUT/ads.txt" "$OUT/robots.txt"
node "$HERE/render-index.cjs" "$SRC" "$OUT" "/trainer/play"
# Self-play training engine (tools/trainer-selfplay/train.cjs runs it on worker threads)
npx esbuild scripts/trainer/SelfPlayGame.ts --bundle --platform=node --format=cjs --target=node18 \
  --outfile="$ROOT/tools/trainer-selfplay/game.cjs" --log-level=warning
du -sh "$OUT"
