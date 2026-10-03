/// <reference lib="dom" />
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, chooseSketchTool, commitPopover, fillFields, popover, popoverInputs, popoverTitle, useAbsolute,
} from './sketchDrawCaptureSupport.js';
import { uiMessage } from './uiMessages.js';

/**
 * 「数値と式の入れ方」章の「入力の窓を動かす」の1枚(`packages/help-content/docs/ja/numeric-input.md`)。
 *
 * numeric-input-drag: 線分の終点の窓に座標を入れたまま、見出し(点の印のつまみ)をドラッグして
 * 左上へ動かした後の窓。入れた値と入力中の欄の焦点はそのまま残る。
 *
 * ドラッグの手順と確かめ方は操作の検査 `draggableInputWindowsFlow.ts` の `dragHeading` と同じ
 * (見出しのつかむ印・カーソル・動いた量)。その検査は撮影をしないので、撮影用にここへ写した。
 */
/**
 * 窓は作図領域の中ほど(1440×900で左上がおよそ(715,413))に開く。右や下へ動かすと作図領域の縁で
 * 止まり(1回目の試走で右へ180のうち178で止まった)、下の案内の帯にも近づくので、左上へ動かす。
 */
const DRAG = { dx: -260, dy: -200 } as const;

async function rectangle(locator: Locator) {
  await expect(locator).toBeVisible();
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error('入力の窓の位置を取得できません。');
  return rect;
}

/** 見出しの左寄り(つまみの印の上)を押して動かす。押している間だけカーソルが「つかむ」になる。 */
async function dragHeading(page: Page, panel: Locator, dx: number, dy: number): Promise<void> {
  const title = panel.locator('.pcad-window-title').first();
  const start = await rectangle(title);
  await expect(title.locator('.pcad-window-title__grip')).toBeVisible();
  await expect(title).toHaveCSS('cursor', 'grab');
  const x = start.x + 16, y = start.y + start.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await expect(title).toHaveCSS('cursor', 'grabbing');
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  await expect(title).toHaveCSS('cursor', 'grab');
}

export async function numericInputDragCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await chooseSketchTool(page, '線分');
  await expect(popoverTitle(page)).toHaveText('線分の始点');
  // 状態欄の案内は窓の段に合わせて「始点」から「終点」へ替わる(FR-905)。
  const statusText = page.locator('.pcad-statusbar__text');
  await expect(statusText).toHaveText(uiMessage('statusBar', 'statusBar.guide.line'));
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('線分の終点');
  await expect(statusText).toHaveText(uiMessage('statusBar', 'statusBar.guide.lineEnd'));
  await useAbsolute(page);
  await fillFields(page, ['30', '10*2', '0']);
  await expect(popover(page).getByText('= 20', { exact: true })).toBeVisible();
  const inputs = popoverInputs(page);
  await inputs.nth(1).focus();

  const panel = popover(page);
  const before = await rectangle(panel);
  await dragHeading(page, panel, DRAG.dx, DRAG.dy);
  const after = await rectangle(panel);
  expect(after.x - before.x).toBeCloseTo(DRAG.dx, 0);
  expect(after.y - before.y).toBeCloseTo(DRAG.dy, 0);
  // 動かしても入れた値と焦点はそのまま。
  await expect(inputs.nth(1)).toBeFocused();
  await expect(inputs.nth(0)).toHaveValue('30');
  await expect(inputs.nth(1)).toHaveValue('10*2');
  await expect(inputs.nth(2)).toHaveValue('0');
  await expect(statusText).toHaveText(uiMessage('statusBar', 'statusBar.guide.lineEnd'));
  await captureManualDetail(page, info, {
    name: 'numeric-input-drag', dialog: panel,
    fixture: { tool: 'line', start: [0, 0, 0], end: ['30', '10*2', '0'], drag: DRAG }, script: new URL(import.meta.url),
  });

  // 動かした後も Enter で決まる。
  await inputs.nth(1).press('Enter');
  await expect(page.locator('.pcad-panel--left').getByRole('button', { name: '線分1', exact: true })).toBeVisible();
  await cancelPopover(page);
}
