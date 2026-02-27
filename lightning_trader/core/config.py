import os
from dotenv import load_dotenv

# 載入 .env 檔案（如果有的話）
load_dotenv()

class Config:
    # Shioaji API 設定
    API_KEY = os.getenv("SHIOAJI_API_KEY", "")
    SECRET_KEY = os.getenv("SHIOAJI_SECRET_KEY", "")
    
    # 憑證設定 (正式環境下單需要)
    PERSON_ID = os.getenv("SHIOAJI_PERSON_ID", "")
    CA_PATH = os.getenv("SHIOAJI_CA_PATH", "")
    CA_PASSWD = os.getenv("SHIOAJI_CA_PASSWD", "")
    
    # 執行模式 (True 代表模擬環境, False 代表正式環境)
    SIMULATION = os.getenv("SHIOAJI_SIMULATION", "True").lower() in ["true", "1", "yes"]

    # UI 預設設定
    DEFAULT_SYMBOL = "FITX"
    DEFAULT_QUANTITY = 1
