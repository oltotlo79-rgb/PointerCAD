import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** WASM の並列実行に必要な隔離状態を作る(FR-1003)。配信時は app:// の応答ヘッダーで付ける。 */
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // 資産の場所を相対で書き出す。独自スキーム app:// の下でも正しく解決される。
  base: './',
  plugins: [react()],
  // Emscripten のグルーコードを事前バンドルさせない。Node 専用の分岐が含まれるため。
  optimizeDeps: { exclude: ['opencascade.js'] },
  // 幾何カーネルの Worker は ES モジュールとして出力する。
  // Worker の中で実行時 import() を使うため(packages/kernel/src/occt/loadOcct.browser.ts)。
  worker: { format: 'es' },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'esnext',
    // 50MB の WASM が誤って埋め込まれないよう、資産の埋め込みを無効にする。
    assetsInlineLimit: 0,
  },
  server: { headers: crossOriginIsolationHeaders },
});
