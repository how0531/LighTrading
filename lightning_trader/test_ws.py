import asyncio
import websockets
import json
import requests
import time
import sys

# 後端設定
API_URL = "http://127.0.0.1:8000"
WS_URL = "ws://127.0.0.1:8000/ws/quotes"

# 從 .env 或直接定義測試用的憑證 (這裡模擬前端傳入)
# 實際上 backend 應該讀取 .env 或接收前端傳來的金鑰
LOGIN_DATA = {
    "api_key": "8HUX8oEN71X7rifZ4NVNymVvY9bTCeGL48isHzLkYbdE",
    "secret_key": "8m5Hf8kaRHe7PBtty9cTXz8iH3LiqEFUd2L3wm4rDf6a",
    "simulation": False
}

async def test_websocket():
    # 1. 先執行登入
    print(f"嘗試登入後端: {API_URL}/api/login ...")
    try:
        response = requests.post(f"{API_URL}/api/login", json=LOGIN_DATA, timeout=10)
        print(f"登入結果: {response.json()}")
        if response.status_code != 200:
            print("登入失敗，終止測試。")
            return
    except Exception as e:
        print(f"連線後端 API 失敗: {e}")
        return

    # 2. 連接 WebSocket
    print(f"連接 WebSocket: {WS_URL} ...")
    try:
        async with websockets.connect(WS_URL) as websocket:
            # 3. 發送訂閱指令
            subscribe_msg = {
                "action": "subscribe",
                "symbol": "2330"
            }
            print(f"發送訂閱指令: {subscribe_msg}")
            await websocket.send(json.dumps(subscribe_msg))

            # 4. 接收訊息
            print("等待報價中 (按 Ctrl+C 結束)...")
            count = 0
            while count < 10: # 接收 10 則報價後結束
                message = await websocket.recv()
                data = json.loads(message)
                print(f"收到訊息: {json.dumps(data, indent=2, ensure_ascii=False)}")
                
                if data.get("type") == "BidAsk":
                    print(">>> 成功收到 BidAsk 報價！")
                    # 如果有收到 BidAsk，可以提早結束或繼續觀察
                
                count += 1
                
    except Exception as e:
        print(f"WebSocket 測試過程發生錯誤: {e}")

if __name__ == "__main__":
    try:
        asyncio.run(test_websocket())
    except KeyboardInterrupt:
        print("\n測試由使用者結束。")
