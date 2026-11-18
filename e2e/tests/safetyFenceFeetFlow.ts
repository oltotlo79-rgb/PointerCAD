/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { choice, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { componentRows } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * E-12 平面から安全柵(第 2 段): 600 × 400 の囲い(閉じる)・高さ 600・横の材 100 と 500・パネル無しに、足の板(最初の行)を付けると、
 * 柱 4・横の材 8・足 4 の 16 個が 1 回で置かれる(手で解いた値)。置いた後、表示が新しくなると、柵の部材の接続のうち留めていない数
 * (24 件: 横の材の端の T 16 と、角で横の材どうしが接する L 8。板もナットも付けていない)が窓に出る。
 */
function detailsOf(page: Page, dialog: Locator, key: string): Locator {
  return dialog.locator('details').filter({ has: page.locator('summary', { hasText: uiMessagePattern('catalog', key) }) });
}

function field(page: Page, scope: Locator, key: string): Locator {
  return scope.locator('label.pcad-field').filter({ has: page.locator('.pcad-field__label', { hasText: uiMessagePattern('catalog', key) }) })
    .locator('input, textarea');
}

export function registerSafetyFenceFeetTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-12 安全柵の足と接合チェックの数', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('足の板を付けると柱 4・横の材 8・足 4 の 16 個を置き、置いた後に留めていない接続 24 件を出す', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
      const fence = detailsOf(page, dialog, 'catalog.fence.title');
      await fence.locator('summary').click();
      await field(page, fence, 'catalog.fence.points').fill(['0 0', '600 0', '600 400', '0 400'].join('\n'));
      await field(page, fence, 'catalog.fence.height').fill('600');
      await field(page, fence, 'catalog.fence.railHeights').fill('100, 500');
      await choice(fence, 'catalog', 'catalog.fence.foot').selectOption('base');
      const footRow = choice(fence, 'catalog', 'catalog.fence.footRow');
      await expect(footRow.locator('option')).not.toHaveCount(1);
      await footRow.selectOption({ index: 1 });
      const token = await beginRecompute(page);
      await fence.getByRole('button', { name: uiMessage('catalog', 'catalog.fence.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(fence.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.fence.placed').replace('{count}', '16'));
      await expect(componentRows(page)).toHaveCount(16);
      // 接続は 24(横の材の端の T 16 と角の L 8。ui の safetyFence.test が接続の見分けの実際の数で確かめた値)。どれも留めていない。
      await expect(fence.getByText(uiMessage('catalog', 'catalog.fence.check').replace('{count}', '24'), { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    });
  });
}
