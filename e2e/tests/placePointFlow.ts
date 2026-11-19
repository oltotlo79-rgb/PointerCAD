/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { choice, startAssembly } from './aluminumFrameCatalogFlow.js';
import { chooseToolMenuItem, readAssemblyStats, twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows, goHome } from './boltedJointTestSupport.js';
import type { WorldPoint } from './homeViewProjection.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * G1 規格部品を 3D の画面で押した所に置く: 設定の一覧で方眼を固定 20 mm × 20 本にし(gridFixedPlacementFlow.ts と同じ手順)、
 * 箱 2 つの組立で規格部品の窓を開く。
 * - 既定の分類(六角ボルト)で「3D で置く所を押す」を押し、格子点 (20, -40, 0) の近く (20.3, -39.7, 0) を押すと、ボルトの原点が (20, -40, 0) に置かれる。
 * - 族の分類(アルミフレーム)へ替えて同じ釦を押し、(60.2, -39.8, 0) を押すと、フレームの原点が (60, -40, 0) に置かれる。
 * 押した点は高さ 0 の水平な面の上で、格子点へ吸い付く(頂点の吸着より遠い。箱は x -10〜10 と 30〜50、y・z は -10〜10)。
 * 置くたびに頼みは閉じ(釦は押していない状態に戻る)、窓は開いたまま。押す前に、その画素の一番上が canvas である事を確かめる。
 */
const pickerOf = (page: Page): Locator =>
  page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.standardPart.title'), exact: true });

/** 「3D で置く所を押す」を押し、ワールドの点を押して置けるまで待ち、置いた部品の位置を返す。 */
async function placeAt(page: Page, dialog: Locator, world: WorldPoint, count: number): Promise<readonly number[] | undefined> {
  const button = dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.placePoint.label'), exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByText(uiMessage('assembly', 'assembly.placePoint.hint'), { exact: true })).toBeVisible();
  const token = await beginRecompute(page);
  await clickWorldPointChecked(page, world);
  await waitForRecompute(page, token);
  await expect(componentRows(page)).toHaveCount(count);
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(dialog).toBeVisible();
  return (await readAssemblyStats(page)).components[count - 1]?.resolved?.position;
}

export function registerPlacePointTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('G1 規格部品を 3D の画面で押した所に置く', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('固定の方眼の上で押すと、ボルトとアルミフレームの原点が格子点に置かれる', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);

      const gear = page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.settings.open'), exact: true });
      await gear.click();
      const form = page.getByRole('form', { name: uiMessage('view', 'settings.grid.title'), exact: true });
      await form.getByRole('combobox', { name: uiMessage('view', 'settings.grid.mode'), exact: true }).selectOption('fixed');
      const fields = form.locator('input');
      await expect(fields).toHaveCount(2);
      await fields.nth(0).fill('20');
      await fields.nth(1).fill('20');
      await form.getByRole('button', { name: uiMessage('view', 'settings.grid.apply'), exact: true }).click();
      await expect(form).toHaveAttribute('data-settings-draft', 'false');
      await gear.click();
      await expect(form).toHaveCount(0);

      const fixturePath = info.outputPath('two-box-place-point.pcada');
      await writeFile(fixturePath, await twoBoxAssemblyFile(40));
      await openSaveFlowFile(page, fixturePath, app);
      await expect(componentRows(page)).toHaveCount(2);
      await goHome(page);

      await chooseToolMenuItem(page, uiMessage('assembly', 'assembly.menu.build'), uiMessage('assembly', 'assembly.tool.placeStandardPart'));
      const dialog = pickerOf(page);
      await expect(dialog).toBeVisible();
      expect(await placeAt(page, dialog, [20.3, -39.7, 0], 3)).toEqual([20, -40, 0]);

      await choice(dialog, 'assembly', 'assembly.standardPart.category').selectOption('aluminumFrame');
      await expect(choice(dialog, 'assembly', 'assembly.standardPart.size')).toBeVisible();
      expect(await placeAt(page, dialog, [60.2, -39.8, 0], 4)).toEqual([60, -40, 0]);
      expect(errors).toEqual([]);
    });
  });
}
