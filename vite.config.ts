import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const webPort=Number(process.env.WEB_PORT??4310),apiPort=Number(process.env.API_PORT??4311);
export default defineConfig({
  root: 'apps/web', plugins: [react()],
  server: { port: webPort, strictPort: true, proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
