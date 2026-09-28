/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, chooseShapeTool, commitPopover, fillFields, popover, popoverTitle, toggleInPopover,
} from './sketchDrawCaptureSupport.js';

/**
 * 「楕円をかく」章の2枚(`packages/help-content/docs/ja/ellipse.md`)。
 *
 * 1) ellipse-basic: 中心・長半径20・短半径10を決めた後、傾きを入れる画面(§かき方)。
 * 2) ellipse-arc: 「一部だけ(楕円弧)」を入にし、開始角・終了角を入れる画面(§一部だけにする)。
 */
export async function ellipseCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 楕円。中心(0,0)、既定の長半径20・短半径10のまま、傾きを入れる画面。
  await chooseShapeTool(page, '楕円');
  await expect(popoverTitle(page)).toHaveText('楕円の中心');
  await fillFields(page, ['0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('楕円の半径');
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('楕円の傾き');
  await captureManualDetail(page, info, {
    name: 'ellipse-basic', dialog: popover(page),
    fixture: { center: [0, 0], majorRadiusMm: 20, minorRadiusMm: 10 }, script: new URL(import.meta.url),
  });

  // 2) 「一部だけ(楕円弧)」を入にしてEnterを押すと、続けて開始角・終了角が聞かれる。
  await toggleInPopover(page, '一部だけ(楕円弧)');
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('楕円弧の角度');
  await captureManualDetail(page, info, {
    name: 'ellipse-arc', dialog: popover(page),
    fixture: { center: [0, 0], majorRadiusMm: 20, minorRadiusMm: 10, partial: true }, script: new URL(import.meta.url),
  });
  await cancelPopover(page);
}
