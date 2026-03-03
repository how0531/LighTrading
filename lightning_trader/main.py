"""
LighTrading — 閃電下單工具主入口

整合 PyQt5 桌面 UI + 核心交易引擎。
"""
import sys
import logging
from PyQt5.QtWidgets import QApplication
from ui.main_window import LightningOrderWindow
from core import create_trading_engine

# 統一日誌格式
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


def main():
    app = QApplication(sys.argv)
    app.setStyle('Fusion')

    # 建立交易引擎 (一行建立所有核心模組)
    engine = create_trading_engine()

    # 初始化主視窗 (傳入整個引擎)
    window = LightningOrderWindow(engine.client)
    window.show()

    # 註冊快捷鍵處理函數
    engine.hotkey_manager.register_handlers({
        "cancel_all":     lambda: engine.client.cancel_all(),
        "flatten_all":    lambda: engine.client.flatten_position(),
        "switch_symbol":  lambda: engine.watchlist_manager.switch_next(),
    })

    # 自動登入
    logger.info("嘗試登入 Shioaji API...")
    success = engine.client.login()
    if success:
        logger.info("登入成功")
    else:
        logger.warning("登入失敗，請確認 .env 或 Config 內的 API_KEY / SECRET_KEY")

    sys.exit(app.exec_())


if __name__ == '__main__':
    main()
