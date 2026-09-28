/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, choosePlaneMenuItem, commitPopover, fillFields, popover, popoverTitle, treeRow, treeSection, useAbsolute,
} from './workPlaneCaptureSupport.js';

/**
 * 「基準の軸・点・座標系を作る」章の2枚(`packages/help-content/docs/ja/reference-geometry.md`)。
 *
 * 1) reference-geometry-axis: 「基準軸」の2点目を入れる入力欄(§基準軸を作る、決め方=2点)。
 * 2) reference-geometry-tree: 基準軸・基準点・座標系を作った後の、モデルブラウザの「基準」の節。
 */
export async function referenceGeometryCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 基準軸(2点)。(0,0,0)→(0,0,50) の向きの軸。2点目を入れる画面で撮る。
  await choosePlaneMenuItem(page, '基準軸');
  await expect(popoverTitle(page)).toHaveText('基準軸の決め方');
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('基準軸の 1 点目');
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('基準軸の 2 点目');
  await useAbsolute(page);
  await fillFields(page, ['0', '0', '50']);
  await captureManualDetail(page, info, {
    name: 'reference-geometry-axis', dialog: popover(page),
    fixture: { kind: 'axis', method: 'twoPoints', first: [0, 0, 0], second: [0, 0, 50] }, script: new URL(import.meta.url),
  });
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '基準軸1')).toBeVisible();

  // 2) 基準点(座標)。
  await choosePlaneMenuItem(page, '基準点');
  await expect(popoverTitle(page)).toHaveText('基準点の決め方');
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('基準点の位置');
  await fillFields(page, ['20', '10', '5']);
  await commitPopover(page);
  await cancelPopover(page);

  // 3) 座標系(原点 + 2軸)。
  await choosePlaneMenuItem(page, '座標系');
  await expect(popoverTitle(page)).toHaveText('座標系の原点');
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('座標系の軸');
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '座標系1')).toBeVisible();

  // 4) 「基準」の節に4種がそろった状態を撮る。
  const references = treeSection(page, '基準');
  await expect(references).toContainText('基準軸1');
  await expect(references).toContainText('基準点');
  await expect(references).toContainText('座標系1');
  await captureManualDetail(page, info, {
    name: 'reference-geometry-tree', dialog: references,
    fixture: { axis: '基準軸1', point: '基準点', coordinateSystem: '座標系1' }, script: new URL(import.meta.url),
  });
}
