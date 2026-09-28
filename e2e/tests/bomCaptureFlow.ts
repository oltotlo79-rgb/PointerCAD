/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { placeTwoBoxesCapture, startNewAssemblyCapture } from './assemblyCaptureSupport.js';

/**
 * 「部品表を確認する」章の1枚(`packages/help-content/docs/ja/bom.md`)。
 *
 * 1) bom-table: 箱2個を置いたアセンブリで「部品表」を開いた画面(§組み立てに使っている
 *    部品が右側の表に出ます)。
 */
export async function bomCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startNewAssemblyCapture(page);
  await placeTwoBoxesCapture(page);

  await page.getByRole('group', { name: '組む' })
    .getByRole('button', { name: '部品表', exact: true }).click();
  const table = page.locator('.pcad-bom');
  await expect(table.locator('.pcad-bom__table tbody tr')).toHaveCount(1);

  await captureManualDetail(page, info, {
    name: 'bom-table', dialog: table,
    fixture: { componentCount: 2, quantity: 1 }, script: new URL(import.meta.url),
  });
}
