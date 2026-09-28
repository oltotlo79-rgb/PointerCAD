/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { placeAndSelectBox, propertySection, selectionFilterButton, statusBar } from './measurementCaptureSupport.js';

/**
 * 「選ぶものを絞る・選んだ組に名前を付ける」章の2枚(`packages/help-content/docs/ja/selection.md`)。
 *
 * 1) selection-named-set: 立体を選んで組に名前(「外側」)を付けた直後の、右のプロパティ
 *    「選択セット」の節(§選んだ組に名前を付ける)。
 * 2) selection-filter-off: 画面いちばん下の帯で「面」を切った状態(§選べる種類を絞る)。
 */
export async function selectionCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeAndSelectBox(page);

  // 1) 選択セット: 名前を打って「作る」。
  const sets = propertySection(page, '選択セット');
  await expect(sets).toContainText('覚えた組はまだありません。');
  await sets.getByRole('textbox', { name: '名前', exact: true }).fill('外側');
  await sets.getByRole('button', { name: '作る', exact: true }).click();
  await expect(sets.locator('.pcad-constraint-row')).toHaveCount(1);
  await expect(sets).toContainText('外側');
  await expect(sets).toContainText('1 件');

  await captureManualDetail(page, info, {
    name: 'selection-named-set', dialog: sets,
    fixture: { name: '外側', count: 1 }, script: new URL(import.meta.url),
  });

  // 2) フィルタ: 「面」を切る(切った種類はクリックできなくなる、§選べる種類を絞る)。
  const faceFilter = selectionFilterButton(page, '面');
  await faceFilter.click();
  await expect(faceFilter).toHaveAttribute('aria-pressed', 'false');

  await captureManualDetail(page, info, {
    name: 'selection-filter-off', dialog: statusBar(page),
    fixture: { off: '面' }, script: new URL(import.meta.url),
  });
}
