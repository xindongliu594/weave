import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'apps/web', plugins: [react()],
  server: { port: 4310, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4311' } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
