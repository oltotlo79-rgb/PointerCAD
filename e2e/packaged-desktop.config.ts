import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * 配布物そのもの(win-unpacked・NSIS で導入した本体・AppImage を展開した中身)を起動する検査
 * (P13-8・P13-9・P13-10・P13-17)。通常の画面検査(playwright.config.ts)は開発用の Electron に
 * 組み立て済みの main を読ませるため、配布物だけで起きる失敗(同梱の漏れ・パス・字体・WASM・
 * 計算部の読込み)を見つけられない。この設定は組み立ても Web サーバーも持たず、
 * 環境変数で渡された実行ファイルだけを起動する(使い方は packagedDesktop.spec.ts の冒頭)。
 * 実行中の配布物を取り違えないよう1本ずつ動かし、失敗を再試行で成功へ置き換えない。
 */
const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './release',
  testMatch: 'packagedDesktop.spec.ts',
  outputDir: resolve(root, 'test-results', 'packaged-desktop'),
  workers: 1,
  retries: 0,
  // 1回の起動で(a)〜(f)を順に確かめる。初回の計算部の準備(数式は最大225秒)を含むため長めに取る。
  timeout: 900_000,
  expect: { timeout: 30_000 },
  // 項目ごとの結果と所要時間を記録から読めるよう、段(test.step)も表示する。
  reporter: process.env.CI ? [['list', { printSteps: true }], ['github']] : [['list', { printSteps: true }]],
});
