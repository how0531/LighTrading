import os
from dotenv import load_dotenv

# 載入 .env 檔案
load_dotenv()


def _env(*names: str, default: str = "") -> str:
    """依序找第一個非空的環境變數。

    README / .env.example 用的是 API_KEY / SECRET_KEY / SIMULATION，
    舊版程式讀的是 SHIOAJI_* 前綴 —— 兩者都支援，SHIOAJI_* 優先。
    """
    for n in names:
        v = os.getenv(n)
        if v:
            return v
    return default


class Config:
    # Shioaji API 設定
    API_KEY = _env("SHIOAJI_API_KEY", "API_KEY")
    SECRET_KEY = _env("SHIOAJI_SECRET_KEY", "SECRET_KEY")

    # 憑證設定
    PERSON_ID = _env("SHIOAJI_PERSON_ID", "PERSON_ID")
    CA_PATH = _env("SHIOAJI_CA_PATH", "CA_PATH")
    CA_PASSWD = _env("SHIOAJI_CA_PASSWD", "CA_PASSWD")

    # 預設模擬模式：要送真實單必須在 .env 明確設 SIMULATION=false
    SIMULATION = _env("SHIOAJI_SIMULATION", "SIMULATION", default="true").lower() in ["true", "1", "yes"]

    # UI 預設設定
    DEFAULT_SYMBOL = "5309"
    DEFAULT_QUANTITY = 1
