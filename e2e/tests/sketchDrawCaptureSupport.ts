/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test';

export {
  cancelPopover, clickWorldPoint, commitPopover, featureTree, fillFields, popover, popoverInputs,
  popoverTitle, propertyPanel, propertyValue, sketchTool, treeRow, treeSection, useAbsolute,
} from './workPlaneCaptureSupport.js';

/**
 * 新しい図形をかく道具(円・2点円弧・矩形・正多角形・長穴・楕円・スプライン等)の撮影で
 * 共通に使う補助。`e2e/tests/sketch-extended.spec.ts`(P4 の通し検査)にある同名の
 * 補助関数と同じ作りをここへ1か所にまとめたもの(2026-09-24 の統括の指示に合わせる)。
 * `sketch-extended.spec.ts` 自身は変更しない。
 */

import {
  cancelPopover as cancelPopoverImpl, commitPopover, fillFields, popover, popoverInputs, sketchTool, useAbsolute,
} from './workPlaneCaptureSupport.js';

/** ポップアップの中の選択肢を名前で押す(「絶対」「相対」「極」など)。 */
export async function pickInPopover(page: Page, label: string): Promise<void> {
  await popover(page).getByRole('button', { name: label, exact: true }).first().click();
}

/** ポップアップの中の入切つまみ(`role="switch"`。「一部だけ(楕円弧)」「構築線にする」等)を名前で押す。 */
export async function toggleInPopover(page: Page, label: string): Promise<void> {
  await popover(page).getByRole('switch', { name: label, exact: true }).first().click();
}

/**
 * 平置きの道具(点・線分・円弧・点列)を選ぶ。同じ道具をもう一度押すと解除になるので、
 * 先に「選択」へ戻してから押す。
 */
export async function chooseSketchTool(page: Page, label: string): Promise<void> {
  await cancelPopoverImpl(page);
  await sketchTool(page, '選択').click();
  await sketchTool(page, label).click();
}

/** 「作図 ▾」の畳んだ一覧から道具を選ぶ。 */
export async function chooseShapeTool(page: Page, label: string): Promise<void> {
  await cancelPopoverImpl(page);
  await sketchTool(page, '選択').click();
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').first().click();
  await page.locator('.pcad-menu__panel[aria-label="作図"]').getByRole('button', { name: label, exact: true }).click();
}

/** 「作図 ▾」の一覧を開いたまま(選ばずに)返す。撮影用。 */
export async function openShapeMenu(page: Page): Promise<Locator> {
  await cancelPopoverImpl(page);
  await sketchTool(page, '選択').click();
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').first().click();
  const panel = page.locator('.pcad-menu__panel[aria-label="作図"]');
  await expect(panel).toBeVisible();
  return panel;
}

/** 「編集 ▾」の畳んだ一覧から道具を選ぶ。「編集」はスケッチ区画の2つ目の▾ボタン。 */
export async function chooseEditTool(page: Page, label: string): Promise<void> {
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').nth(1).click();
  await page.locator('.pcad-menu__panel[aria-label="編集"]').getByRole('button', { name: label, exact: true }).click();
}

/** 欄の下に出ている赤い理由。 */
export function popoverErrors(page: Page): Locator {
  return page.locator('.pcad-popover .pcad-field__message--error');
}

/** その場入力の「決定」(Enterの相手が無い段)。 */
export async function commitByButton(page: Page): Promise<void> {
  await popover(page).getByRole('button', { name: '決定', exact: true }).click();
}

export function popoverInputsCount(page: Page): Promise<number> {
  return popoverInputs(page).count();
}

// ---------------------------------------------------------------------------
// 拘束(constraints.md)の撮影で使う補助。`e2e/tests/p4b-constraints.spec.ts` の
// 同名の関数と同じ作りをここへ1か所にまとめたもの。
// ---------------------------------------------------------------------------

