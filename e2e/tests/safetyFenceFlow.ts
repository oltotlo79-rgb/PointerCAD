/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { choice, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { componentRows } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * E-12 平面から安全柵(第 1 段): 600 × 400 の囲い(閉じる)・高さ 600・柱の間隔の上限 1000・横の材 100 と 500・パネルの板(注文の寸法の
 * 最初の行)で作ると、区画 4・柱 4・横の材 8・パネル 4 の 16 個が 1 回で置かれ(手で解いた値)、元に戻す 1 回で 0 個に戻る。
 * 窓には、安全の規格への適合は確かめない事の 1 文が出る。
 */
function detailsOf(page: Page, dialog: Locator, key: string): Locator {
  return dialog.locator('details').filter({ has: page.locator('summary', { hasText: uiMessagePattern('catalog', key) }) });
}

function field(page: Page, scope: Locator, key: string): Locator {
  return scope.locator('label.pcad-field').filter({ has: page.locator('.pcad-field__label', { hasText: uiMessagePattern('catalog', key) }) })
    .locator('input, textarea');
}

export function registerSafetyFenceTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-12 平面から安全柵', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('600 × 400 の囲いで柱 4・横の材 8・パネル 4 の 16 個を 1 回で置き、元に戻す 1 回で戻る。規格への適合は確かめない事を出す', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
      const fence = detailsOf(page, dialog, 'catalog.fence.title');
      await fence.locator('summary').click();
      await expect(fence.getByRole('note')).toHaveText(uiMessage('catalog', 'catalog.fence.notice'));
      await field(page, fence, 'catalog.fence.points').fill(['0 0', '600 0', '600 400', '0 400'].join('\n'));
      await field(page, fence, 'catalog.fence.height').fill('600');
      await field(page, fence, 'catalog.fence.railHeights').fill('100, 500');
      const panel = choice(fence, 'catalog', 'catalog.fence.panel');
      await expect(panel.locator('option')).not.toHaveCount(1);
      await panel.selectOption({ index: 1 });
      const token = await beginRecompute(page);
      await fence.getByRole('button', { name: uiMessage('catalog', 'catalog.fence.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(fence.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.fence.placed').replace('{count}', '16'));
      await expect(componentRows(page)).toHaveCount(16);

      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
      const undo = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
      await waitForRecompute(page, undo);
      await expect(componentRows(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}
