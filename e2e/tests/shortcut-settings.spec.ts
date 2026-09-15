import { expect, test } from '@playwright/test';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';
import { shortcutConflictFlow, shortcutSettingsFlow, shortcutToolFlow } from './shortcutSettingsFlow.js';

test.beforeEach(async ({ page }) => {
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
});
for (const [name, flow] of [
  ['割当の適用・保存再開・同じUndo・現在の説明', shortcutSettingsFlow],
  ['重複と予約の拒否・取消・文字と日本語入力の保護', shortcutConflictFlow],
  ['道具と表示と板金を同じ入口で使い、入力のF1と文書を保持', shortcutToolFlow],
] as const) {
  test(`P12-7 キー設定の${name}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/'); await waitForStartupHealth(page, info);
    await flow(page, info); expect(errors).toEqual([]);
  });
}
