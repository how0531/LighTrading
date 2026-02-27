import sys
from PyQt5.QtWidgets import QApplication
from ui.main_window import LightningOrderWindow
from core.shioaji_client import ShioajiClient

def main():
    # 建立 PyQt Application
    app = QApplication(sys.argv)
    
    # 設置應用程式樣式
    app.setStyle('Fusion')
    
    # 初始化 Shioaji Client (後端核心)
    client = ShioajiClient()
    
    # 初始化並顯示主視窗 (前端介面)
    window = LightningOrderWindow(client)
    window.show()
    
    # 自動嘗試登入
    print("嘗試登入 Shioaji API...")
    success = client.login()
    if not success:
        print("警告: 登入失敗，請確認 .env 檔案或是 Config 內有設定正確的 API_KEY 與 SECRET_KEY")
        
    # 如果使用者想預設訂閱 FITX，可以取消註解這行：
    # client.subscribe("FITX")
    
    # 執行事件迴圈
    sys.exit(app.exec_())

if __name__ == '__main__':
    main()
