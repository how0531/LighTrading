# LighTrade Desktop Icons

Place platform-specific application icons in this directory. electron-builder
will pick them up automatically based on filename conventions.

## Required files

| File           | Platform | Notes                                                    |
| -------------- | -------- | -------------------------------------------------------- |
| `icon.icns`    | macOS    | 1024x1024 ICNS bundle (use `iconutil` or `electron-icon-builder`). |
| `icon.ico`     | Windows  | Multi-resolution ICO (at minimum 256x256).               |
| `icon.png`     | Linux    | 512x512 PNG (electron-builder auto-resizes).             |

## Notes

- Binary icon files are intentionally NOT committed in this commit
  (Sprint 9 Phase B). Design will deliver them later; until then,
  electron-builder will fall back to the default Electron icon.
- Source vector (SVG / Figma export) should also live here for posterity.
- Do not commit anything larger than 2 MB; large binary assets belong in
  Git LFS or an external CDN.
