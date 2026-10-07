import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const SERVER_PORT = Number(process.env.REPO_EXPLORER_PORT ?? 5178);
const WEB_PORT = Number(process.env.REPO_EXPLORER_WEB_PORT ?? 5173);

export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  plugins: [react()],
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
