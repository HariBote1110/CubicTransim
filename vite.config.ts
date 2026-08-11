import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Electron の本番ウィンドウは file:// で dist/index.html を読むため、
  // 絶対パス(/assets/...)ではなく相対パスで出力する必要がある。
  base: './',
  plugins: [react()],
})
