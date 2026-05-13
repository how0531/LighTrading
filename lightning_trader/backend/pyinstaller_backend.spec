# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec — LighTrade backend single-folder bundle.

Output: dist/lightrade-backend/lightrade-backend(.exe)

Usage:
    pyinstaller --clean --noconfirm pyinstaller_backend.spec

Notes:
- onedir (NOT onefile) — faster startup; electron-builder packs the folder.
- Console mode True — Electron redirects stdio; useful in dev too.
"""

import os
import sys

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# ─── Paths ─────────────────────────────────────────────────
# SPECPATH is provided by PyInstaller at runtime; fall back to CWD.
try:
    spec_dir = os.path.abspath(SPECPATH)  # type: ignore[name-defined]
except NameError:
    spec_dir = os.path.abspath(os.path.dirname(__file__) if "__file__" in globals() else os.getcwd())

# lightning_trader/ root (parent of backend/) — so `core.*` & `backend.*` resolve
project_root = os.path.abspath(os.path.join(spec_dir, ".."))

block_cipher = None

# ─── Hidden imports ───────────────────────────────────────
# uvicorn dynamically loads protocol/loop/lifespan implementations
hiddenimports = []
hiddenimports += collect_submodules("uvicorn")
hiddenimports += [
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
]

# shioaji has many native submodules that PyInstaller cannot statically detect
try:
    hiddenimports += collect_submodules("shioaji")
except Exception:
    # If shioaji not installed at spec-parse time, leave list and let runtime hooks complain
    hiddenimports += ["shioaji", "shioaji.contracts"]

# fastapi / starlette / pydantic edges
hiddenimports += [
    "email.mime.multipart",
    "email.mime.text",
    "email.mime.application",
]

# ─── Data files ───────────────────────────────────────────
datas = []
# Ship the project source for the rare case PyInstaller misses a dynamic import
datas += [
    (os.path.join(project_root, "core"), "core"),
    (os.path.join(project_root, "backend"), "backend"),
]
# shioaji bundles native libs + cert data
try:
    datas += collect_data_files("shioaji", include_py_files=False)
except Exception:
    pass


a = Analysis(
    ["main.py"],
    pathex=[spec_dir, project_root],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # PyQt5：只給 legacy/ 用，server 不需要（剝掉約 80MB）
        "PyQt5",
        "PyQt5.QtCore",
        "PyQt5.QtGui",
        "PyQt5.QtWidgets",
        # 開發/測試工具
        "pytest",
        "_pytest",
        # 常見 bloat：若 shioaji / fastapi 傳遞依賴沒主動引入這些就剝掉
        "tkinter",
        "tkinter.ttk",
        "IPython",
        "ipykernel",
        "jupyter",
        "notebook",
        "matplotlib",
        "scipy",
        "PIL",          # Pillow，後端純 JSON/binary tick 不需要影像處理
        "pandas.tests",
        "numpy.tests",
        "test",
        "tests",
        "unittest",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="lightrade-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="lightrade-backend",
)
