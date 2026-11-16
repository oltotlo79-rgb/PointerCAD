import { expect, test } from '@playwright/test';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';
import { touchDrawingFlow, touchViewFlow } from './touchViewFlow.js';

// 指は CDP の Input.dispatchTouchEvent で送るので chromium だけ(firefox の組の名簿には入れない。Electron は electron-touch-view)。
test.use({ browserName: 'chromium' });

test.beforeEach(async ({ page }) => {
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
});

test('B-08g・B-08h タッチの指: 割当なしは今どおり、2 本指・つまむ・1 本指で視点が動き、軽く触れると点は 1 つ、再読み込みの後も残り既定に戻せる', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await waitForStartupHealth(page, info);
  await touchViewFlow(page, info, async () => { await page.reload(); await waitForStartupHealth(page, info); });
  expect(errors).toEqual([]);
});

test('B-08g タッチの指: 図面で 2 本指の平行移動とつまむが紙を動かす', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await waitForStartupHealth(page, info);
  await touchDrawingFlow(page, info);
  expect(errors).toEqual([]);
});
