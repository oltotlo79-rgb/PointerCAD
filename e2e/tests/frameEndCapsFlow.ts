/// <reference lib="dom" />
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { chooseToolMenuItem, readAssemblyStats } from './assemblyTestSupport.js';
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

  /*
   * A4 付属の組(ボルトの座金とナット): 今の 8 分類の窓で六角ボルト M8(長さの既定 30)に「座金とナット」を選ぶと、締め付ける厚さの既定が 17.5 mm、
   * ばね座金を入れると 15.5 mm になる。置くとボルト・平座金 2 枚・ばね座金・六角ナットの 5 個が入り、部品表は 4 行(平座金の数 2)。元に戻す 1 回で全部消える。
   * 独立の期待(手で計算。ねじがナットの外へ 2 ピッチ出る厚さ): 30 − 6.8(ナットの高さ) − 1.6 × 2(平座金の厚さ) − 1.25 × 2(並目のピッチ) = 17.5。
   * ばね座金(厚さ 2)を入れると 17.5 − 2 = 15.5。
   */
  test.describe('A4 付属の組: ボルトの座金とナット', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('六角ボルト M8×30 に座金とナットを選ぶと厚さの既定 17.5(ばね座金ありで 15.5)が出て、置くと 5 個が入り、部品表は 4 行、元に戻す 1 回で全部消える', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, undefined);
      await chooseToolMenuItem(page, uiMessage('assembly', 'assembly.menu.build'), uiMessage('assembly', 'assembly.tool.placeStandardPart'));
      const dialog = page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.standardPart.title'), exact: true });
      await expect(dialog).toBeVisible();
      await choice(dialog, 'assembly', 'assembly.standardPart.category').selectOption('hexBolt');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption({ label: 'M8' });
      await expect(accessorySelect(dialog)).toHaveValue('');
      await accessorySelect(dialog).selectOption('bolt-washer-nut');
      const preview = (key: 'assembly.accessory.previewBolt' | 'assembly.accessory.previewBoltSpring', grip: string): string =>
        uiMessage('assembly', key).replace('{grip}', grip);
      await expect(dialog.getByRole('status').filter({ hasText: '17.5' })).toHaveText(preview('assembly.accessory.previewBolt', '17.5'));
      await dialog.getByRole('checkbox', { name: uiMessage('assembly', 'assembly.accessory.spring'), exact: true }).check();
      await expect(dialog.getByRole('status').filter({ hasText: '15.5' })).toHaveText(preview('assembly.accessory.previewBoltSpring', '15.5'));

      const token = await beginRecompute(page);
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await expect(componentRows(page)).toHaveCount(5);
      const names = (await readAssemblyStats(page)).components.map(component => component.name);
      expect(names.filter(name => name.startsWith('平座金')).length).toBe(2);
      expect(names.filter(name => name.startsWith('ばね座金')).length).toBe(1);
      expect(names.filter(name => name.startsWith('六角ナット')).length).toBe(1);
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();

      await page.getByRole('group', { name: uiMessage('assembly', 'assembly.menu.build') })
        .getByRole('button', { name: uiMessage('assembly', 'assembly.tool.bom'), exact: true }).click();
      const rows = page.locator('.pcad-bom__table tbody tr.pcad-bom__row');
      await expect(rows).toHaveCount(4);
      const headers = await page.locator('.pcad-bom__table thead th').allTextContents();
      const quantity = headers.indexOf(uiMessage('assembly', 'assembly.bom.column.quantity'));
      expect(quantity).toBeGreaterThanOrEqual(0);
      await expect(rows.filter({ hasText: '平座金' }).locator('td').nth(quantity)).toHaveText('2');

      const undo = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
      await waitForRecompute(page, undo);
      await expect(componentRows(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });

  /*
   * A6 付属の組(軸受の C 形止め輪): 今の 8 分類の窓で深溝玉軸受 6204(内径 20・外径 47・幅 14)に「軸用 C 形止め輪」を選ぶと、止め輪の族を読み込んでから
   * 予告が「軸用 C 形止め輪 20 2 個(厚さ 1.2 mm)」になり、置くと軸受と止め輪 2 個の 3 個が入る。部品表は 2 行(止め輪の数 2)。元に戻す 1 回で全部消える。
   * 独立の期待: JIS B 2804 の軸用 C 形止め輪は呼び 20(適用する軸径 20)の厚さ t = 1.2。長さの意味の欄は出さない(軸受は長さを持たない)。
   */
  test.describe('A6 付属の組: 軸受の C 形止め輪', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('深溝玉軸受 6204 に軸用 C 形止め輪を選ぶと 2 個(厚さ 1.2)の予告が出て、置くと 3 個が入り、部品表は 2 行、元に戻す 1 回で全部消える', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, undefined);
      await chooseToolMenuItem(page, uiMessage('assembly', 'assembly.menu.build'), uiMessage('assembly', 'assembly.tool.placeStandardPart'));
      const dialog = page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.standardPart.title'), exact: true });
      await expect(dialog).toBeVisible();
      await choice(dialog, 'assembly', 'assembly.standardPart.category').selectOption('deepGrooveBallBearing');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption({ label: '6204' });
      await expect(accessorySelect(dialog)).toHaveValue('');
      await accessorySelect(dialog).selectOption('bearing-shaft-rings');
      await expect(dialog.getByRole('combobox', { name: uiMessage('assembly', 'assembly.accessory.reference'), exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('status').filter({ hasText: '1.2' })).toHaveText(uiMessage('assembly', 'assembly.accessory.previewNoLength')
        .replace('{name}', '軸用 C 形止め輪 20').replace('{count}', '2').replace('{thickness}', '1.2'));

      const token = await beginRecompute(page);
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await expect(componentRows(page)).toHaveCount(3);
      const names = (await readAssemblyStats(page)).components.map(component => component.name);
      expect(names.filter(name => name.startsWith('軸用 C 形止め輪 20')).length).toBe(2);
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();

      await page.getByRole('group', { name: uiMessage('assembly', 'assembly.menu.build') })
        .getByRole('button', { name: uiMessage('assembly', 'assembly.tool.bom'), exact: true }).click();
      const rows = page.locator('.pcad-bom__table tbody tr.pcad-bom__row');
      await expect(rows).toHaveCount(2);
      const headers = await page.locator('.pcad-bom__table thead th').allTextContents();
      const quantity = headers.indexOf(uiMessage('assembly', 'assembly.bom.column.quantity'));
      expect(quantity).toBeGreaterThanOrEqual(0);
      await expect(rows.filter({ hasText: '軸用 C 形止め輪 20' }).locator('td').nth(quantity)).toHaveText('2');

      const undo = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
      await waitForRecompute(page, undo);
      await expect(componentRows(page)).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}
