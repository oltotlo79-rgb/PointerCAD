import { defineConfig, devices } from '@playwright/test';

const PREVIEW_PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PREVIEW_PORT}`;

export default defineConfig({
  testDir: './tests',
  // 50MB の WASM を読み込むため、通常の Web アプリより長く待つ(この2値は変えない)。
  timeout: 180_000,
  // 個々の expect の上限。カーネル読込み等の長い待ちは spec 側で明示しているため、
  // ここは通常の失敗検出を速くするために短くする(P2 タスク1、P1 の残件)。
  expect: { timeout: 30_000 },
  reporter: [['list']],
  /*
   * 並列で走らせる本数を 2 に固定する(指定が無いと Playwright は「論理コア数 ÷ 2」を選び、
   * この機械(12 コア)では 6 になる)。検査は 1 本ごとに新しいブラウザ文脈を作り、文脈ごとに
   * 50MB の OCCT WASM をコンパイルし直すため、**初回のカーネル読み込みが 1 並列の 17〜30 秒から
   * 6 並列では 55〜80 秒へ延び**、spec 側の待ちの上限(KERNEL_TIMEOUT_MS = 60 秒)を越えて落ちた
   * (push #14 の赤 3 本。docs/報告記録.md 2026-09-06 12:04)。上限 60 秒は緩めない。
   * 2 という数は CI の共有ランナー(2 コア)が選ぶ本数と同じで、手元の結果が CI を予測する。
   */
  workers: 2,
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
