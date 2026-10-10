import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// スマホ実機でジャイロを試すには HTTPS が必要: `HTTPS=1 npm run dev -- --host`
const https = process.env.HTTPS === '1';

// vercel.json と同じ cross-origin isolation を開発時にも再現する
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins: https ? [basicSsl()] : [],
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { target: 'es2022' },
});
