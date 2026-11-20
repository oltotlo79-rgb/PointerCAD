/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test';
import { toolMenuPanel } from './assemblyTestSupport.js';

/*
 * C-03 その場の窓のフォーカスの確かめ(窓ごとに 1 件。置き場所は e2e/tests/dialogFocusSupport.ts)。
 * 開く → 中に焦点 →(tabStops があれば)Tab で確定・取消の釦まで届く → Esc → 窓が閉じ、開いた元へ焦点が戻る。メニューの項目から開く窓の開いた元は、そのメニューを開く釦(印 data-menu-trigger)。
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
  /** Tab で順に届く釦(確定・取消など。効く物だけ)。開いた時の焦点から Tab を押し、窓の中で順に焦点を受ける(C-03 の Tab の順)。 */
  readonly tabStops?: readonly Locator[];
  /** 開いた時は効かない確定の釦など(焦点を受けないので tabStops に入れず、効かない事だけを見る)。 */
  readonly disabledActions?: readonly Locator[];
}

/** Tab を押す上限(窓の中の欄の数より多く。規格部品の窓が最も多い)。 */
const MAX_TAB_STEPS = 60;

/**
 * 開いた時の焦点から Tab を押し、stops の順にどれも焦点を受ける事(途中で窓の外へ出ない)。最後の物の後の Shift+Tab では、
 * 窓の中の前の物へ戻る。正の tabIndex は lint が断るので、順は DOM の順(C-03 の Tab の順)。
 */
async function expectTabReaches(page: Page, dialog: Locator, stops: readonly Locator[]): Promise<void> {
  const inside = (): Promise<boolean> => dialog.evaluate((element) => element.contains(document.activeElement));
  for (const stop of stops) {
    let reached = false;
    for (let step = 0; step < MAX_TAB_STEPS && !reached; step += 1) {
      await page.keyboard.press('Tab');
      expect(await inside(), 'Tab で窓の外へ出ない').toBe(true);
      reached = await stop.evaluate((element) => element === document.activeElement);
    }
    expect(reached, 'Tab で釦へ届く').toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await inside(), 'Shift+Tab で窓の中へ戻る').toBe(true);
  const last = stops.at(-1);
  if (last !== undefined) await expect(last).not.toBeFocused();
}

export async function expectDialogFocusCycle(page: Page, cycle: DialogFocusCycle): Promise<void> {
  await cycle.open();
  await expect(cycle.dialog).toBeVisible();
  if (cycle.initial !== undefined) await expect(cycle.initial).toBeFocused();
  else await expect.poll(() => cycle.dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  for (const action of cycle.disabledActions ?? []) await expect(action).toBeDisabled();
  if (cycle.tabStops !== undefined) await expectTabReaches(page, cycle.dialog, cycle.tabStops);
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
