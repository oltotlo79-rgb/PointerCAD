/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { choice, expectPreviewLengths, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { componentRows } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * E-10 パネルと扉(第 1 段): 線に沿って 600 × 400 の枠(閉じる・突き当て)を系列の溝幅 6 20×20 で置き、木で 4 本を選んで
 * 「選んだ枠にパネルをはめる」と、内側 580 × 380(断面の半分 10 を両側から引いた値。手で解いた値)の板が 1 枚置かれ、元に戻す 1 回で消える。
 */
function detailsOf(page: Page, dialog: Locator, key: string): Locator {
  return dialog.locator('details').filter({ has: page.locator('summary', { hasText: uiMessagePattern('catalog', key) }) });
}

export function registerFramePanelTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-10 パネルと扉', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('600 × 400 の枠の 4 本を選ぶと、内側 580 × 380 の板を予告して 1 枚置き、元に戻す 1 回で消える', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
      const layout = detailsOf(page, dialog, 'catalog.frameLayout.title');
      await layout.locator('summary').click();
      await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true })
        .fill(['0 0 0', '600 0 0', '600 400 0', '0 400 0'].join('\n'));
      await layout.getByRole('checkbox', { name: uiMessage('catalog', 'catalog.frameLayout.closed'), exact: true }).check();
      await expect(layout.locator('tbody tr')).toHaveCount(4);
      await expectPreviewLengths(layout, ['620', '400', '600', '380']);
      let token = await beginRecompute(page);
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(4);

      await componentRows(page).nth(0).click();
      for (const index of [1, 2, 3]) await componentRows(page).nth(index).click({ modifiers: ['Shift'] });
      const panel = detailsOf(page, dialog, 'catalog.framePanel.title');
      await panel.locator('summary').click();
      const rows = choice(panel, 'catalog', 'catalog.framePanel.panel');
      await expect(rows.locator('option')).not.toHaveCount(1);
      await rows.selectOption({ index: 1 });
      await expect(panel.getByText(uiMessage('catalog', 'catalog.framePanel.preview').replace('{width}', '580').replace('{height}', '380'),
        { exact: true })).toBeVisible();
      token = await beginRecompute(page);
      await panel.getByRole('button', { name: uiMessage('catalog', 'catalog.framePanel.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(panel.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.framePanel.placed'));
      await expect(componentRows(page)).toHaveCount(5);

      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
      token = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(4);
      expect(errors).toEqual([]);
    });
  });
}
