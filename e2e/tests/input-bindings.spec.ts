import { expect, test } from '@playwright/test';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';
import { inputBindingsCaptureFlow, inputBindingsKeysFlow, inputBindingsLiveFlow, inputBindingsWideTextFlow } from './inputBindingsFlow.js';
import { inputBindingsRadialFlow } from './inputBindingsRadialFlow.js';

test.beforeEach(async ({ page }) => {
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
});
for (const [name, flow] of [
  ['窓を開いたまま3Dを回し、回転の速さ2と閉じる時の確かめ', inputBindingsLiveFlow],
  ['取り込みの枠で左を断り、平行移動へホイールを移す', inputBindingsCaptureFlow],
  ['キーで探し、正面とホーム視点のキーを変えて使う', inputBindingsKeysFlow],
  ['放射メニューの部品の並びを変え、重なりを断り、再読み込みの後も使い、既定に戻す(B-08f)', inputBindingsRadialFlow],
] as const) {
  test(`B-07 操作の割り当ての窓: ${name}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/'); await waitForStartupHealth(page, info);
    await flow(page, info); expect(errors).toEqual([]);
  });
}
test('B-07 操作の割り当ての窓: 字を広げても窓は画面に収まり、操作が窓の中へ届く', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await waitForStartupHealth(page, info);
  await inputBindingsWideTextFlow(page); expect(errors).toEqual([]);
});
