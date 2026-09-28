/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, commitPopover, fillFields, popover, popoverTitle, propertyPanel, treeRow,
} from './solidCaptureSupport.js';

/**
 * 「球の表面に点を置く」章の2枚(`packages/help-content/docs/ja/sphere-grid.md`)。
 * 球を置く手順は`e2e/tests/p5-cut-mirror.spec.ts`の`placePrimitive`と同じ(既定20mmのまま)。
 *
 * 1) sphere-grid-hint: 球を選んだ状態のプロパティ、「球面の案内線」の節(§線の間隔を変える・いつも出す)。
 * 2) sphere-grid-point: 「球面上の点」を開き、緯度・経度を数で入れた入力欄(§緯度と経度を数字で入れる)。
 */
export async function sphereGridCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await openToolMenu(page, '作る');
  const createMenu = toolMenuPanel(page, '作る');
  await createMenu.getByRole('button', { name: '球', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('球を置く');
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, '球1')).toBeVisible();
  await waitForRecompute(page);

  // 1) 球を選んだ状態のプロパティ、「球面の案内線」の節を撮る。
  await treeRow(page, '球1').click();
  const gridSection = propertyPanel(page).locator('.pcad-section')
    .filter({ has: page.getByRole('heading', { name: '球面の案内線', exact: true }) });
  await expect(gridSection).toBeVisible();
  await captureManualDetail(page, info, {
    name: 'sphere-grid-hint', dialog: gridSection,
    fixture: { sphere: '球1' }, script: new URL(import.meta.url),
  });

  // 2) 「球面上の点」を開き、緯度30度・経度45度を数で入れた状態を撮る。
  await openToolMenu(page, '作る');
  await createMenu.getByRole('button', { name: '球面上の点', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('球面上の点');
  await fillFields(page, ['30', '45']);
  await captureManualDetail(page, info, {
    name: 'sphere-grid-point', dialog: popover(page),
    fixture: { sphere: '球1', latitude: '30', longitude: '45' }, script: new URL(import.meta.url),
  });
  await cancelPopover(page);
}
