import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Electron の本番ウィンドウは file:// で dist/index.html を読むため、
  // 絶対パス(/assets/...)ではなく相対パスで出力する必要がある。
  base: './',
  plugins: [react()],
  build: {
    rollupOptions: {
      // 列車外観エディタ(train-editor.html)はゲーム本体とは独立したワンオフツール。
      // 第2エントリとしてビルドに含めるが、src/tools/trainEditor/ は
      // src/components・src/hooks・src/App.tsx を参照しないので本体バンドルへは影響しない。
      input: {
        main: 'index.html',
        trainEditor: 'train-editor.html',
      },
    },
  },
})
