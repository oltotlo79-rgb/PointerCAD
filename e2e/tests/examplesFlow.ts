import { expect, type Locator, type Page } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { answerDiscardConfirm } from './discardDialogSupport.js';
import { chooseDrawingMenu, waitForDrawingReady } from './drawingManufacturingFixture.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

const file = (key: string): string => uiMessage('file', key);

/** 作成履歴の「ソリッド」の区画の行(ex18RoutesFlow と同じ探し方)。 */
function solidRow(page: Page, name: string): Locator {
  return page.locator('.pcad-tree__sections > li').filter({ hasText: 'ソリッド' })
    .getByRole('button', { name, exact: true });
}

async function chooseExampleFromFileMenu(page: Page, nameKey: string): Promise<void> {
  await chooseToolMenuItem(page, uiMessage('toolbar', 'toolbar.fileMenu.groupLabel'), file('examples.menu'));
  const dialog = page.getByRole('dialog', { name: file('examples.title'), exact: true });
  await dialog.getByRole('button', { name: `${file('examples.open')} ${file(nameKey)}`, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await answerDiscardConfirm(page);
}

/**
 * J-06b 作例の集まり: 空の部品の案内の「作例を開く」を Enter で押し、作例の一覧からフランジを開く。
 * 作成履歴に回転・C 面取り・穴 2 つ・円形パターンが並び、最後の円形パターンを選ぶと体積が手で出した値と合う。
 * 独立の期待: 下の 1 mm は半径 39〜40 の円錐台、残り 19 mm は円柱。中心の穴 φ24 と 4 つのボルト穴 φ8 は 20 mm の貫通。
 * V = π(19·40² + (39² + 39·40 + 40²)/3 − 20·(12² + 4·4²)) mm³。
 */
export async function examplesFlow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const entry = page.locator('.pcad-viewport__empty-state').getByRole('button', { name: file('examples.menu'), exact: true });
  await entry.focus(); await entry.press('Enter');
  const dialog = page.getByRole('dialog', { name: file('examples.title'), exact: true });
  await expect(dialog).toBeVisible();
  const generation = await beginRecompute(page);
  await dialog.getByRole('button', { name: `${file('examples.open')} ${file('examples.flange.name')}`, exact: true }).press('Enter');
  await expect(dialog).toHaveCount(0);
  await waitForRecompute(page, generation);
  for (const name of ['回転1', 'C面取り1', '穴1', '穴2', '円形パターン1']) await expect(solidRow(page, name)).toBeVisible();
  await solidRow(page, '円形パターン1').click();
  const volume = page.locator('.pcad-panel--right dt.pcad-properties__key', { hasText: /^体積$/u })
    .locator('xpath=following-sibling::dd[1]');
  const expected = Math.PI * (19 * 40 ** 2 + (39 ** 2 + 39 * 40 + 40 ** 2) / 3 - 20 * (12 ** 2 + 4 * 4 ** 2));
  await expect.poll(async () => Math.abs(Number.parseFloat(((await volume.getAttribute('title')) ?? (await volume.innerText()))
    .replaceAll(',', '')) - expected)).toBeLessThan(0.01);

  await chooseExampleFromFileMenu(page, 'examples.flangeDrawing.name');
  await expect(page.locator('.pcad-drawing-tree-sheet')).toHaveAttribute('title', file('examples.flangeDrawing.name'));
  for (const view of ['view-1', 'view-2', 'view-3']) {
    await expect(page.locator(`.pcad-drawing-svg [data-owner-id="${view}"] path`).first())
      .toBeAttached({ timeout: KERNEL_TIMEOUT_MS });
  }
  await waitForDrawingReady(page);
  await expect(page.locator('.pcad-drawing-tree-dimension')).toHaveCount(2);
  await expect(page.locator('.pcad-drawing-tree-unresolved')).toHaveCount(0);

  await chooseDrawingMenu(page, uiMessage('toolbar', 'toolbar.file.title'), uiMessage('drawing', 'drawing.file.returnToPart'));
  await answerDiscardConfirm(page);
  await expect(solidRow(page, '円形パターン1')).toBeVisible();
  await chooseExampleFromFileMenu(page, 'examples.boltedPlates.name');
  const tree = page.locator('.pcad-panel--left');
  await expect(tree.getByRole('button', { name: file('examples.boltedPlates.name'), exact: true })).toBeVisible();
  const components = tree.locator('.pcad-tree__section').filter({
    has: page.getByText(uiMessage('assembly', 'assembly.tree.components'), { exact: true }),
  });
  await expect(components.locator('.pcad-tree__count')).toHaveText('6');
}
