import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 開發模式：前端走 5173，後端走 8000，靠 vite 內建 proxy 轉發 /api 與 /ws 給 backend。
// 正式部署（docker / nginx）：nginx 同樣 proxy /api 與 /ws，所以前端碼一套通吃。
// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
