import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the web app (port 5173) forwards /api calls to the backend (port 4000),
// so the browser only ever talks to one address and cookies just work.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: false } },
  },
});
