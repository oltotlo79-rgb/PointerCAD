/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';

/**
 * 「読み込む(ほかのソフトの形を取り込む)」章の2枚(`packages/help-content/docs/ja/import.md`)。
 *
 * 1) import-unit-question: STL(単位を持たない形式)を読み込むときに出る、単位を訊く小窓
 *    (§単位)。
 * 2) import-properties: 読み込んだ形を選んだときのプロパティ(§プロパティで確かめられること)。
 *
 * 見本のSTLは追跡ファイルを増やさず、この場で箱を作って書き出したものを使い回す
 * (`e2e/tests/exchange.spec.ts` の (b) と同じ作り。rules/03 §7.1 #0)。
 */
export async function importCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeBox(page);

  const stlPath = info.outputPath('import-sample.stl');
  await exportStl(page, stlPath);

  // 1) 読み込みを始めると、STLは単位を持たないので単位を訊く小窓が出る。
  const chooser = page.waitForEvent('filechooser');
  await chooseFileMenu(page, '読み込む');
  await page.getByRole('form', { name: '読み込み', exact: true })
    .getByRole('button', { name: 'ファイルを選ぶ', exact: true }).click();
  await (await chooser).setFiles(stlPath);
  const unitPanel = page.locator('.pcad-import-unit');
  await expect(unitPanel).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await captureManualDetail(page, info, {
    name: 'import-unit-question', dialog: unitPanel,
    fixture: { format: 'STL', sourcePath: 'import-sample.stl' }, script: new URL(import.meta.url),
  });

  // 2) ミリメートルを選んで読み込み、読み込んだ形のプロパティを見る。
  await unitPanel.getByRole('button', { name: 'ミリメートル', exact: true }).click();
  await expect(unitPanel).toHaveCount(0);
  await openSolidSection(page);
  await expect(solidRows(page)).toHaveCount(2, { timeout: KERNEL_TIMEOUT_MS });
  await waitForRecompute(page);
  await solidRows(page).nth(1).click();
  await expect(sectionPropertyValue(page, '対象', '三角形の数')).toHaveText('12', { timeout: KERNEL_TIMEOUT_MS });

  const rightPanel = propertyPanel(page);
  await captureManualDetail(page, info, {
    name: 'import-properties', dialog: rightPanel,
    fixture: { format: 'STL', triangles: 12 }, script: new URL(import.meta.url),
  });
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
function sectionPropertyValue(page: Page, section: string, key: string): Locator {
  return propertyPanel(page)
    .locator('.pcad-section')
    .filter({ has: page.locator('.pcad-section__title', { hasText: new RegExp(`^${section}$`) }) })
    .locator('dt.pcad-properties__key', { hasText: new RegExp(`^${key}$`) })
    .locator('xpath=following-sibling::dd[1]');
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
  await expect(propertyValue(page, '体積')).toHaveText(`${String(BOX_VOLUME)} ${VOLUME_UNIT}`, { timeout: KERNEL_TIMEOUT_MS });
}
function exchangePanel(page: Page): Locator {
  return page.locator('.pcad-exchange');
}
async function chooseFileMenu(page: Page, label: string): Promise<void> {
  await openToolMenu(page, 'ファイルのほかの操作');
  await toolMenuPanel(page, 'ファイルのほかの操作').getByRole('button', { name: label, exact: true }).click();
}
/** 箱をSTL(バイナリ)で書き出し、`path` へ保存する(単位を持たない見本を作る)。 */
async function exportStl(page: Page, path: string): Promise<void> {
  await chooseFileMenu(page, '書き出す');
  const panel = exchangePanel(page);
  await expect(panel).toBeVisible();
  await panel.getByRole('radio', { name: 'STL', exact: true }).click();
  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: '書き出す', exact: true }).click();
  await (await download).saveAs(path);
  await expect(panel).toHaveCount(0);
  const bytes = readFileSync(path);
  expect(bytes.byteLength).toBeGreaterThan(0);
}