/** 線分を1本、始点・終点(世界座標)を指定してかく。 */
export async function drawLine(page: Page, from: readonly [string, string], to: readonly [string, string]): Promise<void> {
  await chooseSketchTool(page, '線分');
  await expect(page.locator('.pcad-popover__title')).toHaveText('線分の始点');
  await fillFields(page, [from[0], from[1], '0']);
  await commitPopover(page);
  await expect(page.locator('.pcad-popover__title')).toHaveText('線分の終点');
  await useAbsolute(page);
  await fillFields(page, [to[0], to[1], '0']);
  await commitPopover(page);
  await cancelPopoverImpl(page);
}

/** ツールバーの「拘束 ▾」の畳んだ一覧から1種類を押す(「スケッチ」区画の3つ目の▾)。 */
export async function chooseConstraint(page: Page, label: string): Promise<void> {
  await page.getByRole('group', { name: 'スケッチ' }).locator('.pcad-menu__trigger').nth(2).click();
  await page.locator('.pcad-menu__panel[aria-label="拘束"]').getByRole('button', { name: label, exact: true }).click({ force: true });
}

/** 拘束の値を聞くポップアップ(距離・角度・半径・直径)。 */
export function constraintValueDialog(page: Page): Locator {
  return page.locator('.pcad-popover--constraint');
}

/** 拘束の値を聞くポップアップを、既定値のまま(またはsourceを打って)決定する。 */
export async function commitConstraintValue(page: Page, source: string | null = null): Promise<void> {
  const dialog = constraintValueDialog(page);
  await expect(dialog).toBeVisible();
  if (source !== null) await dialog.locator('input.pcad-field__input').fill(source);
  await dialog.getByRole('button', { name: '決定', exact: true }).click();
}

/** 拘束の一覧(プロパティ区画)の1行。 */
export function constraintRow(page: Page, label: string): Locator {
  return page.locator('.pcad-panel--right').locator('.pcad-constraint-row').filter({ hasText: label });
}

/** 拘束の一覧全体。 */
export function constraintList(page: Page): Locator {
  return page.locator('.pcad-panel--right').locator('.pcad-constraint-row');
}

/** 下端のステータスバーの1文。 */
export function statusText(page: Page): Locator {
  return page.locator('.pcad-statusbar__text');
}

// ---------------------------------------------------------------------------
// 吸着(snap.md・tracking.md)の撮影で使う補助。
// ---------------------------------------------------------------------------

/** 「吸着」の畳んだ一覧(種別・角度の刻み)を開いたまま返す。撮影用。 */
export async function openSnapKindsMenu(page: Page): Promise<Locator> {
  await page.getByRole('group', { name: '吸着' }).locator('.pcad-menu__trigger').click();
  const panel = page.locator('.pcad-menu__panel[aria-label="吸着の種別"]');
  await expect(panel).toBeVisible();
  return panel;
}

// ---------------------------------------------------------------------------
// コマンドの欄(command-line.md)の撮影で使う補助。`p4b-command-line.spec.ts` の
// 同名の関数と同じ作り。
// ---------------------------------------------------------------------------

/** コマンドラインの欄(`CommandLine.tsx`)。ステータスバーの左に1つだけある。 */
export function commandLineInput(page: Page): Locator {
  return page.locator('#pcad-command-line-input');
}

/** 打ってEnter(マウス操作なし)。 */
export async function typeCommand(page: Page, text: string): Promise<void> {
  const input = commandLineInput(page);
  await input.click();
  await input.fill(text);
  await input.press('Enter');
}

/** コマンドラインの候補一覧。 */
export function commandLineSuggestions(page: Page): Locator {
  return page.locator('.pcad-commandline__suggestions');
}

/** 矩形を1つかく(対角の2点を相対で入れる。sketch-extended.spec.tsのdrawRectangleと同じ)。 */
export async function drawRectangle(page: Page, corner1: readonly [string, string], corner2: readonly [string, string]): Promise<void> {
  await chooseShapeTool(page, '矩形');
  await expect(page.locator('.pcad-popover__title')).toHaveText('矩形の 1 つ目の角');
  await fillFields(page, [corner1[0], corner1[1]]);
  await commitPopover(page);
  await expect(page.locator('.pcad-popover__title')).toHaveText('矩形の 2 つ目の角');
  await fillFields(page, [corner2[0], corner2[1]]);
  await commitPopover(page);
}
