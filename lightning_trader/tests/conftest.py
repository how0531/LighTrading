"""
Pytest 共用設定 — 把 lightning_trader/ 加到 sys.path，
讓所有測試都能直接 `from core ...` / `from backend ...`。
"""
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
