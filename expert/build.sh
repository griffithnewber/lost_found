#!/usr/bin/env bash
# 把 expert/lost-found-assistant 打包成 docs/lost-found-assistant.zip
# 用法：bash expert/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/expert/lost-found-assistant"
OUT="$ROOT/docs/lost-found-assistant.zip"

if [ ! -f "$SRC/.codebuddy-plugin/plugin.json" ]; then
  echo "找不到 $SRC/.codebuddy-plugin/plugin.json" >&2
  exit 1
fi

rm -f "$OUT"
cd "$ROOT/expert"
zip -r -q "$OUT" lost-found-assistant \
  -x "*.DS_Store" -x "*__pycache__*" -x "*.git*"

echo "已生成 $OUT"
unzip -l "$OUT"
