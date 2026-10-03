/// <reference lib="dom" />
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForSettledRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  clickWorldPoint, commitPopover, fillFields, popover, popoverInputs, popoverTitle, propertyPanel, selectionKindLabel,
  treeRow,
} from './solidCaptureSupport.js';
import { uiMessage } from './uiMessages.js';

/**
 * 「ねじ穴をあける」章の「外ねじ(おねじ)を作る」の1枚(`packages/help-content/docs/ja/thread.md`)。
 *
 * thread-shaft: M6用の円柱(章の例と同じ半径3mm・高さ20mm、底面の中心が原点、軸は+Z)の丸い側面を
 * 選び、「加工」の「外ねじ」で開いた「外ねじの大きさ」の入力欄。呼びは既定のM6、ねじの種類は並目、
 * ピッチはM6並目の1mm、長さは式`30/2`(15mm)、切り始める端は手前の端。
 *
 * 呼びを選び直すとピッチの欄へ規格の値が入る動き(章の手順3)は `threadShaftDesignationFlow` が
 * 確かめる(v1.0.1 では欄が変わらなかった。v1.0.2 で直した)。撮る画面は章の例どおり M6 のまま。
 *
 * 面の選び方は `threadCaptureFlow.ts`(ねじ穴)と同じく、押せない道具を押して選ぶものを「面」へ
 * 切り替えてから3Dで面を押す。押す点はホーム視点で手前に見える側面の中ほど(方位-45度・高さ軸の半分)。
 */
const SHAFT_RADIUS_MM = 3, SHAFT_HEIGHT_MM = 20;
const SIDE_ANGLE = -Math.PI / 4;
const statusText = (page: Page): Locator => page.locator('.pcad-statusbar__text');

/**
 * 円柱を置き、その丸い側面を選んで「外ねじの大きさ」の窓を開くまで。窓が開いた後の状態欄が
 * 「面を選ぶ」案内のままでなく、窓で決める案内になることも確かめる(FR-905)。
 * 面を選ぶ前に押した直後の状態欄は、押せない理由の断り(「ねじを切れるのは丸い軸の面だけです。」)。
 */
async function openThreadShaftWindow(page: Page, info: TestInfo, radiusMm: number, heightMm: number): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 軸になる円柱を置く(`primitiveCaptureFlow.ts` の箱と同じ置き方)。
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '円柱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('円柱を置く');
  await fillFields(page, [String(radiusMm), String(heightMm)]);
  await commitPopover(page);
  // 既定値のままのEnterで閉じない実装もあるため、残っていたらEscで閉じる(`primitiveCaptureFlow.ts` と同じ確認)。
  if (await popover(page).count() > 0) await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, '円柱1')).toBeVisible();
  // 円柱の計算部呼び出しが終わってから3Dの面を拾う(`threadCaptureFlow.ts` と同じ理由)。
  await waitForSettledRecompute(page);

  // 側面を選ぶ前に押すと、選ぶものが「面」に切り替わり、状態欄が対象を案内する。
  await openToolMenu(page, '加工');
  const machining = toolMenuPanel(page, '加工');
  const shaftButton = machining.getByRole('button', { name: '外ねじ', exact: true });
  await expect(shaftButton).toBeDisabled();
  await shaftButton.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  // 押せない道具を押した直後の帯は、押せない理由の断り(NFR-UX-5。ねじ穴・穴の `solid.spec.ts` と同じ)。
  await expect(statusText(page)).toHaveText(`${uiMessage('statusBar', 'statusBar.solidError')} ${
    uiMessage('sketch', 'shapeError.notCylinderFace')}`);

  await clickWorldPoint(page, [radiusMm * Math.cos(SIDE_ANGLE), radiusMm * Math.sin(SIDE_ANGLE), heightMm / 2]);
  await openToolMenu(page, '加工');
  await expect(shaftButton).toBeEnabled();
  await shaftButton.click();
  await expect(popoverTitle(page)).toHaveText('外ねじの大きさ');
  // 窓が開いたら、案内は「面を選ぶ」のままにせず、窓で決めることを伝える(FR-905)。
  await expect(statusText(page)).toHaveText(uiMessage('statusBar', 'statusBar.guide.threadShaftSize'));
}

