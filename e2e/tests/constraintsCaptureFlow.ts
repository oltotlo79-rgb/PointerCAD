/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
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
  await page.setViewportSize({ width: 1440, height: 1100 });
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

  // 3) 一覧はスクロール領域の下方にある。実際に写る位置まで表示してから撮る。
  const section = propertyPanel(page).locator('.pcad-section')
    .filter({ has: page.locator('.pcad-constraint-list') });
  await expect(section).toHaveCount(1);
  await section.scrollIntoViewIfNeeded();
  const parallel = constraintRow(page, '平行1');
  const distance = constraintRow(page, '距離1');
  const distanceValue = distance.locator('.pcad-constraint-row__value');
  const assertCapturedList = async (): Promise<void> => {
    await expect(section.getByRole('heading', { name: '拘束', exact: true })).toBeVisible();
    await expect(parallel).toContainText('線分1');
    await expect(parallel).toContainText('線分2');
    await expect(distanceValue).toHaveValue('10');
    await expect(statusText(page)).toContainText('あと 6 か所決まっていません');
    // toBeVisible alone also passes for content outside a scrollport.
    for (const subject of [section, parallel, distance, distanceValue,
      parallel.locator('.pcad-constraint-row__remove'), distance.locator('.pcad-constraint-row__remove')]) {
      await expect(subject).toBeInViewport({ ratio: 1 });
    }
    await expect(parallel.locator('.pcad-constraint-row__remove')).toBeEnabled();
    await expect(distance.locator('.pcad-constraint-row__remove')).toBeEnabled();
  };
  // Record actual clipping geometry without changing the application DOM or styles.
  const recordListGeometry = async (phase: 'before-scroll' | 'before' | 'after'): Promise<void> => {
    const geometry = await section.evaluate(element => {
      const scrollport = element.closest('.pcad-panel__body');
      if (!(scrollport instanceof HTMLElement)) throw new Error('Constraint list scrollport is missing');
      const bounds = (target: Element) => {
        const rect = target.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      };
      return { viewport: { width: innerWidth, height: innerHeight }, section: { bounds: bounds(element), clientHeight: element.clientHeight,
        scrollTop: element.scrollTop, scrollHeight: element.scrollHeight },
        scrollport: { bounds: bounds(scrollport), clientHeight: scrollport.clientHeight,
          scrollTop: scrollport.scrollTop, scrollHeight: scrollport.scrollHeight } };
    });
    await writeFile(info.outputPath(`constraints-list-${phase}-geometry.json`),
      JSON.stringify(geometry, null, 2), { flag: 'wx' });
  };
  await recordListGeometry('before-scroll');
  // Native scrollIntoView can leave a fractional edge clipped. Use a normal wheel to reach the end padding.
  await section.getByRole('heading', { name: '拘束', exact: true }).hover();
  const scrollport = propertyPanel(page).locator('.pcad-panel__body');
  await page.mouse.wheel(0, await scrollport.evaluate(element => element.scrollHeight));
  // wheel() returns before scrolling finishes; observe the actual endpoint without changing the DOM.
  await expect.poll(() => scrollport.evaluate(element =>
    Math.max(0, element.scrollHeight - element.clientHeight) - element.scrollTop),
  { message: 'Constraint panel reaches its actual scroll end before capture' }).toBeLessThanOrEqual(0);
  await recordListGeometry('before');
  await assertCapturedList();
  await captureManualDetail(page, info, {
    name: 'constraints-list', dialog: section,
    fixture: { constraints: ['平行1', '距離1'], remaining: 6 }, script: new URL(import.meta.url),
  });
  await recordListGeometry('after');
  await assertCapturedList();
}
