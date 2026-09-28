/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, chooseEditTool, chooseSketchTool, clickWorldPoint, commitPopover,
  popover, popoverTitle, treeRow, useAbsolute,
} from './sketchFinishCaptureSupport.js';

/**
 * 「線の角を丸める・面取りする」章の2枚(`packages/help-content/docs/ja/sketch-fillet.md`)。
 *
 * 丸め・面取りの対象を選ぶのに実際のマウスホバーの薄い予告表示は使わない(w74a が
 * 見送った理由)。かわりに、クリックした直後に出る「角を丸める」「面を取る」その場入力
 * (半径・距離)を撮る。半径・距離を打ち込む段は、対象の角を選び終えた後の確実な状態で
 * あり、Enter前で確定を待たずに撮れる。
 *
 * 1) sketch-fillet-radius: L字の角にマウスを乗せてクリックした直後、「角を丸める」の
 *    半径の入力欄(既定5mm)が出た状態。
 * 2) sketch-chamfer-distance: 同じ角を「面取り」で押した直後、「面を取る」の距離の
 *    入力欄(既定3mm)が出た状態。
 */
export async function sketchFilletCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // L字(0,0)→(40,0)→(40,30)をかく。角(40,0)を丸め・面取りの対象にする。
  await chooseSketchTool(page, '線分');
  await expect(popoverTitle(page)).toHaveText('線分の始点');
  await popover(page).locator('input.pcad-field__input').nth(0).fill('0');
  await popover(page).locator('input.pcad-field__input').nth(1).fill('0');
  await popover(page).locator('input.pcad-field__input').nth(2).fill('0');
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('線分の終点');
  await useAbsolute(page);
  await popover(page).locator('input.pcad-field__input').nth(0).fill('40');
  await popover(page).locator('input.pcad-field__input').nth(1).fill('0');
  await popover(page).locator('input.pcad-field__input').nth(2).fill('0');
  await commitPopover(page);
  await useAbsolute(page);
  await popover(page).locator('input.pcad-field__input').nth(0).fill('40');
  await popover(page).locator('input.pcad-field__input').nth(1).fill('30');
  await popover(page).locator('input.pcad-field__input').nth(2).fill('0');
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '線分2')).toBeVisible();

  // 1) 角を丸める(フィレット)。クリック直後の半径入力を撮る。
  await chooseEditTool(page, 'フィレット');
  await clickWorldPoint(page, [40, 0, 0]);
  await expect(popoverTitle(page)).toHaveText('角を丸める');
  await captureManualDetail(page, info, {
    name: 'sketch-fillet-radius', dialog: popover(page),
    fixture: { step: 'fillet-radius' }, script: new URL(import.meta.url),
  });
  await commitPopover(page);
  await expect(treeRow(page, '円弧1')).toBeVisible();

  // 元に戻し、同じ角を面取りする。クリック直後の距離入力を撮る。
  await page.keyboard.press('Control+z');
  await expect(treeRow(page, '円弧1')).toHaveCount(0);
  await chooseEditTool(page, '面取り');
  await clickWorldPoint(page, [40, 0, 0]);
  await expect(popoverTitle(page)).toHaveText('面を取る');
  await captureManualDetail(page, info, {
    name: 'sketch-chamfer-distance', dialog: popover(page),
    fixture: { step: 'chamfer-distance' }, script: new URL(import.meta.url),
  });
  await commitPopover(page);
  await expect(treeRow(page, '線分3')).toBeVisible();
}
