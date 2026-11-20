import { expect, test } from '@playwright/test';
import { disableFilePickers } from './filePickers.js';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';
import { leftEmptyOrbitFlow, settingsFileRoundTripFlow, snapPauseFlow } from './viewControlsStage3Flow.js';

// 操作の割り当ての第 3 段(設計 B-09 3-6)。キーボード・入力・ドラッグの検査なので firefox の project でも流す。
test.beforeEach(async ({ page }) => {
  await installStartupDiagnostics(page);
  await disableFilePickers(page);
});

test('B-09 第 3 段: 設定のファイルを書き出して読み込み、下書きの間は断り、置き換えと元に戻すを使う', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await waitForStartupHealth(page, info);
  await settingsFileRoundTripFlow(page, info); expect(errors).toEqual([]);
});

test('B-09 第 3 段: 吸着を一時止めるキーを Shift にすると、押している間だけ向きの吸着が止まる', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await waitForStartupHealth(page, info);
  await snapPauseFlow(page); expect(errors).toEqual([]);
});

test('B-09 第 3 段: 何も無い所からの左ドラッグで回すを入れた時だけ、左ドラッグで視点が回る', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await waitForStartupHealth(page, info);
  await leftEmptyOrbitFlow(page, info); expect(errors).toEqual([]);
});
