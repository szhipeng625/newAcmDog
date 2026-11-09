import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['@monaco-editor/react'],
          vendor: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  server: {
    // 固定监听 IPv4：Windows 上 Vite 默认可能只监听 [::1]，
    // 导致 127.0.0.1:5173 打不开、调试器连不上。
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:18081',
        changeOrigin: true,
      },
    },
  },
})
