/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { popover, popoverTitle, propertyPanel, treeRow } from './solidCaptureSupport.js';
import { waitForRecompute } from './recompute.js';

/**
 * 「外観」系の撮影の流れ(G3-c: appearance-color・appearance-pattern・appearance-glass)で
 * 共通に使う補助。`e2e/tests/appearance.spec.ts`のP5外観の検査と同じ引き方
 * (role/class、`data-testid`は足さない)をここへ1か所にまとめたもの(`appearance.spec.ts`
 * 自身は変更しない。solidCaptureSupport.tsと同じく、撮影の流れどうしでは複製せず共有する
 * 方針、2026-09-24 統括の決定)。
 */

/** 「作る」の一覧から基本形状の箱を、既定の20×20×20のまま原点へ置く。 */
export async function placeBox(page: Page): Promise<void> {
  await openToolMenu(page, '作る');
  const menu = toolMenuPanel(page, '作る');
  await menu.getByRole('button', { name: '箱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await popover(page).locator('input.pcad-field__input').first().press('Enter');
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, '箱1')).toBeVisible();
  await waitForRecompute(page);
  await treeRow(page, '箱1').click();
}

/**
 * 外観の節の選択肢(材質・柄・樹種)の枠。見出しの語で1つに絞る
 * (質量特性の節にも同じ作りの選択肢「材料」があるので、語を完全一致で見る)。
 */
export function appearanceChoice(page: Page, label: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-choice')
    .filter({ has: page.locator('.pcad-choice__label', { hasText: new RegExp(`^${label}$`) }) });
}

/** いま選ばれている選択肢の読み(引き金に出ている語)。 */
export function appearanceChoiceValue(page: Page, label: string): Locator {
  return appearanceChoice(page, label).locator('.pcad-menu__count');
}

/** 選択肢を開いて1つ選ぶ。 */
export async function chooseAppearance(page: Page, label: string, option: string): Promise<void> {
  const choice = appearanceChoice(page, label);
  await choice.locator('.pcad-menu__trigger').click();
  await choice.getByRole('menuitem', { name: option, exact: true }).click();
  await expect(appearanceChoiceValue(page, label)).toHaveText(option);
}

/**
 * 「柄」の選択肢(なし・エキスパンドメタル・縞鋼板・木目)。「材質」と違い、
 * ドロップダウン(`AppearanceMenu`)ではなく`role="group"`の押しボタンの並び
 * (`.pcad-segmented`)なので`appearanceChoice`とは別に引く。
 */
export function appearancePatternGroup(page: Page): Locator {
  return propertyPanel(page).getByRole('group', { name: '柄', exact: true });
}

/** 「柄」のボタンが押されている(選ばれている)ことを確かめる。 */
export function appearancePatternButton(page: Page, label: string): Locator {
  return appearancePatternGroup(page).getByRole('button', { name: label, exact: true });
}

/** 「外観」の節そのもの(撮影の対象)。 */
export function appearanceSection(page: Page): Locator {
  return propertyPanel(page).locator('.pcad-section')
    .filter({ has: page.getByRole('heading', { name: '外観', exact: true }) });
}
