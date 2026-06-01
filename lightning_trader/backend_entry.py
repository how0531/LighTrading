"""
Backend entry point for Electron / PyInstaller packaging.
Runs FastAPI + uvicorn without blocking Qt event loop.
"""
import sys
import os

# PyInstaller 執行時修正路徑
if getattr(sys, 'frozen', False):
    _base = sys._MEIPASS
    sys.path.insert(0, _base)
    os.chdir(_base)

import uvicorn

# 確保 lightning_trader/ 在 path 內（backend.main 需要 import core）
_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)

from backend.main import app  # QCoreApplication 在 backend.main 內部建立

if __name__ == '__main__':
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
