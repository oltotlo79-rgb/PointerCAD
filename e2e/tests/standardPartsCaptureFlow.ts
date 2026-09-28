/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { startNewAssemblyCapture } from './assemblyCaptureSupport.js';

/**
 * 「規格部品を置く」章の1枚(`packages/help-content/docs/ja/standard-parts.md`)。
 *
 * 1) standard-parts-picker: 「組む」→「規格部品」を開き、寸法系を本体規格・呼び寸法をM8へ
 *    切り替えた画面(§種類、呼び寸法、長さを選び、Enterを押すと部品が置かれます)。
 */
export async function standardPartsCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startNewAssemblyCapture(page);

  await chooseToolMenuItem(page, '組む', '規格部品');
  const picker = page.getByRole('dialog', { name: '規格部品を置く' });
  await expect(picker).toBeVisible();
  // p7-standard-parts.spec.tsの(d)と同じ切替え: 本体規格(k=5.3mm)・M8。
  await picker.locator('select').nth(1).selectOption('main');
  await expect(picker.locator('select').nth(1)).toHaveValue('main');
  const size = picker.locator('select').nth(3);
  await size.selectOption({ label: 'M8' });
  await expect(size.locator('option:checked')).toHaveText('M8');

  await captureManualDetail(page, info, {
    name: 'standard-parts-picker', dialog: picker,
    fixture: { category: '六角ボルト', dimensionSeries: 'main', size: 'M8' }, script: new URL(import.meta.url),
  });
  await picker.getByRole('button', { name: '閉じる', exact: true }).click();
}
