/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForSettledRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, clickWorldPoint, commitPopover, drawRectangle, extrudeFace, fillFields, makeFace,
  popover, popoverTitle, propertyPanel, selectionKindLabel, sketchTool, topFaceCenter, treeRow,
} from './solidCaptureSupport.js';

/**
 * 「ねじ穴をあける」章の2枚(`packages/help-content/docs/ja/thread.md`)。40×30×15の板
 * (止まり穴が板を突き抜けない厚み)の上面中央に点を1つ打ち、面→点の順に選んで「ねじ穴」を
 * 開く(手順は`e2e/tests/solid.spec.ts`のP3加工フィーチャーの検査「JISの呼びから
 * ねじ穴があけられる」と同じ)。
 *
 * 1) thread-basic: 既定(呼びM6・並目・止まり穴)のまま開いた入力欄(§手順・並目と細目の違い)。
 * 2) thread-pitch: 作った後のプロパティ。呼びからピッチ・下穴径が自動で入った様子(§呼びを選ぶと)。
 */
export async function threadCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '15');
  // 押し出しの計算部呼び出しが終わってから3Dの面を拾う(`holeCaptureFlow.ts`と同じ理由)。
  await waitForSettledRecompute(page);

  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  await fillFields(page, ['20', '15', '0']);
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '点1')).toBeVisible();

  await openToolMenu(page, '加工');
  const machining = toolMenuPanel(page, '加工');
  const threadButton = machining.getByRole('button', { name: 'ねじ穴', exact: true });
  await expect(threadButton).toBeDisabled();
  await threadButton.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');

  await clickWorldPoint(page, topFaceCenter(15));
  await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  await expect(threadButton).toBeEnabled();
  await threadButton.click();
  await expect(popoverTitle(page)).toHaveText('ねじ穴をあける');
  await expect(popover(page).locator('.pcad-menu__count')).toHaveText('M6');
  await captureManualDetail(page, info, {
    name: 'thread-basic', dialog: popover(page),
    fixture: { face: '面1', center: '点1', size: 'M6' }, script: new URL(import.meta.url),
  });

  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, 'ねじ穴1')).toBeVisible();
  await treeRow(page, 'ねじ穴1').click();
  await expect(propertyPanel(page)).toContainText('ピッチ');
  await captureManualDetail(page, info, {
    name: 'thread-pitch', dialog: propertyPanel(page),
    fixture: { size: 'M6', series: 'coarse' }, script: new URL(import.meta.url),
  });
}
