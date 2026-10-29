#!/bin/sh
# Copies the on-device engine from a SwiftBRouter checkout (default: the wasm-spike worktree next
# to the projects): brouter.wasm, built and stripped as its web/README.md says. lookups.dat comes
# with the profiles (sync-from-app.sh). The tiles come from R2 (VITE_BROUTER_TILES, set by the Pages
# build); in development SwiftBRouter's web/server.mjs can serve local ones, with
# VITE_BROUTER_TILES=http://localhost:8471/tiles/ npm run dev. ?engine=local switches the engine on.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
engine=${1:-"$here/../../../SwiftBRouter-wasm"}
mkdir -p "$here/public/engine"
cp "$engine/web/brouter.wasm" "$here/public/engine/"
echo "engine copied from $engine"
