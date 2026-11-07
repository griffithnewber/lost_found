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
if command -v zip >/dev/null 2>&1; then
  zip -r -q "$OUT" lost-found-assistant \
    -x "*.DS_Store" -x "*__pycache__*" -x "*.git*"
else
  # Windows 的 Git Bash 默认没有 zip 命令 —— 用 Python 打同样结构的包
  # （条目前缀 lost-found-assistant/，排除 .DS_Store / __pycache__ / .git*）
  echo "没有 zip 命令，改用 Python 打包" >&2
  python - "$SRC" "$OUT" <<'PY'
import os, sys, zipfile

src, out = sys.argv[1], sys.argv[2]
skip_dirs = {'__pycache__', '.git'}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d not in skip_dirs)
        for name in sorted(files):
            if name == '.DS_Store':
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, os.path.dirname(src))
            z.write(full, rel.replace(os.sep, '/'))
PY
fi

echo "已生成 $OUT"
unzip -l "$OUT" 2>/dev/null || python -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); [print(f'{i.file_size:>8}  {i.filename}') for i in z.infolist()]" "$OUT"
