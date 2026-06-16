import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        secure: false,
        configure: (proxy, _options) => {
          // Force proxy to ignore body parsing
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            // Keep the exact content length and avoid body manipulation
            if (req.body) {
              proxyReq.setHeader('Content-Length', Buffer.byteLength(req.body));
            }
          });
        }
      }
    }
  }
})