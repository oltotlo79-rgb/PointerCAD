/// <reference lib="dom" />
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForSettledRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import { popover, popoverInputs, treeRow } from './solidCaptureSupport.js';
import { uiMessage } from './uiMessages.js';

/**
 * 「作ったものの一覧と、やり直し」章の「名前を変える・一時的に消す・消す」の1枚
 * (`packages/help-content/docs/ja/feature-tree.md`)。
 *
 * feature-tree-rename-menu: 箱1の行を右クリックして開いた一覧で、マウスを「名前を変える」に重ねた
 * モデルブラウザ。一覧の項目と開いた時の焦点(最初の使える項目「抑制する」)は、操作の検査
 * `tree-name-search.spec.ts`(FIX-10)と同じ。撮影の後に実際に改名して確定する。
 */
const view = (key: string): string => uiMessage('view', key);
const NEW_NAME = '取付板';

function featureRow(page: Page, name: string): Locator {
  return page.locator('.pcad-tree__row--child').filter({ has: page.getByRole('button', { name, exact: true }) });
}

export async function featureTreeRenameCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 既定の箱を置く(`primitiveCaptureFlow.ts` と同じ置き方)。
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
  await popoverInputs(page).first().press('Enter');
  if (await popover(page).count() > 0) await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, '箱1')).toBeVisible();
  await waitForSettledRecompute(page);

  // 行の右寄り(⋮の手前)を右クリックする。一覧は押した位置に右端をそろえて開く。
  const row = featureRow(page, '箱1');
  const rowBox = await row.boundingBox();
  if (rowBox === null) throw new Error('箱1の行の位置を取得できません。');
  await page.mouse.click(rowBox.x + rowBox.width - 40, rowBox.y + rowBox.height / 2, { button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const item = (key: string): Locator => menu.getByRole('menuitem', { name: view(key), exact: true });
  await expect(item('featureTree.suppress')).toBeFocused();
  for (const key of ['historyNote.edit', 'historyFolder.moveTitle', 'featureTree.delete']) await expect(item(key)).toBeVisible();
  // マウスを「名前を変える」に重ねる。下矢印で焦点を移すとキー操作の説明の吹き出しが下の項目を覆う
  // (1回目の試走 RUN 20261001-202103 で確認)ので、撮影ではマウスで指す。
  await item('featureTree.rename').hover();
  await expect(page.locator('.pcad-keyboard-control-hint')).toHaveCount(0);

  // 一覧がモデルブラウザの区画の中に収まっていること(区画を撮れば一覧も写る)。
  const panel = page.locator('.pcad-panel--left');
  const [panelBox, menuBox] = await Promise.all([panel.boundingBox(), menu.boundingBox()]);
  if (panelBox === null || menuBox === null) throw new Error('モデルブラウザと一覧の位置を取得できません。');
  expect(menuBox.x >= panelBox.x && menuBox.y >= panelBox.y && menuBox.x + menuBox.width <= panelBox.x + panelBox.width
    && menuBox.y + menuBox.height <= panelBox.y + panelBox.height, '一覧がモデルブラウザの区画の中に収まる').toBe(true);
  await captureManualDetail(page, info, {
    name: 'feature-tree-rename-menu', dialog: panel,
    fixture: { feature: '箱1', open: 'context-menu', hovered: view('featureTree.rename') }, script: new URL(import.meta.url),
  });

  // 「名前を変える」を押すとその場の名前欄が開き、Enterで確定する。
  await item('featureTree.rename').click();
  const name = page.getByRole('textbox', { name: view('featureTree.renameLabel'), exact: true });
  await expect(name).toBeFocused();
  await name.fill(NEW_NAME);
  await name.press('Enter');
  await expect(name).toHaveCount(0);
  await expect(treeRow(page, NEW_NAME)).toBeVisible();
  await waitForSettledRecompute(page);
}
