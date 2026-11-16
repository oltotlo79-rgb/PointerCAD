import { expect, type Page } from '@playwright/test';
import { uiMessage } from './uiMessages.js';

/*
 * 操作の割り当ての窓(B-06。設定の「操作の割り当て…」から開く動かせる窓)を開く・閉じる補助。
 * 視点の操作の割当(view)・キーの割当(keys)・マウスのボタン(mouse、B-08e)・放射メニュー(radial、B-08f)の form は
 * この窓のタブの中にある。設定の一覧は「操作の割り当て…」を押すと閉じる。
 */

export const inputBindingsWindow = (page: Page) =>
  page.getByRole('dialog', { name: uiMessage('view', 'settings.inputBindings.title'), exact: true });

/** 窓を開き、tab のタブを選ぶ。開いていれば窓だけを使う。 */
export async function openInputBindings(page: Page, tab: 'view' | 'keys' | 'mouse' | 'radial'): Promise<void> {
  if (!await inputBindingsWindow(page).isVisible()) {
    const opener = page.getByRole('button', { name: uiMessage('view', 'settings.inputBindings.open'), exact: true });
    if (!await opener.isVisible()) await page.getByRole('button', { name: '設定', exact: true }).click();
    await opener.click();
    await expect(inputBindingsWindow(page)).toBeVisible();
  }
  await inputBindingsWindow(page).getByRole('tab', { name: uiMessage('view', `settings.inputBindings.tab.${tab}`), exact: true }).click();
}

/** 窓を閉じる(下書きがあれば窓の中の確かめが出て閉じない。呼び手は適用か取消の後に呼ぶ)。 */
export async function closeInputBindings(page: Page): Promise<void> {
  await inputBindingsWindow(page).getByRole('button', { name: uiMessage('view', 'settings.inputBindings.close'), exact: true }).click();
  await expect(inputBindingsWindow(page)).toHaveCount(0);
}
