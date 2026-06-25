#!/usr/bin/env bash
# Build migration-enabled QuickJS -> WASM (qjsmig.wasm + qjsmig.mjs).
#
# Pinned: quickjs-ng v0.15.1, emscripten 3.1.74.
# Requires the emscripten toolchain on PATH (emcc). See README.md for emsdk setup
# (note: behind the agent proxy, patch emsdk to download via curl — its urllib
# downloader truncates large files).
#
# Usage:  source /path/to/emsdk/emsdk_env.sh && ./build.sh [path-to-quickjs-src]
set -euo pipefail
cd "$(dirname "$0")"

QJS="${1:-./quickjs}"
if [ ! -f "$QJS/quickjs.c" ]; then
  echo "Fetching quickjs-ng v0.15.1 ..."
  curl -fsSL -o /tmp/qjs.tar.gz "https://codeload.github.com/quickjs-ng/quickjs/tar.gz/refs/tags/v0.15.1"
  tar -xzf /tmp/qjs.tar.gz -C /tmp
  QJS=/tmp/quickjs-0.15.1
fi

command -v emcc >/dev/null || { echo "emcc not found — source emsdk_env.sh first"; exit 1; }

# ASYNCIFY instruments QuickJS so a deep synchronous C call stack can unwind into a
# linear-memory buffer (and rewind later, possibly in another instance). host_suspend
# is the one async import that triggers the unwind from inside db_query.
emcc qjs_migrate.c "$QJS/quickjs.c" "$QJS/dtoa.c" "$QJS/libregexp.c" "$QJS/libunicode.c" \
  -I "$QJS" --js-library raw_lib.js \
  -O2 -sASYNCIFY=1 -sASYNCIFY_IMPORTS='["host_suspend"]' -sASYNCIFY_STACK_SIZE=131072 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sSTACK_SIZE=1048576 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORTED_RUNTIME_METHODS='["wasmExports","stringToUTF8"]' \
  -s 'EXPORTED_FUNCTIONS=["_qjs_init","_qjs_code_buf","_qjs_eval","_qjs_final","_malloc"]' \
  -o qjsmig.mjs

echo "Built qjsmig.wasm ($(stat -c%s qjsmig.wasm) bytes). Run: node demo.mjs"
