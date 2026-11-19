/// <reference lib="dom" />
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { readAssemblyStats } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { choice, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

/*
 * A2 付属の組(フレームの端のキャップ): 選ぶ窓で溝幅 6 の 20×20(長さの既定 1000)に「端のキャップ」を選ぶと、予告が「本体 994 mm・キャップ 2 個(厚さ 3 mm)」になり、
 * 置くと本体 994 とキャップ 2 個が入る(全長 = 線の長さ。キャップの厚さ 3 は行の値)。部品表はフレームの行とキャップの行(数 2)。元に戻す 1 回で全部消える。
 * 独立の期待: 1000 − 3 × 2 = 994(手で計算)。名前の長さの付け直しは一括の書き換えと同じ作り方(「…×994:1」)。
 */
function accessorySelect(dialog: Locator): Locator {
  return dialog.getByRole('combobox', { name: uiMessage('assembly', 'assembly.accessory.set'), exact: true });
}

async function placeWithCaps(page: Page): Promise<Locator> {
  const dialog = await openFramePicker(page);
  await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-s6');
  await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
  await expect(accessorySelect(dialog)).toHaveValue('');
  await accessorySelect(dialog).selectOption('frame-end-caps');
  await expect(dialog.getByRole('combobox', { name: uiMessage('assembly', 'assembly.accessory.ends'), exact: true })).toHaveValue('both');
  await expect(dialog.getByRole('combobox', { name: uiMessage('assembly', 'assembly.accessory.reference'), exact: true })).toHaveValue('overall');
  await expect(dialog.getByRole('status').filter({ hasText: '994' })).toHaveText(uiMessage('assembly', 'assembly.accessory.preview')
    .replace('{length}', '994').replace('{name}', '端のキャップ 溝幅 6 20×20').replace('{count}', '2').replace('{thickness}', '3'));
  const token = await beginRecompute(page);
  await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.place'), exact: true }).click();
  await waitForRecompute(page, token);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  return dialog;
}

export function registerFrameEndCapsTests(test: typeof base): void {
  test.describe('A2 付属の組: フレームの端のキャップ', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('端のキャップを選んで置くと本体 994 とキャップ 2 個が入り、部品表にキャップの行(数 2)が出て、元に戻す 1 回で全部消える', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, undefined);
      const dialog = await placeWithCaps(page);
      await expect(componentRows(page)).toHaveCount(3);
      const names = (await readAssemblyStats(page)).components.map(component => component.name);
      expect(names[0]).toContain('×994');
      expect(names.slice(1).every(name => name.startsWith('端のキャップ 溝幅 6 20×20'))).toBe(true);
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();

      await page.getByRole('group', { name: uiMessage('assembly', 'assembly.menu.build') })
        .getByRole('button', { name: uiMessage('assembly', 'assembly.tool.bom'), exact: true }).click();
      const rows = page.locator('.pcad-bom__table tbody tr.pcad-bom__row');
      await expect(rows).toHaveCount(2);
      const headers = await page.locator('.pcad-bom__table thead th').allTextContents();
      const quantity = headers.indexOf(uiMessage('assembly', 'assembly.bom.column.quantity'));
      expect(quantity).toBeGreaterThanOrEqual(0);
      await expect(rows.filter({ hasText: '端のキャップ 溝幅 6 20×20' }).locator('td').nth(quantity)).toHaveText('2');

      const undo = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
      await waitForRecompute(page, undo);
      await expect(componentRows(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}
