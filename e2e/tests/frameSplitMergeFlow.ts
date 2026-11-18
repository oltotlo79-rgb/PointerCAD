/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { choice, expectPreviewLengths, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { readAssemblyStats } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * E-11 分割と統合: 線に沿って長さ 1000 の系列の溝幅 6 20×20 を 1 本置き、選んだ部材を分ける・まとめるの欄で 400 の所で分けると
 * 400 と 600 の 2 本になり、後ろの 1 本の位置は前の 1 本の位置から X の向きに 400 進む(線は X の向き。手で解いた値)。
 * Undo 1 回で 1 本に戻り、やり直した 2 本をまとめると長さ 1000 の 1 本(残るのは前の部品)になる。
 */
function detailsOf(page: Page, dialog: Locator, key: string): Locator {
  return dialog.locator('details').filter({ has: page.locator('summary', { hasText: uiMessagePattern('catalog', key) }) });
}

async function clickAndRecompute(page: Page, target: Locator): Promise<void> {
  const token = await beginRecompute(page);
  await target.click();
  await waitForRecompute(page, token);
}

export function registerFrameSplitMergeTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-11 分割と統合', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('置いた 1000 の部材を 400 で分けると 400 と 600 の 2 本になり、Undo 1 回で戻り、やり直した 2 本をまとめると 1000 の 1 本', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
      const layout = detailsOf(page, dialog, 'catalog.frameLayout.title');
      await layout.locator('summary').click();
      await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true }).fill('0 0 0\n1000 0 0');
      await expectPreviewLengths(layout, ['1000']);
      await clickAndRecompute(page, layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }));
      await expect(componentRows(page)).toHaveCount(1);
      const [placed] = (await readAssemblyStats(page)).components;

      await componentRows(page).nth(0).click();
      const split = detailsOf(page, dialog, 'catalog.memberSplit.title');
      await split.locator('summary').click();
      await expect(split.getByText(uiMessage('catalog', 'catalog.memberSplit.hint').replace('{count}', '1'), { exact: true })).toBeVisible();
      await split.locator('label.pcad-field').filter({
        has: page.locator('.pcad-field__label', { hasText: uiMessagePattern('catalog', 'catalog.memberSplit.distance') }),
      }).locator('input').fill('400');
      await clickAndRecompute(page, split.getByRole('button', { name: uiMessage('catalog', 'catalog.memberSplit.splitAction'), exact: true }));
      await expect(split.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.memberSplit.split')
        .replace('{first}', '400').replace('{second}', '600'));
      await expect(componentRows(page)).toHaveCount(2);
      const [first, second] = (await readAssemblyStats(page)).components;
      expect(first?.id).toBe(placed?.id);
      const start = placed?.resolved?.position ?? [Number.NaN, Number.NaN, Number.NaN];
      const moved = second?.resolved?.position ?? [Number.NaN, Number.NaN, Number.NaN];
      // 0 と -0 の違いを比べないよう、成分ごとに 1e-6 mm まで比べる。
      [start[0] + 400, start[1], start[2]].forEach((value, axis) => { expect(moved[axis]).toBeCloseTo(value, 6); });

      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
      await clickAndRecompute(page, page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }));
      await expect(componentRows(page)).toHaveCount(1);
      await clickAndRecompute(page, page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.redo'), exact: true }));
      await expect(componentRows(page)).toHaveCount(2);

      // 木で 2 本を選び(2 本目は Shift で足す)、まとめる。
      await componentRows(page).nth(0).click();
      await componentRows(page).nth(1).click({ modifiers: ['Shift'] });
      const reopened = await openFramePicker(page);
      await choice(reopened, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      const merge = detailsOf(page, reopened, 'catalog.memberSplit.title');
      await merge.locator('summary').click();
      await clickAndRecompute(page, merge.getByRole('button', { name: uiMessage('catalog', 'catalog.memberSplit.mergeAction'), exact: true }));
      await expect(merge.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.memberSplit.merged').replace('{length}', '1000'));
      await expect(componentRows(page)).toHaveCount(1);
      expect((await readAssemblyStats(page)).components.map(component => component.id)).toEqual([placed?.id]);
      expect(errors).toEqual([]);
    });
  });
}
