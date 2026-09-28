/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForSettledRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  clickWorldPoint, commitPopover, drawRectangle, extrudeFace, makeFace, popover, popoverInputs,
  popoverTitle, propertyPanel, selectionKindLabel, sketchTool, treeRow,
} from './solidCaptureSupport.js';

/**
 * 「角を丸める・面を取る」章の2枚(`packages/help-content/docs/ja/fillet-chamfer.md`)。
 * 40×30×10の板で、まずC面取り(既定の距離2)を作ってプロパティの「決め方」を撮り、元に
 * 戻してから別の辺でR面取りの入力欄(既定の半径2)を撮る(影響し合わない2つの辺を使うのは
 * `e2e/tests/solid.spec.ts`のP3加工フィーチャーの検査「辺を選んで面を取り、角を丸められる」
 * と同じ理由)。
 *
 * 1) fillet-chamfer-method: 作った後のプロパティの「決め方」(§C面取り §3つの決め方)。
 * 2) fillet-chamfer-round: R面取りの入力欄、既定の半径2mm(§R面取り(角を丸める))。
 */
export async function filletChamferCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '10');
  // 押し出しの計算部呼び出しが終わってから3Dの辺を拾う(`holeCaptureFlow.ts`と同じ理由)。
  await waitForSettledRecompute(page);

  // 1) 選択の道具のまま`2`で選ぶものを「辺」にし、上面手前(y=0)の長辺の中点でC面取り。
  await sketchTool(page, '選択').click();
  await page.keyboard.press('2');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
  await clickWorldPoint(page, [20, 0, 10]);
  await openToolMenu(page, '加工');
  const machining = toolMenuPanel(page, '加工');
  await expect(machining.getByRole('button', { name: 'C面取り', exact: true })).toBeEnabled();
  await machining.getByRole('button', { name: 'C面取り', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('面を取る');
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, 'C面取り1')).toBeVisible();
  await treeRow(page, 'C面取り1').click();
  await expect(propertyPanel(page)).toContainText('決め方');
  await captureManualDetail(page, info, {
    name: 'fillet-chamfer-method', dialog: propertyPanel(page),
    fixture: { edge: 'top-y0', distance: '2' }, script: new URL(import.meta.url),
  });

  // 2) 元へ戻し、影響のない角(x=0, y=0)の縦の辺でR面取りを開く(半径は既定の2のまま撮る)。
  await page.keyboard.press('Control+z');
  await expect(treeRow(page, 'C面取り1')).toHaveCount(0);
  // 取り消しの再計算も落ち着かせてから、押し出し後の立体の辺をもう一度3Dで拾う。
  await waitForSettledRecompute(page);
  await treeRow(page, '押し出し1').click();
  await page.keyboard.press('2');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 辺');
  await clickWorldPoint(page, [0, 0, 5]);
  await openToolMenu(page, '加工');
  await expect(toolMenuPanel(page, '加工').getByRole('button', { name: 'R面取り', exact: true })).toBeEnabled();
  await toolMenuPanel(page, '加工').getByRole('button', { name: 'R面取り', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('角を丸める');
  await expect(popoverInputs(page).first()).toHaveValue('2');
  await captureManualDetail(page, info, {
    name: 'fillet-chamfer-round', dialog: popover(page),
    fixture: { edge: 'corner-0-0', defaultRadius: '2' }, script: new URL(import.meta.url),
  });
  await commitPopover(page);
}
