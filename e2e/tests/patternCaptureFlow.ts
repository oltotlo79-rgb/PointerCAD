/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, clickWorldPoint, commitPopover, drawRectangle, extrudeFace, fillFields, makeFace,
  popover, popoverInputs, popoverTitle, selectionKindLabel, sketchTool, topFaceCenter, treeRow,
} from './solidCaptureSupport.js';

/**
 * 「同じ加工を並べる」章の2枚(`packages/help-content/docs/ja/pattern.md`)。板に穴を1つ
 * あけ、それを選んだまま並べる。手順は`e2e/tests/solid.spec.ts`のP3加工フィーチャーの
 * 検査「板に穴をあけて並べ...」と同じ。
 *
 * 1) pattern-linear: 「直線パターン」を開いた入力欄。既定の間隔20・個数3のまま(§手順(直線パターン))。
 * 2) pattern-circular: 同じ穴で「円形パターン」を開いた入力欄(§手順(円形パターン))。
 */
export async function patternCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '10');
  // 押し出しの計算が終わり、板がビューポートへ描かれてからでないと、次のクリックで
  // 立体の面を拾えない(solid-combineの撮影で見つかった同じ事情)。
  await waitForRecompute(page);

  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  await fillFields(page, ['5', '15', '0']);
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '点1')).toBeVisible();

  await openToolMenu(page, '加工');
  const machining = toolMenuPanel(page, '加工');
  const holeButton = machining.getByRole('button', { name: '穴', exact: true });
  await expect(holeButton).toBeDisabled();
  await holeButton.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');

  await clickWorldPoint(page, topFaceCenter(10));
  await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  await expect(holeButton).toBeEnabled();
  await holeButton.click();
  await expect(popoverTitle(page)).toHaveText('穴をあける');
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, '穴1')).toBeVisible();
  await waitForRecompute(page);

  // 1) 直線パターン。既定は間隔20・個数3。
  await treeRow(page, '穴1').click();
  await openToolMenu(page, '加工');
  const linearButton = machining.getByRole('button', { name: '直線パターン', exact: true });
  await expect(linearButton).toBeEnabled();
  await linearButton.click();
  await expect(popoverTitle(page)).toHaveText('まっすぐ並べる');
  await expect(popoverInputs(page).nth(0)).toHaveValue('20');
  await expect(popoverInputs(page).nth(1)).toHaveValue('3');
  await captureManualDetail(page, info, {
    name: 'pattern-linear', dialog: popover(page),
    fixture: { hole: '穴1', spacing: '20', count: '3' }, script: new URL(import.meta.url),
  });
  await cancelPopover(page);

  // 2) 円形パターン。同じ穴を選んだまま。
  await treeRow(page, '穴1').click();
  await openToolMenu(page, '加工');
  const circularButton = machining.getByRole('button', { name: '円形パターン', exact: true });
  await expect(circularButton).toBeEnabled();
  await circularButton.click();
  await expect(popoverTitle(page)).toHaveText('まわりに並べる');
  await captureManualDetail(page, info, {
    name: 'pattern-circular', dialog: popover(page),
    fixture: { hole: '穴1' }, script: new URL(import.meta.url),
  });
  await cancelPopover(page);
}
