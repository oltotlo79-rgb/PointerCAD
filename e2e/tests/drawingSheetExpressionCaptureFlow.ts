/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { drawingFromBox, waitForDrawingReady } from './drawingManufacturingFixture.js';
import { drawingMessage as m } from './drawingMessages.js';

/**
 * 「用紙サイズ・縮尺・用紙位置」章の「用紙の設定」の1枚(`packages/help-content/docs/ja/drawing-scale.md`、FIX-13)。
 *
 * drawing-sheet-expression: 箱から作った図面の右の「用紙」の欄に、縮尺 `1/2`・縮尺の候補 `1/2, 1, root(8, 3)`・
 * 文字高さ `7/2` を式のまま入れて「用紙設定を適用」した後の画面。欄は式のまま残り、画面下の縮尺は1:2になる。
 *
 * 入力・適用・待ち方は操作の検査 `drawing-sheet-expressions.spec.ts`(FIX-13)の最初の段と同じ。
 */
const SCALE = '1/2', SCALE_OPTIONS = '1/2, 1, root(8, 3)', TEXT_HEIGHT = '7/2';

export async function drawingSheetExpressionCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await drawingFromBox(page);
  const settings = page.locator('.pcad-drawing-property-section[data-property-kind="sheet"]');
  if (await settings.getAttribute('open') === null) await settings.locator(':scope > summary').click();
  await expect(settings).toHaveAttribute('open', '');
  const scale = settings.getByLabel(m('drawing.sheet.scale'), { exact: true });
  const options = settings.getByLabel(m('drawing.sheet.scales'), { exact: true });
  const height = settings.getByLabel(m('drawing.table.textHeight'), { exact: true });
  const apply = settings.getByRole('button', { name: m('drawing.sheet.apply'), exact: true });

  await scale.fill(SCALE);
  await options.fill(SCALE_OPTIONS);
  await height.fill(TEXT_HEIGHT);
  await apply.click();
  await waitForDrawingReady(page);
  // 適用した後も欄は式のまま残り、画面下の縮尺は用紙の値1:2を示す。
  await expect(scale).toHaveValue(SCALE);
  await expect(options).toHaveValue(SCALE_OPTIONS);
  await expect(height).toHaveValue(TEXT_HEIGHT);
  await expect(page.getByTestId('drawing-status-scale')).toHaveText(m('drawing.status.scale').replace('{ratio}', '1:2'));
  for (const field of [scale, options, height]) await expect(field).toHaveAttribute('aria-invalid', 'false');
  // 「用紙と枠」の節は1440×900の画面より縦に長い(1回目の試走で高さ849・下端952)ので、節そのものを撮ると
  // 画面の外が黒く写る。右の区画(画面の中に収まる固定の枠)を、欄が先頭に見える位置で撮る。
  const panel = page.locator('.pcad-panel--right');
  const body = panel.locator('.pcad-panel__body');
  await expect(body).toHaveCount(1);
  await body.evaluate(element => { element.scrollTop = 0; });
  for (const field of [scale, options, height]) await expect(field).toBeInViewport();
  const [panelBox, viewport] = [await panel.boundingBox(), page.viewportSize()];
  if (panelBox === null || viewport === null) throw new Error('右の区画の位置を取得できません。');
  expect(panelBox.y + panelBox.height <= viewport.height, '右の区画が画面の中に収まる').toBe(true);
  await captureManualDetail(page, info, {
    name: 'drawing-sheet-expression', dialog: panel,
    fixture: { part: 'box', sheet: { scale: SCALE, scaleOptions: SCALE_OPTIONS, textHeight: TEXT_HEIGHT }, ratio: '1:2' },
    script: new URL(import.meta.url),
  });
}
