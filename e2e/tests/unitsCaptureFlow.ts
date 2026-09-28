/// <reference lib="dom" />
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';

/**
 * 「単位を変える(ミリメートルとインチ)」章の2枚(`packages/help-content/docs/ja/units.md`)。
 *
 * 1) units-status-bar: いちばん下の帯の単位ボタンを押してインチへ切り替えた直後(§切り替えかた)。
 * 2) units-inch-volume: 切り替え後、プロパティの体積がインチの単位で出る(§インチにすると変わるもの)。
 */
export async function unitsCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeBox(page);
  await expect(propertyValue(page, '体積')).toHaveText('8000 mm³');

  // 1) 単位ボタンをインチへ切り替える。
  const unitButton = page.locator('.pcad-statusbar__unit');
  await expect(unitButton).toHaveText('単位: mm');
  await unitButton.click();
  await expect(unitButton).toHaveText('単位: inch');
  await captureManualDetail(page, info, {
    name: 'units-status-bar', dialog: unitButton,
    fixture: { from: 'mm', to: 'inch' }, script: new URL(import.meta.url),
  });

  // 2) プロパティの体積がインチの単位(in³)で出る。
  await expect(propertyValue(page, '体積')).toHaveText('0.488 in³');
  await captureManualDetail(page, info, {
    name: 'units-inch-volume', dialog: propertyPanel(page),
    fixture: { volumeMm3: 8000, unit: 'inch' }, script: new URL(import.meta.url),
  });

  // 後片付け: 既定のmmへ戻す(このあとの検査へ表示単位を持ち越さない)。
  await unitButton.click();
  await expect(unitButton).toHaveText('単位: mm');
}

/* ========================================================================== *
 * 補助(`e2e/tests/exchange.spec.ts` の同名補助と同じ作り。撮影の流れ用に書き写す)
 * ========================================================================== */

const BOX_SIZE_MM = 20;
const BOX_VOLUME = BOX_SIZE_MM ** 3;
const VOLUME_UNIT = 'mm³';

function popover(page: Page): Locator {
  return page.locator('.pcad-popover');
}
function popoverTitle(page: Page): Locator {
  return page.locator('.pcad-popover__title');
}
function popoverInputs(page: Page): Locator {
  return page.locator('.pcad-popover input.pcad-field__input');
}
async function commitPopover(page: Page): Promise<void> {
  await expect(popover(page)).toBeVisible();
  await popoverInputs(page).first().press('Enter');
}
async function cancelPopover(page: Page): Promise<void> {
  if ((await popover(page).count()) === 0) return;
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
}
function featureTree(page: Page): Locator {
  return page.locator('.pcad-panel--left');
}
function treeSection(page: Page, title: string): Locator {
  return featureTree(page).locator('.pcad-tree__sections > li').filter({ hasText: title });
}
function solidRows(page: Page): Locator {
  return treeSection(page, 'ソリッド').locator('.pcad-tree__row--child');
}
async function openSolidSection(page: Page): Promise<void> {
  const header = treeSection(page, 'ソリッド').locator('.pcad-tree__row--section').first();
  await expect(header).toBeVisible();
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
}
function propertyPanel(page: Page): Locator {
  return page.locator('.pcad-panel--right');
}
function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page).locator('dt.pcad-properties__key', { hasText: key }).locator('xpath=following-sibling::dd[1]');
}
async function placeBox(page: Page): Promise<void> {
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await expect(popoverInputs(page).nth(0)).toHaveValue(String(BOX_SIZE_MM));
  await commitPopover(page);
  await cancelPopover(page);
  await openSolidSection(page);
  await solidRows(page).first().click();
  await waitForRecompute(page);
  await expect(propertyValue(page, '体積')).toHaveText(`${String(BOX_VOLUME)} ${VOLUME_UNIT}`);
}
