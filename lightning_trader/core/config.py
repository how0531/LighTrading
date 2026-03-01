import os
from dotenv import load_dotenv

# 載入 .env 檔案
load_dotenv()

class Config:
    # Shioaji API 設定
    API_KEY = os.getenv("SHIOAJI_API_KEY", "")
    SECRET_KEY = os.getenv("SHIOAJI_SECRET_KEY", "")
    
    # 憑證設定
    PERSON_ID = os.getenv("SHIOAJI_PERSON_ID", "")
    CA_PATH = os.getenv("SHIOAJI_CA_PATH", "")
    CA_PASSWD = os.getenv("SHIOAJI_CA_PASSWD", "")
    
    # --- 關鍵修正：預設改為 False (正式環境) 以讀取真實部位 ---
    # 若 .env 中沒有設定，則預設為 False
    SIMULATION = os.getenv("SHIOAJI_SIMULATION", "False").lower() in ["true", "1", "yes"]

    # UI 預設設定
    DEFAULT_SYMBOL = "5309"
    DEFAULT_QUANTITY = 1
