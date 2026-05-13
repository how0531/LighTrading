# LighTrade frontend — multi-stage build → nginx static serve
#
# Stage 1: 用 node:20-alpine 跑 `npm ci` + `npm run build`，產出 dist/
# Stage 2: 用 nginx:alpine 服務靜態檔，並 proxy /api 與 /ws 給 backend container

# ── Stage 1: build ─────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# 先 copy package.json + lockfile，提高 cache 命中
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ── Stage 2: serve ─────────────────────────────────
FROM nginx:alpine

# 自帶 nginx 設定（同目錄下的 nginx.conf）
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
# nginx:alpine 預設 CMD 已啟動 daemon-off，這裡不需覆寫
