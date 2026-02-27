import os
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QLineEdit, 
    QPushButton, QCheckBox, QMessageBox, QFileDialog, QGroupBox
)
from PyQt5.QtCore import Qt
from core.config import Config

class LoginDialog(QDialog):
    def __init__(self, client):
        super().__init__()
        self.client = client
        self.initUI()
        self.load_settings()
        
    def initUI(self):
        self.setWindowTitle("系統登入")
        self.setFixedSize(400, 450)
        self.setWindowModality(Qt.ApplicationModal)
        
        self.setStyleSheet("""
            QDialog { background-color: #0F172A; color: #F8FAFC; }
            QLabel { color: #CBD5E1; font-weight: bold; font-size: 13px; }
            QLineEdit { 
                background-color: #1E293B; color: #F8FAFC; 
                border: 1px solid #334155; padding: 6px; border-radius: 4px; 
            }
            QLineEdit:focus { border: 1px solid #3B82F6; }
            QPushButton { 
                background-color: #3B82F6; color: white; border: none; 
                padding: 8px 16px; border-radius: 4px; font-weight: bold; 
            }
            QPushButton:hover { background-color: #2563EB; }
            QPushButton#btn_login { background-color: #10B981; }
            QPushButton#btn_login:hover { background-color: #059669; }
            QCheckBox { color: #CBD5E1; font-size: 13px; }
            QGroupBox { 
                color: #94A3B8; border: 1px solid #334155; 
                border-radius: 6px; margin-top: 10px; padding-top: 10px;
            }
            QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 3px 0 3px; }
        """)

        layout = QVBoxLayout(self)
        layout.setSpacing(15)

        # 模式選擇
        mode_layout = QHBoxLayout()
        self.cb_simulation = QCheckBox("模擬環境 (Simulation)")
        self.cb_real = QCheckBox("真實環境 (Real)")
        
        self.cb_simulation.setChecked(True)
        self.cb_simulation.toggled.connect(self.on_mode_changed)
        self.cb_real.toggled.connect(lambda: self.cb_simulation.setChecked(not self.cb_real.isChecked()))
        
        mode_layout.addWidget(self.cb_simulation)
        mode_layout.addWidget(self.cb_real)
        layout.addLayout(mode_layout)

        # API 金鑰設定
        api_group = QGroupBox("API 設定")
        api_layout = QVBoxLayout(api_group)
        
        self.input_api_key = QLineEdit()
        self.input_api_key.setEchoMode(QLineEdit.Password)
        api_layout.addWidget(QLabel("API KEY:"))
        api_layout.addWidget(self.input_api_key)

        self.input_secret_key = QLineEdit()
        self.input_secret_key.setEchoMode(QLineEdit.Password)
        api_layout.addWidget(QLabel("SECRET KEY:"))
        api_layout.addWidget(self.input_secret_key)
        layout.addWidget(api_group)

        # 憑證設定
        cert_group = QGroupBox("正式環境憑證")
        cert_layout = QVBoxLayout(cert_group)

        self.input_person_id = QLineEdit()
        cert_layout.addWidget(QLabel("憑證身分證字號:"))
        cert_layout.addWidget(self.input_person_id)

        path_layout = QHBoxLayout()
        self.input_ca_path = QLineEdit()
        self.btn_browse_ca = QPushButton("瀏覽...")
        self.btn_browse_ca.clicked.connect(self.browse_ca_path)
        path_layout.addWidget(self.input_ca_path)
        path_layout.addWidget(self.btn_browse_ca)
        
        cert_layout.addWidget(QLabel("憑證路徑 (.pfx):"))
        cert_layout.addLayout(path_layout)

        self.input_ca_passwd = QLineEdit()
        self.input_ca_passwd.setEchoMode(QLineEdit.Password)
        cert_layout.addWidget(QLabel("憑證密碼:"))
        cert_layout.addWidget(self.input_ca_passwd)
        layout.addWidget(cert_group)

        # 登入按鈕
        self.btn_login = QPushButton("登入")
        self.btn_login.setObjectName("btn_login")
        self.btn_login.clicked.connect(self.handle_login)
        layout.addWidget(self.btn_login)

        # 接收登入狀態
        self.client.signal_login_status.connect(self.on_login_result)

    def on_mode_changed(self):
        self.cb_real.setChecked(not self.cb_simulation.isChecked())

    def browse_ca_path(self):
        path, _ = QFileDialog.getOpenFileName(self, "選擇憑證", "", "PFX Files (*.pfx);;All Files (*)")
        if path:
            self.input_ca_path.setText(path)

    def load_settings(self):
        self.input_api_key.setText(Config.API_KEY)
        self.input_secret_key.setText(Config.SECRET_KEY)
        self.input_person_id.setText(Config.PERSON_ID)
        self.input_ca_path.setText(Config.CA_PATH)
        self.input_ca_passwd.setText(Config.CA_PASSWD)
        
        if Config.SIMULATION:
            self.cb_simulation.setChecked(True)
        else:
            self.cb_real.setChecked(True)

    def save_settings(self):
        Config.API_KEY = self.input_api_key.text().strip()
        Config.SECRET_KEY = self.input_secret_key.text().strip()
        Config.PERSON_ID = self.input_person_id.text().strip()
        Config.CA_PATH = self.input_ca_path.text().strip()
        Config.CA_PASSWD = self.input_ca_passwd.text().strip()
        Config.SIMULATION = self.cb_simulation.isChecked()

        # 寫入 .env 檔案
        env_content = f"""SHIOAJI_API_KEY={Config.API_KEY}
SHIOAJI_SECRET_KEY={Config.SECRET_KEY}
SHIOAJI_PERSON_ID={Config.PERSON_ID}
SHIOAJI_CA_PATH={Config.CA_PATH}
SHIOAJI_CA_PASSWD={Config.CA_PASSWD}
SHIOAJI_SIMULATION={'True' if Config.SIMULATION else 'False'}
"""
        with open(".env", "w", encoding="utf-8") as f:
            f.write(env_content)

    def handle_login(self):
        self.save_settings()
        self.btn_login.setEnabled(False)
        self.btn_login.setText("登入中...")
        
        # 使用儲存的設定重新初始化 client 或直接登入
        # 注意：若切換了 simulation 模式，可能需要重新實例化 API
        if self.client.api.simulation != Config.SIMULATION:
            import shioaji as sj
            self.client.api = sj.Shioaji(simulation=Config.SIMULATION)
            self.client._setup_callbacks()
            
        self.client.login(Config.API_KEY, Config.SECRET_KEY)

    def on_login_result(self, success, msg):
        self.btn_login.setEnabled(True)
        self.btn_login.setText("登入")
        if success:
            QMessageBox.information(self, "成功", "登入成功！")
            self.accept()
        else:
            QMessageBox.critical(self, "錯誤", f"登入失敗: {msg}")

