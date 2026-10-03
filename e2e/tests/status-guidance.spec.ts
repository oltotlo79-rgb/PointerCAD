/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { beginRecompute, readRecomputeStats, waitForRecompute } from './recompute.js';
import { chooseEditTool, propertyValue, sketchTool, statusText } from './sketchFinishCaptureSupport.js';
import { drawRectangle, extrudeFace, makeFace, propertyPanel, treeRow } from './solidCaptureSupport.js';
import {
  cancelPopover, chooseShapeTool, chooseSketchTool, commitPopover, fillFields, popoverTitle, useAbsolute,
} from './sketchDrawCaptureSupport.js';
import { waitForStartupHealth } from './startupHealth.js';
import { uiMessage } from './uiMessages.js';

test('形の計算中も投影の次の操作と計算状況を同時に読める(FR-905)', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await waitForStartupHealth(page, info);
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await waitForRecompute(page);
  const extrusion = await beginRecompute(page);
  await extrudeFace(page, '面1', '10');
  await waitForRecompute(page, extrusion);
  // 最初の進捗通知の後にも待機が残るように、実際の押し出しを2段用意する。
  const secondExtrusion = await beginRecompute(page);
  await extrudeFace(page, '面1', '20');
  await waitForRecompute(page, secondExtrusion);
  await treeRow(page, '押し出し1').click();

  const distance = propertyPanel(page).locator('input.pcad-field__input').first();
  await expect(distance).toHaveValue('10');
  const edit = await beginRecompute(page);
  await distance.fill('12');
  await waitForRecompute(page, edit);
  await expect(propertyValue(page, '体積')).toHaveText('14400 mm³');
  // 入力中の変更は計算中の札を立てないため、欄を離れてUndoで同じ寸法を戻す。
  await treeRow(page, '押し出し1').click();
  const recalculation = await beginRecompute(page);
  // 各段の進捗通知より前に待つ検査口。2段目の待機中に1段目の進捗を確認する。
  await page.evaluate(() => { window.pcadDebugStepDelayMs = 10_000; });
  try {
    await page.keyboard.press('Control+z');
    const progress = page.getByRole('progressbar', { name: '計算しています', exact: true });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuemax', '2');
    // 道具なしの計算中文は従来どおり。案内の有無を計算完了の判定に流用しない。
    await expect(statusText(page)).toContainText('押し出し1 を計算しています');
    await chooseEditTool(page, '投影');
    await expect(statusText(page)).toBeVisible();
    await expect(statusText(page)).toContainText('写したい立体の面か辺をクリック');
    const activity = page.locator('.pcad-statusbar__activity');
    await expect(activity).toBeVisible();
    await expect(activity).toContainText('計算中');
    await expect(activity).toHaveAttribute('aria-label', /押し出し1 を計算しています/u);
    await expect(progress).toBeVisible();
    await expect(page.getByRole('button', { name: '中止', exact: true })).toBeVisible();
    expect((await readRecomputeStats(page)).isComputing).toBe(true);
    await info.attach('計算中の操作案内', {
      body: await page.locator('.pcad-statusbar').screenshot(), contentType: 'image/png',
    });
  } finally {
    await page.evaluate(() => { delete window.pcadDebugStepDelayMs; });
  }
  await waitForRecompute(page, recalculation);
  await expect(statusText(page)).toContainText('写したい立体の面か辺をクリック');
  await expect(page.locator('.pcad-statusbar__activity')).toHaveCount(0);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '中止', exact: true })).toHaveCount(0);
  // 投影の道具は面の選択へ切り替わるため、案内の保持を確認してから立体を選び直す。
  await sketchTool(page, '選択').click();
  await treeRow(page, '押し出し1').click();
  await expect(propertyValue(page, '体積')).toHaveText('12000 mm³');
});

test('作図の道具は入力の窓の段が進むごとに状態の欄の案内が替わる(矩形・円弧・長穴、FR-905)', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await waitForStartupHealth(page, info);
  const guide = (key: string): string => uiMessage('statusBar', key);

  // 矩形: 1 つ目の角 → 2 つ目の角(対角)。
  await chooseShapeTool(page, '矩形');
  await expect(popoverTitle(page)).toHaveText('矩形の 1 つ目の角');
  await expect(statusText(page)).toHaveText(guide('statusBar.guide.rectangle'));
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('矩形の 2 つ目の角');
  await expect(statusText(page)).toHaveText(guide('statusBar.guide.rectangleCorner2'));
  await useAbsolute(page);
  await fillFields(page, ['40', '30', '0']);
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '矩形1')).toBeVisible();

  // 円弧: 中心 → 形(半径・始まりの角度・終わりの角度)。
  await chooseSketchTool(page, '円弧');
  await expect(popoverTitle(page)).toHaveText('円弧の中心');
  await expect(statusText(page)).toHaveText(guide('statusBar.guide.arc'));
  await fillFields(page, ['80', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('円弧の形');
  await expect(statusText(page)).toHaveText(guide('statusBar.guide.arcShape'));
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '円弧1')).toBeVisible();

  // 長穴: 1 つ目の中心 → 2 つ目の中心 → 幅。
  await chooseShapeTool(page, '長穴');
  await expect(popoverTitle(page)).toHaveText('長穴の 1 つ目の中心');
  await expect(statusText(page)).toHaveText(guide('statusBar.guide.slot'));
  await fillFields(page, ['0', '60', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('長穴の 2 つ目の中心');
  await expect(statusText(page)).toHaveText(guide('statusBar.guide.slotCenter2'));
  await useAbsolute(page);
  await fillFields(page, ['40', '60', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('長穴の幅');
  await expect(statusText(page)).toHaveText(guide('statusBar.guide.slotShape'));
  await fillFields(page, ['10']);
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '長穴1')).toBeVisible();
  expect(errors).toEqual([]);
});
