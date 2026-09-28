/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  chooseConstraint, commitConstraintValue, constraintRow, constraintValueDialog, drawLine, propertyPanel, statusText, treeRow,
} from './sketchDrawCaptureSupport.js';

/**
 * 「形を条件で決める(拘束)」章の2枚(`packages/help-content/docs/ja/constraints.md`)。
 *
 * 1) constraints-value: 「距離」を選んだ後、数を聞く小さな入力が出た画面(§数を決める拘束)。
 * 2) constraints-list: 平行・距離を付けた後、プロパティの拘束の一覧と、
 *    ステータスバーの「あとN箇所決まっていません」の帯(§一覧で直す・消す、
 *    §あと何か所決まっていないか)。
 */
export async function constraintsCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await drawLine(page, ['0', '0'], ['10', '0']);
  await expect(treeRow(page, '線分1')).toBeVisible();
  await drawLine(page, ['0', '5'], ['10', '8']);
  await expect(treeRow(page, '線分2')).toBeVisible();

  // 1) 平行(線分1・線分2)。8 − 1 = 7。
  await treeRow(page, '線分1').click();
  await treeRow(page, '線分2').click({ modifiers: ['Shift'] });
  await chooseConstraint(page, '平行');
  await expect(constraintRow(page, '平行1')).toBeVisible();
  await expect(statusText(page)).toContainText('あと 7 か所決まっていません');

  // 2) 距離(線分1)を選ぶと、数を聞く入力が出る。既定値はいまの長さ。
  await treeRow(page, '線分1').click();
  await chooseConstraint(page, '距離');
  await expect(constraintValueDialog(page)).toBeVisible();
  await captureManualDetail(page, info, {
    name: 'constraints-value', dialog: constraintValueDialog(page),
    fixture: { target: '線分1', kind: 'distance' }, script: new URL(import.meta.url),
  });
  await commitConstraintValue(page);
  await expect(constraintRow(page, '距離1')).toBeVisible();
  await expect(statusText(page)).toContainText('あと 6 か所決まっていません');

  // 3) プロパティの拘束の一覧と、下の帯を撮る。
  await captureManualDetail(page, info, {
    name: 'constraints-list', dialog: propertyPanel(page),
    fixture: { constraints: ['平行1', '距離1'], remaining: 6 }, script: new URL(import.meta.url),
  });
}
