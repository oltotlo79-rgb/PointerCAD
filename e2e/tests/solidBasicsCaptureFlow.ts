/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, drawRectangle, makeFace, popover, popoverInputs, popoverTitle, treeRow,
} from './solidCaptureSupport.js';

/**
 * 「厚みをつける・回す」章の2枚(`packages/help-content/docs/ja/solid-basics.md`)。
 *
 * 1) solid-basics-extrude: 面を選んで「押し出し」を開いた、既定10mmの入力欄(§面に厚みをつける)。
 * 2) solid-basics-rotate: 同じ面で「回転」を開いた、角度と回転軸の入力欄(§面を回して立体にする)。
 *
 * どちらもこの章は入力欄そのものを見せる撮影なのでEscで取り消し、立体は作らない。
 */
export async function solidBasicsCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await drawRectangle(page, ['0', '0'], ['20', '20']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await expect(treeRow(page, '面1')).toBeVisible();

  // 1) 押し出し: 面を選び「作る」→「押し出し」。既定の10mmのまま撮る。
  await treeRow(page, '面1').click();
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '押し出し', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await expect(popoverInputs(page).first()).toHaveValue('10');
  await captureManualDetail(page, info, {
    name: 'solid-basics-extrude', dialog: popover(page),
    fixture: { face: '面1', defaultDistance: '10' }, script: new URL(import.meta.url),
  });
  await cancelPopover(page);

  // 2) 回転: 同じ面をもう一度選び「作る」→「回転」。既定は360度・Z軸。
  await treeRow(page, '面1').click();
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '回転', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('回す');
  await captureManualDetail(page, info, {
    name: 'solid-basics-rotate', dialog: popover(page),
    fixture: { face: '面1' }, script: new URL(import.meta.url),
  });
  await cancelPopover(page);
}
