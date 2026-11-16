import { expect, type Page, type TestInfo } from '@playwright/test';
import { uiMessage } from './uiMessages.js';
import { waitForStartupHealth } from './startupHealth.js';
import { closeInputBindings, inputBindingsWindow, openInputBindings } from './inputBindingsWindowSupport.js';

/*
 * 放射メニューの中身を選ぶ画面検査(設計 2-4、B-08f)。操作の割り当ての窓のタブ「放射メニュー」で部品の 8 つを変え、
 * 右クリックの一覧が選んだ並びで開き、選んだ命令が動き、再読み込みの後も残り、既定に戻せることを、画面の操作だけで確かめる。
 * 期待の並びは製品の既定の表を読まずに、この検査が書いた値(既定の部品の並びは radialMenuFlow が見ている物と同じ)で持つ。
 */
const radial = (key: string) => uiMessage('view', `settings.radial.${key}`);
const form = (page: Page) => inputBindingsWindow(page).getByRole('form', { name: radial('title'), exact: true });
const slotSelect = (page: Page, direction: string) =>
  form(page).getByRole('combobox', { name: radial(`slot.${direction}`), exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true });
const canvas = (page: Page) => page.locator('canvas.pcad-viewport__canvas');

async function openMenu(page: Page): Promise<void> {
  const box = await canvas(page).boundingBox();
  if (box === null) throw new Error('作図画面が表示されていません。');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('menuitem')).toHaveCount(8);
}
/** 一覧の 8 つを、上から時計回りの順に読む。 */
async function shownIds(page: Page): Promise<readonly (string | null)[]> {
  const ids: (string | null)[] = [];
  for (let slot = 0; slot < 8; slot++) {
    ids.push(await menu(page).locator(`[role="menuitem"][data-radial-slot="${slot}"]`).getAttribute('data-command-id'));
  }
  return ids;
}
const DEFAULT_PART = ['toolbar.sketch.select', 'toolbar.sketch.line', 'toolbar.shape.circle', 'toolbar.shape.rectangle',
  'toolbar.solidCreate.extrude', 'toolbar.look.measure', 'toolbar.view.home', 'history.undo'];
// 右(円)をやり直すへ、左上(元に戻す)を円へ。
const CUSTOM_PART = ['toolbar.sketch.select', 'toolbar.sketch.line', 'history.redo', 'toolbar.shape.rectangle',
  'toolbar.solidCreate.extrude', 'toolbar.look.measure', 'toolbar.view.home', 'toolbar.shape.circle'];

export async function inputBindingsRadialFlow(page: Page, info: TestInfo): Promise<void> {
  await openMenu(page);
  expect(await shownIds(page)).toEqual(DEFAULT_PART);
  await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0);

  await openInputBindings(page, 'radial');
  await expect(form(page).getByRole('combobox', { name: radial('kind'), exact: true })).toHaveValue('part');
  const apply = form(page).getByRole('button', { name: radial('apply'), exact: true });
  await expect(apply).toBeDisabled();
  // 同じ命令を 2 か所に置く下書きは、知らせて適用を断る。
  await slotSelect(page, 'upLeft').selectOption('toolbar.shape.circle');
  await expect(form(page).getByRole('alert')).toHaveText(radial('duplicate'));
  await expect(apply).toBeDisabled();
  await slotSelect(page, 'right').selectOption('history.redo');
  await expect(form(page).getByRole('alert')).toHaveCount(0);
  await apply.click();
  await expect(apply).toBeDisabled();
  await closeInputBindings(page);

  await openMenu(page);
  expect(await shownIds(page)).toEqual(CUSTOM_PART);
  // 左上に置いた円が、いつもの円の入力を始める。
  await menu(page).locator('[data-radial-slot="7"]').click();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator('.pcad-popover__title')).toHaveText('円の中心');
  await page.locator('.pcad-popover input').first().press('Escape');

  // 再読み込みの後も選んだ並びが残る。
  await page.reload(); await waitForStartupHealth(page, info);
  await openMenu(page);
  expect(await shownIds(page)).toEqual(CUSTOM_PART);
  await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0);

  // 「この画面を既定に戻す」は下書きに入れるだけで、適用すると既定の並びに戻る。
  await openInputBindings(page, 'radial');
  await form(page).getByRole('button', { name: radial('defaults'), exact: true }).click();
  await expect(slotSelect(page, 'right')).toHaveValue('toolbar.shape.circle');
  await expect(apply).toBeEnabled();
  await apply.click();
  await closeInputBindings(page);
  await openMenu(page);
  expect(await shownIds(page)).toEqual(DEFAULT_PART);
  await page.keyboard.press('Escape');
}
