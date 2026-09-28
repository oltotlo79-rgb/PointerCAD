/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, chooseSketchTool, commitPopover, fillFields, openShapeMenu, popover, popoverTitle,
} from './sketchDrawCaptureSupport.js';

/**
 * 「点・線・円弧をかく」章の2枚(`packages/help-content/docs/ja/sketch-tools.md`)。
 *
 * 1) sketch-tools-menu: 「作図」の畳んだ一覧を開いた画面(§「作図」「編集」「拘束」の一覧)。
 * 2) sketch-tools-point-series: 「点列」の基準点を入れる画面(§点列でまとめて打つ)。
 */
export async function sketchToolsCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 「作図」の一覧を開いた状態を撮る。
  const shapeMenu = await openShapeMenu(page);
  await captureManualDetail(page, info, {
    name: 'sketch-tools-menu', dialog: shapeMenu,
    fixture: { menu: '作図' }, script: new URL(import.meta.url),
  });
  await page.keyboard.press('Escape');

  // 2) 点列(直線)。基準点を入れる画面。
  await chooseSketchTool(page, '点列');
  await expect(popoverTitle(page)).toHaveText('点列の基準点');
  await fillFields(page, ['0', '0', '0']);
  await captureManualDetail(page, info, {
    name: 'sketch-tools-point-series', dialog: popover(page),
    fixture: { basePoint: [0, 0, 0] }, script: new URL(import.meta.url),
  });
  await commitPopover(page);
  await cancelPopover(page);
}
