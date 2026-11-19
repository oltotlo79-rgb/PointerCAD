/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { choice, startAssembly } from './aluminumFrameCatalogFlow.js';
import { chooseToolMenuItem, twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * 配置の補助 P-A 寸法で動かす: 箱 2 つ(1 辺 20 mm、配置の X が 0 と 40。1 つ目は最初に置いたので固定)の組立で 2 つ目を選び、
 * 「組む」の「寸法で動かす」で 基準 = 1 つ目・向き X・内側 にすると、今の寸法は 20(すき間 40 − 20。箱の原点の位置に依らない手で解いた値)。
 * 50 を入れて動かすと、開き直した窓の今の寸法が 50 になり、元に戻す 1 回で 20 に戻る。
 * 寸法の欄は、見える名前(単位の mm も同じ label の中)を持つ label の中の input で探す(steelStockCsvFlow.ts と同じ探し方)。
 * 窓の開け方は assemblyTestSupport.ts の chooseToolMenuItem、ファイルの開き方は frameStrokeLineFlow.ts と同じ。
 */
const dialogOf = (page: Page): Locator =>
  page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.dimensionMove.title'), exact: true });
const current = (value: number): string => uiMessage('assembly', 'assembly.dimensionMove.current').replace('{value}', String(value));

/** 2 つ目の部品を選び、寸法で動かすを開いて基準を 1 つ目にし、今の寸法を確かめる。 */
async function openWithReference(page: Page, expected: number): Promise<Locator> {
  await componentRows(page).nth(1).click();
  await chooseToolMenuItem(page, uiMessage('assembly', 'assembly.menu.build'), uiMessage('assembly', 'assembly.tool.dimensionMove'));
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await choice(dialog, 'assembly', 'assembly.dimensionMove.reference').selectOption({ index: 1 });
  await expect(dialog.getByRole('status')).toHaveText(current(expected));
  return dialog;
}

export function registerDimensionMoveTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('P-A 寸法で動かす', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('すき間 20 の箱を 50 に動かすと、今の寸法が 50 になり、元に戻す 1 回で 20 に戻る', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);
      const fixturePath = info.outputPath('two-box-dimension-move.pcada');
      await writeFile(fixturePath, await twoBoxAssemblyFile(40));
      await openSaveFlowFile(page, fixturePath, app);
      await expect(componentRows(page)).toHaveCount(2);

      const dialog = await openWithReference(page, 20);
      // 「寸法」を含む label は「寸法の取り方」(select)にもあるので、input を持つ label だけが当たる。
      await dialog.locator('label').filter({ hasText: uiMessage('assembly', 'assembly.dimensionMove.target') }).locator('input').fill('50');
      await expect(dialog.getByRole('status')).toContainText(uiMessage('assembly', 'assembly.dimensionMove.summary')
        .replace('{delta}', '30').replace('{count}', '1'));
      const moved = await beginRecompute(page);
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.dimensionMove.commit'), exact: true }).click();
      await waitForRecompute(page, moved);
      await expect(dialog).toHaveCount(0);

      const reopened = await openWithReference(page, 50);
      await reopened.getByRole('button', { name: uiMessage('assembly', 'assembly.dimensionMove.cancel'), exact: true }).click();
      await expect(reopened).toHaveCount(0);
      const undo = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
      await waitForRecompute(page, undo);
      const restored = await openWithReference(page, 20);
      await restored.getByRole('button', { name: uiMessage('assembly', 'assembly.dimensionMove.cancel'), exact: true }).click();
      expect(errors).toEqual([]);
    });
  });
}
