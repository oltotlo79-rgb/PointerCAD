import { test, type Page } from '@playwright/test';
import { FIREFOX_GRAPHICS_PREFS } from '../firefoxLaunch.js';
import { saveResponsivenessFlow } from './saveResponsivenessFlow.js';

// 保存の実測(レビュー R06・W05)の Firefox。測る内容と保存先(実OPFS)は save-performance.spec.ts と同じ。
test.use({ browserName: 'firefox', launchOptions: { firefoxUserPrefs: FIREFOX_GRAPHICS_PREFS } });

async function withoutPickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const key of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, key, { configurable: true, value: undefined });
  });
}

test.describe('保存の実測 firefox(実OPFS)', () => {
  for (const mib of [32, 128] as const) for (let repeat = 0; repeat < 3; repeat++) {
    test(`${mib}MiB ${repeat + 1}/3 保存中の100入力・全PIDの追加メモリー・実OPFSの保存と再開`, async ({ page }, info) => {
      await withoutPickers(page); await page.goto('/');
      await saveResponsivenessFlow(page, info, mib, repeat, undefined, { target: 'opfs' });
    });
  }
});
