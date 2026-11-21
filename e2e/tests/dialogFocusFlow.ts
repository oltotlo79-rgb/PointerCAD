/// <reference lib="dom" />
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { choice, startAssembly } from './aluminumFrameCatalogFlow.js';
import { chooseToolMenuItemByKeyboard, expectDialogFocusCycle, toolMenuTrigger } from './dialogFocusSupport.js';
import { inputBindingsWindow } from './inputBindingsWindowSupport.js';
import { waitForStartupHealth } from './startupHealth.js';
import { uiMessage } from './uiMessages.js';

/*
 * C-03 その場の窓のフォーカス: キーボードだけで、設定の一覧と操作の割り当ての窓を開け閉めする。
 * 1. 歯車に焦点を置いて Enter → 一覧の中に焦点が入る → Esc → 一覧が閉じ、焦点が歯車へ戻る。
 * 2. 一覧の「操作の割り当て」を Enter で開く → 一覧は閉じ、窓の選んでいるタブ(最初は「視点の操作」)に焦点 → Tab で次のタブへ →
 *    Esc → 窓が閉じ、焦点が歯車へ戻る(開く元のボタンは一覧と一緒に消えるので、戻り先は歯車)。
 * 3. 道具の欄の「組む」のメニューの「規格部品」を Enter で選ぶ → 規格部品の窓の最初の欄(分類)に焦点 → Esc → 窓が閉じ、焦点が「組む」の
 *    釦へ戻る(項目はメニューと一緒に消えるので、メニューを開く釦〔印 data-menu-trigger〕へ戻す。どのメニューも同じ形)。
 * 4. 「ファイル」の一覧の「作例を開く」を Enter で選ぶ → 作例の一覧の最初の「開く」に焦点 → Tab で「閉じる」まで届く → Esc → 窓が閉じ、
 *    焦点が一覧の釦へ戻る(J-06b)。
 */
const gear = (page: Page): Locator => page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.settings.open'), exact: true });
const settingsPanel = (page: Page): Locator => page.getByRole('group', { name: uiMessage('view', 'settings.title'), exact: true });

/** 今の焦点が、その箱の中にあるか。 */
async function focusInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((scope) => document.activeElement?.closest(scope) !== null, selector);
}

export function registerDialogFocusTests(test: typeof base): void {
  test.describe('C-03 その場の窓のフォーカス', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('設定の一覧: Enter で開くと中へ焦点が入り、Esc で閉じると歯車へ戻る', async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('/'); await waitForStartupHealth(page, info);
      await gear(page).focus();
      await page.keyboard.press('Enter');
      await expect(settingsPanel(page)).toBeVisible();
      await expect.poll(() => focusInside(page, '.pcad-settings')).toBe(true);
      await page.keyboard.press('Escape');
      await expect(settingsPanel(page)).toHaveCount(0);
      await expect(gear(page)).toBeFocused();
      expect(errors).toEqual([]);
    });

    test('操作の割り当ての窓: 開くと選んでいるタブに焦点、Tab で次のタブ、Esc で閉じると歯車へ戻る', async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('/'); await waitForStartupHealth(page, info);
      await gear(page).focus();
      await page.keyboard.press('Enter');
      const opener = settingsPanel(page).getByRole('button', { name: uiMessage('view', 'settings.inputBindings.open'), exact: true });
      await opener.focus();
      await page.keyboard.press('Enter');
      const bindings = inputBindingsWindow(page);
      await expect(bindings).toBeVisible();
      await expect(settingsPanel(page)).toHaveCount(0);
      const tabs = bindings.getByRole('tab');
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      await expect(tabs.nth(0)).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(tabs.nth(1)).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(bindings).toHaveCount(0);
      await expect(gear(page)).toBeFocused();
      expect(errors).toEqual([]);
    });

    test('規格部品の窓: メニューの項目から開くと最初の欄に焦点、Esc で閉じるとメニューを開く釦へ戻る', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, undefined);
      const build = uiMessage('assembly', 'assembly.menu.build');
      const dialog = page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.standardPart.title'), exact: true });
      // 印のある釦が 1 つ見つかる事も確かめる(toolMenuTrigger は印と名前の両方で探す)。
      await expect(toolMenuTrigger(page, build)).toHaveCount(1);
      await expectDialogFocusCycle(page, {
        open: () => chooseToolMenuItemByKeyboard(page, build, uiMessage('assembly', 'assembly.tool.placeStandardPart')),
        dialog,
        initial: choice(dialog, 'assembly', 'assembly.standardPart.category'),
        opener: toolMenuTrigger(page, build),
        // 確定(置く)と閉じるまで Tab で届く(C-03 の Tab の順)。
        tabStops: [dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.place'), exact: true }),
          dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true })],
      });
      expect(errors).toEqual([]);
    });

    test('作例の一覧: ファイルの一覧の項目から開くと最初の作例の「開く」に焦点、Tab で「閉じる」まで届き、Esc で閉じるとファイルの一覧の釦へ戻る', async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('/'); await waitForStartupHealth(page, info);
      const fileMenu = uiMessage('toolbar', 'toolbar.fileMenu.groupLabel');
      const dialog = page.getByRole('dialog', { name: uiMessage('file', 'examples.title'), exact: true });
      const firstOpen = `${uiMessage('file', 'examples.open')} ${uiMessage('file', 'examples.plateWithHole.name')}`;
      await expectDialogFocusCycle(page, {
        open: () => chooseToolMenuItemByKeyboard(page, fileMenu, uiMessage('file', 'examples.menu')),
        dialog,
        initial: dialog.getByRole('button', { name: firstOpen, exact: true }),
        opener: toolMenuTrigger(page, fileMenu),
        tabStops: [dialog.getByRole('button', { name: uiMessage('file', 'examples.close'), exact: true })],
      });
      expect(errors).toEqual([]);
    });
  });
}
