# LighTrade backend — production image
#
# 注意：shioaji 1.3.x 的 wheel 只發布 manylinux x86_64 與 Windows。
# Apple Silicon (arm64) 使用者請改用 `docker buildx --platform linux/amd64`
# 或在主機端 venv 跑（pip install 會走 Rosetta x86_64）。

FROM python:3.11-slim

# 系統依賴：shioaji 需要 libssl/libcrypt 等（slim 已含），多加 curl 給 healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先複製 requirements 提升 layer cache 命中率
COPY lightning_trader/backend/requirements_backend.txt /tmp/requirements.txt

# 過濾掉 pyqt5（headless backend 不需要）後 install
RUN grep -v "pyqt5" /tmp/requirements.txt > /tmp/req-headless.txt \
    && pip install --no-cache-dir -r /tmp/req-headless.txt

# 複製程式碼（會被 .dockerignore 排除測試與 frontend）
COPY lightning_trader/ /app/lightning_trader/

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/lightning_trader

# /api/health 給 docker healthcheck 用
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

WORKDIR /app/lightning_trader/backend
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
