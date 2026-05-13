# LighTrade Desktop Icons

放 macOS / Windows / Linux 三平台 icon。電子-builder 會自動找
`electron/build/icon.{icns,ico,png}`，所以**最終檔案要放到 `electron/build/`**。

## 一鍵產生

把一張 1024x1024 的 LOGO 用 `source.svg` 放在這裡，跑：

```bash
./electron/icons/build-icons.sh
```

腳本會用 `rsvg-convert` 縮 7 個尺寸，並組成：

| 檔案 | 平台 | 工具 |
|---|---|---|
| `icon.png` | Linux + electron-builder fallback | rsvg-convert |
| `icon.ico` | Windows | icotool (`apt install icoutils` / `brew install icoutils`) |
| `icon.icns` | macOS | iconutil (macOS 內建) — **只能在 macOS 上產** |

產完把 `icon.{icns,ico,png}` 搬到 `electron/build/`（不是這裡）給
electron-builder 自動撿。

## 為何不直接放 build/

`electron/build/` 是 electron-builder 預設輸出與 staging 目錄，
icon 原始素材放這裡會跟 build artifact 混在一起。所以原圖留在
`electron/icons/`、產出再複製到 `build/`。

## 還沒做 icon？

不放也能 build，electron-builder 會 fallback 到 Electron 預設 icon
（紫色齒輪）。等 design 出圖再補。
