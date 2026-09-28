/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import { drawRectangle, makeFace, extrudeFace } from './solidCaptureSupport.js';
import { cancelPopover, commitPopover, fillFields, popoverTitle, propertyPanel, treeRow, useAbsolute } from './workPlaneCaptureSupport.js';

/**
 * 「原点を置き直す」章の2枚(`packages/help-content/docs/ja/origin.md`)。
 *
 * モデルブラウザの行の「⋮」一覧(`.pcad-tree__menu`)を開いた状態は、`削除`など
 * 他の項目に読み上げ用の説明が付いておらず、撮影の前提(全操作に名前+説明、
 * `assertRenderedControlDescriptions`)を満たせないため、この組では撮らない
 * (§プロパティから の入り口だけを撮る。製品側のツリーメニューの説明付けは
 * このタスクの編集可の外)。
 *
 * 1) origin-property: 点1を選んだ状態のプロパティのいちばん下、「原点」の欄
 *    (§プロパティから)。
 * 2) origin-moved: 「ここを原点にする」を押した直後、ステータスバーに
 *    「原点を(…)から移しました。」と出た状態(§何が起きるか)。
 */
export async function originCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 40×30×10の板(原点を移しても体積が変わらないことの土台。§何が起きるか)。
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await expect(treeRow(page, '面1')).toBeVisible();
  await extrudeFace(page, '面1', '10');

  // 点1(式 10 + π/2)と点2(整数 3)を置く(§入れた式はそのまま残る)。
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '選択', exact: true }).click();
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  await fillFields(page, ['10 + π/2', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('点を作る');
  await useAbsolute(page);
  await fillFields(page, ['3', '0', '0']);
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '点2')).toBeVisible();
  await waitForRecompute(page);

  // 1) 点1を選び、プロパティの「原点」の欄を撮る。
  await treeRow(page, '点1').click();
  const originSection = propertyPanel(page).locator('.pcad-section').filter({ has: page.getByRole('heading', { name: '原点', exact: true }) });
  const originButton = originSection.getByRole('button', { name: 'ここを原点にする', exact: true });
  await expect(originButton).toBeVisible();
  await captureManualDetail(page, info, {
    name: 'origin-property', dialog: originSection,
    fixture: { selected: '点1' }, script: new URL(import.meta.url),
  });

  // 2) 押した直後、ステータスバーに移した量が出た状態を撮る。
  await originButton.click();
  const statusText = page.locator('.pcad-statusbar__text');
  await expect(statusText).toContainText('原点を');
  await expect(statusText).toContainText('から移しました');
  await waitForRecompute(page);
  await captureManualDetail(page, info, {
    name: 'origin-moved', dialog: statusText,
    fixture: { movedFrom: '点1' }, script: new URL(import.meta.url),
  });
}
