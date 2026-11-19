/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { choice, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows, goHome } from './boltedJointTestSupport.js';
import { frameLayout } from './frameStrokeFlow.js';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * 配置の補助 P-C 方眼の幅と数: 設定の一覧の「表示」の節で方眼を固定 20 mm × 20 本にして適用すると、一筆書きで格子点 (20, -40, 0) の
 * 近く (20.3, -39.7, 0) を押した点は、格子点ちょうどになる(吸着が入・「方眼」の種類が入は既定のまま。格子点は画面で約 2 画素の所で、
 * 点の吸着の半径 12 画素の中。箱〔x 0〜60、y は -10〜20 の見込み〕の頂点からは 20 mm 以上離れ、頂点の吸着より遠い)。
 * 自動の方眼のままなら、押した点は格子に乗らない(placementGridSnap の単体で確かめた)。押す手順は frameStrokeLineFlow.ts と同じ。
 */
export function registerGridFixedPlacementTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('P-C 方眼の幅と数', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('方眼を固定 20 mm × 20 本にすると、一筆書きで格子点の近くを押した点が格子点になる', async ({ page }, info: TestInfo) => {
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

      const fixturePath = info.outputPath('two-box-grid-fixed.pcada');
      await writeFile(fixturePath, await twoBoxAssemblyFile(40));
      await openSaveFlowFile(page, fixturePath, app);
      await expect(componentRows(page)).toHaveCount(2);
      await goHome(page);
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      const layout = frameLayout(page, dialog);
      await layout.locator('summary').click();
      await choice(layout, 'catalog', 'catalog.frameLayout.source').selectOption('stroke');
      await clickWorldPointChecked(page, [20.3, -39.7, 0]);
      await expect(layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true }))
        .toHaveValue('20 -40 0');
      expect(errors).toEqual([]);
    });
  });
}