function windowChoice(page: Page, label: string): Locator {
  return popover(page).locator('.pcad-popover__choice').filter({ hasText: label });
}

/** 窓の「呼び」の一覧を開いて選ぶ(一覧はボタンで開く、`NumericInputPopover.tsx` の ChoiceGroup)。 */
async function chooseDesignation(page: Page, designation: string): Promise<void> {
  const menu = windowChoice(page, '呼び');
  await menu.locator('.pcad-menu__trigger').click();
  await menu.getByRole('menuitem', { name: designation, exact: true }).click();
  await expect(menu.locator('.pcad-menu__count')).toHaveText(designation);
}

export async function threadShaftCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await openThreadShaftWindow(page, info, SHAFT_RADIUS_MM, SHAFT_HEIGHT_MM);

  // 呼びは軸の太さ(直径6mm)に合うM6、ねじの種類は並目、ピッチはM6並目の1mm。
  const designation = windowChoice(page, '呼び');
  await expect(designation.locator('.pcad-menu__count')).toHaveText('M6');
  await expect(windowChoice(page, 'ねじの種類')
    .getByRole('button', { name: '並目', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(popoverInputs(page).nth(0)).toHaveValue('1');
  // 長さは式で入れられる。欄の下に計算した値が出る。
  await fillFields(page, [null, '30/2']);
  await expect(popover(page).getByText('= 15', { exact: true })).toBeVisible();
  await expect(popover(page).getByRole('button', { name: '手前の端', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await popoverInputs(page).nth(1).focus();
  await captureManualDetail(page, info, {
    name: 'thread-shaft', dialog: popover(page),
    fixture: { shaft: { kind: 'cylinder', radius: SHAFT_RADIUS_MM, height: SHAFT_HEIGHT_MM }, size: 'M6', series: 'coarse',
      pitch: 1, length: '30/2', fromEnd: 'first' },
    script: new URL(import.meta.url),
  });

  // 決定すると左の一覧に「外ねじ1」が足され、プロパティで同じ値を確かめられる。
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, '外ねじ1')).toBeVisible();
  await waitForSettledRecompute(page);
}

/** M20 の軸(半径10mm)。長さ20mmのねじが収まる高さにする。 */
const M20_RADIUS_MM = 10, M20_HEIGHT_MM = 40;

/**
 * 窓で呼びを M6 から M20 へ選び直すと、ピッチの欄に M20 並目の 2.5 が入り、細目に替えると 1.5、
 * 並目へ戻すと 2.5 に戻る(章 thread.md の手順3「選ぶと「ピッチ」に規格の値が入ります」)。
 * そのまま決めると、作られた外ねじのプロパティの呼びは M20、ピッチは 2.5(欄の 1 が残らない)。
 * 値は JIS B 0205 の表(model の `METRIC_THREADS`)と同じ。
 */
export async function threadShaftDesignationFlow(page: Page, info: TestInfo): Promise<void> {
  await openThreadShaftWindow(page, info, M20_RADIUS_MM, M20_HEIGHT_MM);
  const pitch = popoverInputs(page).nth(0);
  await expect(pitch).toHaveValue('1');

  await chooseDesignation(page, 'M20');
  await expect(pitch).toHaveValue('2.5');
  const series = windowChoice(page, 'ねじの種類');
  await series.getByRole('button', { name: '細目', exact: true }).click();
  await expect(pitch).toHaveValue('1.5');
  await series.getByRole('button', { name: '並目', exact: true }).click();
  await expect(pitch).toHaveValue('2.5');
  // 呼び・種類を選んでいる間も、案内は窓で決めることを伝えたまま。
  await expect(statusText(page)).toHaveText(uiMessage('statusBar', 'statusBar.guide.threadShaftSize'));

  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, '外ねじ1')).toBeVisible();
  await waitForSettledRecompute(page);
  await treeRow(page, '外ねじ1').click();
  const pitchProperty = propertyPanel(page).locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: /^ピッチ$/u }) })
    .locator('input.pcad-field__input');
  await expect(pitchProperty).toHaveValue('2.5');
  await expect(propertyPanel(page).locator('.pcad-choice')
    .filter({ has: page.locator('.pcad-choice__label', { hasText: /^呼び$/u }) })
    .locator('.pcad-menu__count')).toHaveText('M20');
}
