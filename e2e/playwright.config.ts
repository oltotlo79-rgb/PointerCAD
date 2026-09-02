import { defineConfig, devices } from '@playwright/test';

const PREVIEW_PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PREVIEW_PORT}`;

export default defineConfig({
  testDir: './tests',
  // 50MB の WASM を読み込むため、通常の Web アプリより長く待つ。
  timeout: 180_000,
  expect: { timeout: 120_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: BASE_URL,
  },
  webServer: {
    // preview は事前にビルドが必要なため、ビルド→preview の順で実行する。
    // apps/web の preview は COOP/COEP ヘッダーを付ける(vite.config.ts)。
    // --host 127.0.0.1 を明示しないと、この環境の vite preview は IPv6 ループバック(::1)
    // だけに bind し、127.0.0.1 への接続が確立できず webServer の起動待ちがタイムアウトする(実測)。
    command: `pnpm --filter @pointercad/web run build && pnpm --filter @pointercad/web run preview --port ${PREVIEW_PORT} --strictPort --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
