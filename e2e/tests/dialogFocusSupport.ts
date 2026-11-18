/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test';
import { toolMenuPanel } from './assemblyTestSupport.js';

/*
 * C-03 その場の窓のフォーカスの確かめ(窓ごとに 1 件。置き場所は e2e/tests/dialogFocusSupport.ts)。
 * 開く → 中に焦点 → Esc → 窓が閉じ、開いた元へ焦点が戻る。メニューの項目から開く窓の開いた元は、そのメニューを開く釦(印 data-menu-trigger)。
 * 窓の側は packages/ui/src/shell/dialogFocus.ts の useDialogFocus を 1 行付ける(C-03 の共通の口。10 回目に入る)。
 */
export interface DialogFocusCycle {
  /** 窓を開く手順(できればキーボードで。chooseToolMenuItemByKeyboard を使う)。 */
  readonly open: () => Promise<void>;
  readonly dialog: Locator;
  /** 閉じた後に焦点が戻る物。 */
  readonly opener: Locator;
  /** 開いた時に焦点が入る物(決まっていなければ、窓の中のどこか)。 */
  readonly initial?: Locator;
}

export async function expectDialogFocusCycle(page: Page, cycle: DialogFocusCycle): Promise<void> {
  await cycle.open();
  await expect(cycle.dialog).toBeVisible();
  if (cycle.initial !== undefined) await expect(cycle.initial).toBeFocused();
  else await expect.poll(() => cycle.dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(cycle.dialog).toHaveCount(0);
  await expect(cycle.opener).toBeFocused();
}

/** 道具の欄のメニューを開く釦(名前が menu で始まる、印 data-menu-trigger のある釦)。 */
export function toolMenuTrigger(page: Page, menu: string): Locator {
  return page.locator('.pcad-toolbar').getByRole('button', { name: new RegExp(`^${menu}`, 'u') })
    .and(page.locator('[data-menu-trigger]')).first();
}

/** 道具の欄のメニューの項目をキーボードで選ぶ(釦に焦点 → Enter → 項目に焦点 → Enter)。 */
export async function chooseToolMenuItemByKeyboard(page: Page, menu: string, item: string): Promise<void> {
  await toolMenuTrigger(page, menu).focus();
  await page.keyboard.press('Enter');
  const button = toolMenuPanel(page, menu).getByRole('button', { name: item, exact: true });
  await button.focus();
  await page.keyboard.press('Enter');
}
