/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { choice, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { componentRows } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * E-10 パネルと扉(第 2 段): 線に沿って 600 × 400 の枠(閉じる・突き当て)を置き、木で 4 本を選んで「選んだ枠に扉を付ける」と、隙間 2・
 * パネル用のフレームの最初の行・ヒンジの最初の行・板の最初の行で、扉の外形 576 × 376(内側 580 × 380 から両側 2。手で解いた値)を予告し、
 * 扉の枠 4 本・板 1 枚・ヒンジ 2 つの 7 個を 1 回で置き、元に戻す 1 回で 4 本に戻る。
 */
function detailsOf(page: Page, dialog: Locator, key: string): Locator {
  return dialog.locator('details').filter({ has: page.locator('summary', { hasText: uiMessagePattern('catalog', key) }) });
}

export function registerFrameDoorTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-10 扉', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('600 × 400 の枠の 4 本に扉を付けると、外形 576 × 376 を予告して 7 個を 1 回で置き、元に戻す 1 回で戻る', async ({ page }) => {
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
      let token = await beginRecompute(page);
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(4);

      await componentRows(page).nth(0).click();
      for (const index of [1, 2, 3]) await componentRows(page).nth(index).click({ modifiers: ['Shift'] });
      const door = detailsOf(page, dialog, 'catalog.frameDoor.title');
      await door.locator('summary').click();
      for (const key of ['catalog.frameDoor.board', 'catalog.frameDoor.frame', 'catalog.frameDoor.hinge']) {
        const rows = choice(door, 'catalog', key);
        await expect(rows.locator('option')).not.toHaveCount(1);
        await rows.selectOption({ index: 1 });
      }
      // パネル用のフレームの最初の行は幅 44 なので、板は外形から両側 44 を引いた 488 × 288(手で解いた値)。
      await expect(door.getByText(uiMessage('catalog', 'catalog.frameDoor.preview').replace('{width}', '576').replace('{height}', '376')
        .replace('{boardWidth}', '488').replace('{boardHeight}', '288'), { exact: true })).toBeVisible();
      token = await beginRecompute(page);
      await door.getByRole('button', { name: uiMessage('catalog', 'catalog.frameDoor.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(door.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.frameDoor.placed').replace('{count}', '7'));
      await expect(componentRows(page)).toHaveCount(11);

      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
      token = await beginRecompute(page);
      await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(4);
      expect(errors).toEqual([]);
    });
  });
}
