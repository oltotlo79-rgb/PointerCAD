/// <reference lib="dom" />
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { popover, popoverTitle } from './solidCaptureSupport.js';
import { placeAndSelectBox } from './measurementCaptureSupport.js';

/** 「断面表示」の入切ボタン(`p6-view.spec.ts` の同名補助と同じ)。 */
function sectionViewButton(page: Page): Locator {
  return page.locator('.pcad-toolbar').getByRole('button', { name: '断面表示', exact: true });
}

/**
 * 「切って中を見る」章の1枚(`packages/help-content/docs/ja/section-view.md`)。
 *
 * section-view-offset: 「断面表示」を入れた直後に浮かぶ、切る位置・裏返す・やめるの欄
 * (§切る位置を動かす)。
 */
export async function sectionViewCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeAndSelectBox(page);

  await sectionViewButton(page).click();
  await expect(sectionViewButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(popoverTitle(page)).toHaveText('断面表示');
  await expect(popover(page).getByRole('textbox', { name: '切る位置', exact: true })).toHaveValue('0');

  await captureManualDetail(page, info, {
    name: 'section-view-offset', dialog: popover(page),
    fixture: { plane: 'XY', offsetMm: 0 }, script: new URL(import.meta.url),
  });
}
