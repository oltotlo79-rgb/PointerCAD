/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import { drawRectangle, extrudeFace, makeFace, treeRow } from './solidCaptureSupport.js';

/**
 * 「立体をつなぐ・組み合わせる」章の1枚(`packages/help-content/docs/ja/solid-combine.md`)。
 * 20×20×20の立体の中に10×10×10の立体を入れ子にする作り方は
 * `e2e/tests/solid.spec.ts`「立体どうしを組み合わせられる(FR-404)」と同じ。
 *
 * 1) solid-combine-menu: 2つの立体を選び、「合わせる」の一覧(和・差・積)を開いた状態
 *    (§2つの立体を組み合わせる)。
 */
export async function solidCombineCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await drawRectangle(page, ['0', '0'], ['20', '20']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '20');
  await expect(treeRow(page, '押し出し1')).toBeVisible();
  // 押し出し1の計算が終わるまで待ってから次のスケッチへ進む(kernel計算中はビューポートの
  // キー入力〔面を張るEnter〕が効かず、面2が作れないことがあった。solid.spec.tsの実績
  // 検査は体積の表示を待つことで同じ効果を得ている)。
  await waitForRecompute(page);

  await drawRectangle(page, ['5', '5'], ['10', '10']);
  await makeFace(page, ['線分5', '線分6', '線分7', '線分8']);
  await extrudeFace(page, '面2', '10');
  await expect(treeRow(page, '押し出し2')).toBeVisible();
  await waitForRecompute(page);

  await treeRow(page, '押し出し1').click();
  await treeRow(page, '押し出し2').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '合わせる');
  const menu = toolMenuPanel(page, '合わせる');
  for (const label of ['和', '差', '積']) {
    await expect(menu.getByRole('button', { name: label, exact: true })).toBeEnabled();
  }
  await captureManualDetail(page, info, {
    name: 'solid-combine-menu', dialog: menu,
    fixture: { first: '押し出し1', second: '押し出し2' }, script: new URL(import.meta.url),
  });
}
