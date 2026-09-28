/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { placeBox } from './appearanceCaptureSupport.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { popover, popoverTitle } from './solidCaptureSupport.js';

/**
 * 「平面で切る」章の1枚(`packages/help-content/docs/ja/cut.md`)。箱を1つ置いて選んだまま
 * 「切断」を押す(何も選んでいないので、いまの作図面XYで切る。`e2e/tests/p5-cut-mirror.spec.ts`
 * 「立体を選んで「切断」を押すと、作図面で切れて体積が半分になる(FR-432、NFR-UX-4)」と同じ)。
 *
 * 1) cut-plane: 「切断」を押した直後、「切る面」の入力欄が出た状態(§手順・§切る面の決め方)。
 */
export async function cutCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeBox(page);

  await openToolMenu(page, '加工');
  const machining = toolMenuPanel(page, '加工');
  await machining.getByRole('button', { name: '切断', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('切る面');
  await captureManualDetail(page, info, {
    name: 'cut-plane', dialog: popover(page),
    fixture: { shape: '箱1', plane: 'sketchPlane' }, script: new URL(import.meta.url),
  });
}
