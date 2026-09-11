import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { panel, source, writeDraft, savePart, successfulRun } from './scriptsFlow.js';
import { readRecomputeStats } from './recompute.js';

export async function scriptToolsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: '新規', exact: true })).toBeVisible();
  await chooseToolMenuItem(page, '自動作図', '自動作図');
  const generation = (await readRecomputeStats(page)).requestedGeneration;
  const toolbar = page.locator('.pcad-toolbar');
  const before = await toolbar.boundingBox(); if (before === null) throw new Error('no toolbar');
  for (let index = 1; index <= 20; index++) {
    await panel(page).getByRole('combobox', { name: '例を開く', exact: true }).selectOption('read');
    await writeDraft(page, `道具${index}`, `console.log('道具${index}');`);
    await panel(page).getByRole('button', { name: '道具に登録・更新', exact: true }).click();
    await expect(panel(page).locator('.pcad-script__tool')).toHaveCount(index);
  }
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(generation);
  expect((await toolbar.boundingBox())?.height).toBe(before.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const first = panel(page).locator('.pcad-script__tool').filter({ has: page.getByText('道具1', { exact: true }) });
  await first.getByRole('button', { name: '編集', exact: true }).click();
  await writeDraft(page, '名前を変えた道具', "console.log('改名後に実行');");
  await panel(page).getByRole('button', { name: '道具に登録・更新', exact: true }).click();
  await expect(panel(page).locator('.pcad-script__tool')).toHaveCount(20);
  const edited = panel(page).locator('.pcad-script__tool').filter({ hasText: '名前を変えた道具' });
  await edited.getByRole('button', { name: '削除', exact: true }).click();
  await expect(panel(page).locator('.pcad-script__tool')).toHaveCount(19);
  await panel(page).getByRole('button', { name: '削除を取り消す', exact: true }).click();
  await expect(panel(page).locator('.pcad-script__tool')).toHaveCount(20);
  await page.reload(); await expect(page.getByRole('button', { name: '新規', exact: true })).toBeVisible();
  const reloadedGeneration = (await readRecomputeStats(page)).requestedGeneration;
  await chooseToolMenuItem(page, '自動作図', '名前を変えた道具');
  await expect(panel(page)).toContainText('改名後に実行');
  await expect(panel(page)).toContainText('実行が完了しました');
  expect((await readRecomputeStats(page)).requestedGeneration).toBe(reloadedGeneration);
  // A local module is edited, resolved and evaluated by the shipped Worker.
  await panel(page).getByRole('combobox', { name: '例を開く', exact: true }).selectOption('read');
  await panel(page).getByRole('textbox', { name: '処理の名前', exact: true }).fill('モジュールで箱を作る');
  await panel(page).locator('summary').filter({ hasText: /^同梱するモジュール$/u }).click();
  await panel(page).getByRole('textbox', { name: 'モジュール名（例: helpers.js）', exact: true }).fill('helpers.js');
  await panel(page).getByRole('button', { name: 'モジュールを追加', exact: true }).click();
  const helper = panel(page).getByRole('textbox', { name: 'JavaScript helpers.js', exact: true });
  await helper.fill("export function make(){\nthrow new Error('モジュールの2行目');\n}");
  await panel(page).getByRole('combobox', { name: '同梱するモジュール', exact: true }).selectOption('user-script.js');
  await source(page).fill("import {make} from './helpers.js';\nmake();");
  await panel(page).getByRole('button', { name: '実行', exact: true }).first().click();
  await expect(panel(page).getByRole('alert')).toContainText('モジュールの2行目');
  await panel(page).getByRole('button', { name: /エラーの行へ移動 helpers.js:2/u }).click();
  await expect(helper).toBeFocused();
  expect(await helper.evaluate(element => element instanceof HTMLTextAreaElement ? element.value.slice(0, element.selectionStart).split('\n').length : -1)).toBe(2);
  await helper.fill("export function make(){\ncad.solid.box({x:'30',y:'20',z:'5'});\n}");
  await successfulRun(page);
  expect((await savePart(page, info, 'script-module.pcad', app)).solids).toHaveLength(1);
  await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
  await page.screenshot({ path: info.outputPath('script-module-created.png') });
}
