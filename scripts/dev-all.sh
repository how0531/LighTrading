#!/usr/bin/env bash
# scripts/dev-all.sh — 一鍵起 backend + frontend + electron 三件式開發環境
#
# Usage:
#   bash scripts/dev-all.sh             # 預設：起三件
#   bash scripts/dev-all.sh --no-electron  # 只起 backend + frontend（適合在純瀏覽器試）
#   bash scripts/dev-all.sh --frontend-only  # 只起 frontend（純前端 demo，無報價）
#
# Ctrl-C 會把三個子程序一併收掉。

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT/lightning_trader/backend"
FRONTEND_DIR="$ROOT/lightning_trader/frontend"
ELECTRON_DIR="$ROOT/electron"

MODE="all"
for arg in "$@"; do
  case "$arg" in
    --no-electron)    MODE="no-electron" ;;
    --frontend-only)  MODE="frontend-only" ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

pids=()
cleanup() {
  echo
  echo "[dev-all] shutting down..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

start_backend() {
  echo "[dev-all] starting backend (FastAPI) ..."
  cd "$BACKEND_DIR"
  if [ ! -d ".venv" ] && [ ! -f "requirements_backend.txt.installed" ]; then
    echo "[dev-all] hint: 第一次跑請先 pip install -r requirements_backend.txt"
  fi
  python3 main.py &
  pids+=($!)
  cd - >/dev/null
}

start_frontend() {
  echo "[dev-all] starting frontend (Vite) ..."
  cd "$FRONTEND_DIR"
  if [ ! -d "node_modules" ]; then
    echo "[dev-all] node_modules 不存在，跑 npm install ..."
    npm install
  fi
  npm run dev &
  pids+=($!)
  cd - >/dev/null
}

start_electron() {
  echo "[dev-all] starting electron shell ..."
  cd "$ELECTRON_DIR"
  if [ ! -d "node_modules" ]; then
    echo "[dev-all] electron/node_modules 不存在，跑 npm install ..."
    npm install
  fi
  # Wait briefly for Vite to bind 5173 before launching Electron
  sleep 3
  npm run dev &
  pids+=($!)
  cd - >/dev/null
}

case "$MODE" in
  all)
    start_backend
    start_frontend
    start_electron
    ;;
  no-electron)
    start_backend
    start_frontend
    ;;
  frontend-only)
    start_frontend
    ;;
esac

echo
echo "[dev-all] all services launched. Logs interleave below."
echo "[dev-all] frontend: http://localhost:5173"
echo "[dev-all] backend : http://localhost:8000  (Swagger: /docs)"
echo "[dev-all] press Ctrl-C to stop everything."
echo

wait
