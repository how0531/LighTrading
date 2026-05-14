#!/usr/bin/env bash
#
# build-icons.sh — 從一份 source.svg 產出 electron-builder 需要的三份 icon。
#
# 依賴：
#   - rsvg-convert  (brew install librsvg / apt install librsvg2-bin)
#   - iconutil      (macOS 內建；產出 .icns 必要)
#   - icotool       (apt install icoutils / brew install icoutils；產出 .ico)
#
# 用法：
#   1. 把 LOGO 放這裡：electron/icons/source.svg
#   2. ./electron/icons/build-icons.sh
#   3. 產出：icon.png / icon.ico / icon.icns
#
# 沒安裝 iconutil 或 icotool 也 OK，腳本會跳過該格式並印警告——electron-builder
# 找不到對應格式時會 fallback 到 Electron 預設 icon。

set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f source.svg ]]; then
  echo "❌ 找不到 source.svg。請放一份 1024x1024 的 LOGO svg 在這個目錄。" >&2
  exit 1
fi

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "❌ 缺少 rsvg-convert。macOS: brew install librsvg / Linux: apt install librsvg2-bin" >&2
  exit 1
fi

echo "🎨 產生 PNG sizes ..."
SIZES=(16 32 64 128 256 512 1024)
for s in "${SIZES[@]}"; do
  rsvg-convert -w "$s" -h "$s" source.svg -o "icon-${s}.png"
done
cp icon-1024.png icon.png
echo "  ✅ icon.png (1024x1024)"

# .ico — Windows
if command -v icotool >/dev/null 2>&1; then
  icotool -c -o icon.ico icon-16.png icon-32.png icon-64.png icon-128.png icon-256.png
  echo "  ✅ icon.ico"
else
  echo "  ⚠️  跳過 icon.ico (缺少 icotool)"
fi

# .icns — macOS（只能在 macOS 上產，因為要 iconutil）
if [[ "$(uname)" == "Darwin" ]] && command -v iconutil >/dev/null 2>&1; then
  rm -rf icon.iconset
  mkdir icon.iconset
  cp icon-16.png   icon.iconset/icon_16x16.png
  cp icon-32.png   icon.iconset/icon_16x16@2x.png
  cp icon-32.png   icon.iconset/icon_32x32.png
  cp icon-64.png   icon.iconset/icon_32x32@2x.png
  cp icon-128.png  icon.iconset/icon_128x128.png
  cp icon-256.png  icon.iconset/icon_128x128@2x.png
  cp icon-256.png  icon.iconset/icon_256x256.png
  cp icon-512.png  icon.iconset/icon_256x256@2x.png
  cp icon-512.png  icon.iconset/icon_512x512.png
  cp icon-1024.png icon.iconset/icon_512x512@2x.png
  iconutil -c icns icon.iconset -o icon.icns
  rm -rf icon.iconset
  echo "  ✅ icon.icns"
else
  echo "  ⚠️  跳過 icon.icns (需要 macOS + iconutil)"
fi

# 清理中間檔
rm -f icon-{16,32,64,128,256,512,1024}.png
echo "✨ 完成。可在 electron/package.json 的 build.mac.icon / build.win.icon / build.linux.icon 引用"
