/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, chooseSketchTool, commitPopover, fillFields, popoverTitle, propertyPanel, treeRow, useAbsolute,
} from './sketchDrawCaptureSupport.js';

/**
 * 「かいたものを直す」章の1枚(`packages/help-content/docs/ja/edit-sketch.md`)。
 *
 * edit-sketch-property: 線分を選んだ状態のプロパティ。始点の X に式`10*√2`が
 * そのまま出て、位置の決め方(絶対/相対/極)のボタンも見える(§数を直す、
 * §位置の決め方を変える)。
 */
export async function editSketchCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await chooseSketchTool(page, '線分');
  await expect(popoverTitle(page)).toHaveText('線分の始点');
  await fillFields(page, ['10*√2', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('線分の終点');
  await useAbsolute(page);
  await fillFields(page, ['40', '0', '0']);
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '線分1')).toBeVisible();

  await treeRow(page, '線分1').click();
  const inputs = propertyPanel(page).locator('input.pcad-field__input');
  await expect(inputs.first()).toHaveValue('10*√2');
  await captureManualDetail(page, info, {
    name: 'edit-sketch-property', dialog: propertyPanel(page),
    fixture: { selected: '線分1', startExpressionX: '10*√2' }, script: new URL(import.meta.url),
  });
}
