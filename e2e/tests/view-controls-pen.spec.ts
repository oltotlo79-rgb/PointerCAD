import { expect, test } from '@playwright/test';
import { disableFilePickers } from './filePickers.js';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';
import { penBarrelFlow } from './viewControlsStage3Flow.js';

// ペンの入力は Chromium の CDP(Input.dispatchMouseEvent の pointerType 'pen')でしか送れないので、chromium だけ(touch-view と同じ扱い)。
test.beforeEach(async ({ page }) => {
  await installStartupDiagnostics(page);
  await disableFilePickers(page);
});

test('B-09 第 3 段: ペンの側面のボタンは割り当てる前は平行移動、取り込んで回転に足すとそのドラッグで回る', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await waitForStartupHealth(page, info);
  await penBarrelFlow(page, info); expect(errors).toEqual([]);
});
