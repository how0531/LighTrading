# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for LighTrade Backend

import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# 包含 .env（如果存在）
extra_datas = []
if os.path.exists('.env'):
    extra_datas.append(('.env', '.'))

# ── Cython / cffi 套件必須 collect_all，否則 .pyd / .so 不會被複製 ──
# PyNaCl 1.6.x 的 C 擴充是 nacl/_sodium.pyd（cffi），PyInstaller 的靜態分析抓不到
# shioaji 的 solace backend 是 Cython .pyx，會 import pyrsca / pysolace / nacl
nacl_datas,      nacl_binaries,      nacl_hidden      = collect_all('nacl')
shioaji_datas,   shioaji_binaries,   shioaji_hidden   = collect_all('shioaji')
cffi_datas,      cffi_binaries,      cffi_hidden      = collect_all('cffi')
pyrsca_datas,    pyrsca_binaries,    pyrsca_hidden    = collect_all('pyrsca')
pysolace_datas,  pysolace_binaries,  pysolace_hidden  = collect_all('pysolace')
msgpack_datas,   msgpack_binaries,   msgpack_hidden   = collect_all('msgpack')

a = Analysis(
    ['backend_entry.py'],
    pathex=['.'],
    binaries=nacl_binaries + shioaji_binaries + cffi_binaries
             + pyrsca_binaries + pysolace_binaries + msgpack_binaries,
    datas=extra_datas + nacl_datas + shioaji_datas + cffi_datas
          + pyrsca_datas + pysolace_datas + msgpack_datas,
    hiddenimports=[
        'uvicorn',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.protocols.websockets.websockets_impl',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'fastapi',
        'fastapi.middleware.cors',
        'pydantic',
        'pydantic.deprecated.class_validators',
        'starlette',
        'starlette.routing',
        'starlette.middleware',
        'starlette.middleware.cors',
        'anyio',
        'anyio.abc',
        'PyQt5',
        'PyQt5.QtCore',
        'PyQt5.QtWidgets',
        # ── Shioaji / NaCl：Cython + cffi，一定要顯式宣告 ──
        'nacl',
        'nacl._sodium',          # ← cffi 產生的 .pyd，實際的 C 擴充
        'nacl.bindings',
        'nacl.public',
        'nacl.signing',
        'nacl.secret',
        'nacl.encoding',
        'nacl.exceptions',
        'nacl.hash',
        'nacl.utils',
        '_cffi_backend',         # ← cffi runtime
        'cffi',
        # ── Shioaji solace backend 的 Cython 依賴 (pip show shioaji → Requires) ──
        'pyrsca',
        'pysolace',
        'msgpack',
        'base58',
        'filelock',
        'importlib_metadata',
        'loguru',
        'requests',
        'requests.adapters',
        'requests.auth',
        'urllib3',
        'charset_normalizer',
        'idna',
        'certifi',
        'sentry_sdk',
        'sentry_sdk.integrations',
        'xxhash',
        'typing_extensions',
        'shioaji',
        'shioaji.constant',
        'shioaji.backend',
        'shioaji.backend.solace',
        'shioaji.backend.solace.api',
        'shioaji.backend.solace.utils',
        'shioaji.stream_data_pb2',
        'google.protobuf',
        'google.protobuf.internal',
        'google.protobuf.pyext._message',
        'dotenv',
        'asyncio',
        'json',
        'logging',
    ] + nacl_hidden + shioaji_hidden + cffi_hidden
      + pyrsca_hidden + pysolace_hidden + msgpack_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='lightrade-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    onefile=True,
)
