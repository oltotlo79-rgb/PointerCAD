/// <reference lib="dom" />
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';

/**
 * 「書き出す(ほかのソフトへ渡す)」章の2枚(`packages/help-content/docs/ja/export.md`)。
 *
 * 1) export-panel-step: 開いた直後の既定(STEP・すべての立体・色を含める)。
 * 2) export-panel-stl: STLへ切り替えた状態(§なめらかさ・§色を含める〔STLには付かない断り〕)。
 */
export async function exportCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeBox(page);

  // 1) 既定のまま開いた状態(STEP)。
  await chooseFileMenu(page, '書き出す');
  const panel = exchangePanel(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('radio', { name: 'STEP', exact: true })).toHaveAttribute('aria-checked', 'true');
  await captureManualDetail(page, info, {
    name: 'export-panel-step', dialog: panel,
    fixture: { format: 'STEP', scope: 'all', withColors: true }, script: new URL(import.meta.url),
  });

  // 2) STLへ切り替え。色の欄が消え、「STLには色が付きません。」が出る。
  await panel.getByRole('radio', { name: 'STL', exact: true }).click();
  await expect(panel).toContainText('STL には色が付きません。');
  await captureManualDetail(page, info, {
    name: 'export-panel-stl', dialog: panel,
    fixture: { format: 'STL', scope: 'all' }, script: new URL(import.meta.url),
  });

  await panel.getByRole('button', { name: 'やめる', exact: true }).click();
  await expect(panel).toHaveCount(0);
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
function propertyValue(page: Page, key: string): Locator {
  return page.locator('.pcad-panel--right').locator('dt.pcad-properties__key', { hasText: key }).locator('xpath=following-sibling::dd[1]');
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
function exchangePanel(page: Page): Locator {
  return page.locator('.pcad-exchange');
}
async function chooseFileMenu(page: Page, label: string): Promise<void> {
  await openToolMenu(page, 'ファイルのほかの操作');
  await toolMenuPanel(page, 'ファイルのほかの操作').getByRole('button', { name: label, exact: true }).click();
}
