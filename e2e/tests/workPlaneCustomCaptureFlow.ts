/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, choosePlaneMenuItem, commitPopover, fillFields, popover, popoverTitle, useAbsolute,
} from './workPlaneCaptureSupport.js';

/**
 * 「好きな向きの作業平面を作る」章の2枚(`packages/help-content/docs/ja/work-plane-custom.md`)。
 *
 * 1) work-plane-custom-three-point: 「作業平面(3点)」の3点目を入れる入力欄(§3点で作る)。
 * 2) work-plane-custom-offset: 「作業平面(オフセット)」の距離の入力欄(既定10mm、§面から離して作る)。
 */
export async function workPlaneCustomCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 3点で作る: (0,0,0)(40,0,0)(0,0,40) を通る平面。3点目を入れる画面で撮る。
  await choosePlaneMenuItem(page, '作業平面(3 点)');
  await expect(popoverTitle(page)).toHaveText('作業平面の 1 点目');
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('作業平面の 2 点目');
  await useAbsolute(page);
  await fillFields(page, ['40', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('作業平面の 3 点目');
  await useAbsolute(page);
  await fillFields(page, ['0', '0', '40']);
  await captureManualDetail(page, info, {
    name: 'work-plane-custom-three-point', dialog: popover(page),
    fixture: { first: [0, 0, 0], second: [40, 0, 0], third: [0, 0, 40] }, script: new URL(import.meta.url),
  });
  await commitPopover(page);
  await cancelPopover(page);

  // 2) 面から離して作る: いまの作図面(XY)から離す。距離の既定は10。
  await choosePlaneMenuItem(page, '作業平面(オフセット)');
  await expect(popoverTitle(page)).toHaveText('面から離す');
  await expect(popover(page).locator('input.pcad-field__input').first()).toHaveValue('10');
  await captureManualDetail(page, info, {
    name: 'work-plane-custom-offset', dialog: popover(page),
    fixture: { base: 'xy', defaultDistanceMm: 10 }, script: new URL(import.meta.url),
  });
  await cancelPopover(page);
}
