/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForSettledRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, clickWorldPoint, commitPopover, drawRectangle, extrudeFace, fillFields, makeFace,
  popover, popoverInputs, popoverTitle, selectionKindLabel, sketchTool, topFaceCenter, treeRow,
} from './solidCaptureSupport.js';

/**
 * 「穴をあける」章の2枚(`packages/help-content/docs/ja/hole.md`)。40×30×10の板の上面に
 * 点を1つ打ち、面→点の順に選んで「穴」を開く(手順は`e2e/tests/solid.spec.ts`のP3加工
 * フィーチャーの検査「板に穴をあけて並べ...」と同じ)。
 *
 * 1) hole-basic: 既定(直径6・止まり穴)のまま開いた入力欄(§手順・§「貫通」の意味)。
 * 2) hole-counterbore: 「入口」を「ざぐり」にして増えた欄(§入口を広げる)。
 */
export async function holeCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '10');
  // 押し出しの計算部呼び出しが終わってから3Dの面を拾う。落ち着く前に押すと立体の面が
  // まだ無く、選ぶものが「面」でもクリックが何も拾わない(`solid.spec.ts`は`体積`の表示を
  // 待って同じ順にしている)。
  await waitForSettledRecompute(page);

  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  await fillFields(page, ['5', '15', '0']);
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '点1')).toBeVisible();

  // 「穴」は無効のまま押すと選ぶものが「面」へ切り替わる(§0.a-0.6、`solid.spec.ts` と同じ)。
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
  await expect(popoverInputs(page).first()).toHaveValue('6');
  await captureManualDetail(page, info, {
    name: 'hole-basic', dialog: popover(page),
    fixture: { face: '面1', center: '点1', diameter: '6' }, script: new URL(import.meta.url),
  });

  await popover(page).getByRole('group', { name: '入口', exact: true })
    .getByRole('button', { name: 'ざぐり', exact: true }).click();
  await captureManualDetail(page, info, {
    name: 'hole-counterbore', dialog: popover(page),
    fixture: { face: '面1', center: '点1', diameter: '6', entry: 'counterbore' }, script: new URL(import.meta.url),
  });
  await cancelPopover(page);
}
