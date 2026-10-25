/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test';
import {
  cancelPopover, chooseShapeTool, chooseSketchTool, commitPopover, fillFields, pickInPopover, popover,
  popoverInputs, popoverTitle, treeRow, useAbsolute,
} from './sketchDrawCaptureSupport.js';

/**
 * R19「数式候補に単位・参照元・影響数・エラー位置」の実画面検査(Web・Electron共通)。
 *
 * 受入条件(docs/plans/review-2026-10-04-response.md R19):
 * 1) mm・inch・度の3単位で、値・次元・参照元・使用箇所の数が入力中に出る。
 * 2) 板厚=3mm のとき「板厚*2」で = 6 と、板厚の使用先1件が確定前に出る。
 * 3) 誤った単位3例で、欄の近くに理由と文字位置が出る。
 * 4) 日本語入力の変換確定のEnterで入力が確定しない(確定0)。
 * 5) 単位表示を切り替えても欄の式(原式)は1文字も変わらない(原式改変0)。
 * 6) 取消のあと、古い候補が次の入力へ出ない。
 */

function propertyPanel(page: Page): Locator { return page.locator('.pcad-panel--right'); }

function inspection(page: Page): Locator { return popover(page).locator('aside.pcad-expression-inspection'); }

function fieldMessage(page: Page, index: number): Locator {
  return popover(page).locator('.pcad-field').nth(index).locator('.pcad-field__message');
}

async function addParameter(page: Page, row: number, name: string, source: string, unit: string | null): Promise<void> {
  await propertyPanel(page).getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const target = propertyPanel(page).locator('.pcad-parameter').nth(row);
  const nameInput = target.locator('.pcad-field').nth(0).locator('input');
  await nameInput.fill(name); await nameInput.press('Enter');
  const sourceInput = target.locator('.pcad-field').nth(1).locator('input');
  await sourceInput.fill(source); await sourceInput.press('Enter');
  if (unit !== null) {
    await target.getByRole('group', { name: '単位', exact: true }).getByRole('button', { name: unit, exact: true }).click();
  }
  await expect(target.locator('.pcad-field').nth(1).locator('.pcad-field__message')).toContainText(`= ${source}`);
}

async function makeExtrudeUsingThickness(page: Page): Promise<void> {
  await chooseShapeTool(page, '矩形');
  await expect(popoverTitle(page)).toHaveText('矩形の 1 つ目の角');
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('矩形の 2 つ目の角');
  await useAbsolute(page);
  await fillFields(page, ['40', '30', '0']);
  await commitPopover(page);
  await cancelPopover(page);
  await treeRow(page, '矩形1').click();
  await page.getByRole('group', { name: 'スケッチ' }).getByRole('button', { name: '面', exact: true }).click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
  await treeRow(page, '面1').click();
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^作る/ }).first().click();
  await page.getByRole('group', { name: 'ソリッド' }).getByRole('button', { name: '押し出し', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('押し出す');
  await fillFields(page, ['板厚 * 2']);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await expect(treeRow(page, '押し出し1')).toBeVisible({ timeout: 90_000 });
}

/** 点の道具のその場入力を開く(X・Y・Zの3欄)。 */
async function openPointPopover(page: Page): Promise<void> {
  await chooseSketchTool(page, '点');
  await page.locator('canvas.pcad-viewport__canvas').click({ position: { x: 80, y: 90 } });
  await expect(popoverInputs(page)).toHaveCount(3);
}

async function typeInto(page: Page, index: number, source: string): Promise<void> {
  const input = popoverInputs(page).nth(index);
  await input.fill(source);
  await input.focus();
}

export async function expressionInspectionFlow(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });

  // 準備: 板厚=3(mm)・角=30(°)の2つのパラメータと、板厚*2 を使う押し出し1件。
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await addParameter(page, 0, '板厚', '3', null);
  await addParameter(page, 1, '角', '30', '°');
  await page.getByRole('tab', { name: 'プロパティ', exact: true }).click();
  await makeExtrudeUsingThickness(page);

  // 1) mm の欄: 板厚*2 = 6。参照元(位置・値・単位)と使用先1件が、確定の前に出る。
  await openPointPopover(page);
  await typeInto(page, 0, '板厚*2');
  await expect(fieldMessage(page, 0)).toHaveText('= 6');
  await expect(inspection(page)).toContainText('欄の単位: mm');
  await expect(inspection(page)).toContainText('参照するパラメータ');
  await expect(inspection(page).locator('li')).toHaveCount(1);
  await expect(inspection(page).locator('li').first()).toContainText('板厚 (1文字目)：3 mm');
  await expect(inspection(page).locator('li').first()).toContainText('形・数式での使用箇所: 1');
  await expect(inspection(page)).toContainText('影響するフィーチャー数: 1');
  await expect(popoverInputs(page).first()).toHaveAttribute('aria-describedby', /-inspection/u);
  // 取消して開き直しても、古い候補は次の入力へ出ない。
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await openPointPopover(page);
  await expect(inspection(page)).toHaveCount(0);

  // 2) 誤った単位3例。理由は欄の下、文字位置は表示の下。式は直されないまま残る。
  const wrongUnits: readonly (readonly [string, number, string])[] = [
    ['1.5ft', 4, 'f'],
    ['10kg', 3, 'k'],
    ['2in 3', 5, '3'],
  ];
  for (const [source, position, mark] of wrongUnits) {
    await typeInto(page, 0, source);
    await expect(popover(page).locator('.pcad-field__message--error')).toHaveCount(1);
    await expect(inspection(page)).toContainText(`入力中の誤りの位置: ${String(position)}文字目`);
    await expect(inspection(page).locator('mark')).toHaveText(mark);
    await expect(popoverInputs(page).first()).toHaveValue(source);
  }

  // 3) 日本語入力の変換確定のEnter(isComposing・keyCode 229・Process)では確定しない。
  await typeInto(page, 0, '板厚*2');
  await expect(inspection(page)).toBeVisible();
  const input = popoverInputs(page).first();
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'い' }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', isComposing: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', keyCode: 229 }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Process', keyCode: 229 }));
  });
  await expect(popover(page)).toBeVisible();
  await expect(popoverInputs(page)).toHaveCount(3);
  await expect(input).toHaveValue('板厚*2');
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'い' }));
  });
  await expect(popover(page)).toBeVisible();

  // 4) inch の欄: 式の中の単位と欄の単位(in)が出る。表示を切り替えても原式は変わらない。
  await typeInto(page, 0, '1in*2');
  await expect(inspection(page)).toContainText('欄の単位: mm');
  await expect(inspection(page)).toContainText('式に書かれた単位: in');
  await expect(fieldMessage(page, 0)).toHaveText('= 50.8');
  await typeInto(page, 0, '板厚*2');
  const unitButton = page.locator('.pcad-statusbar__unit');
  await expect(unitButton).toHaveText('単位: mm');
  await unitButton.click();
  await expect(unitButton).toHaveText('単位: inch');
  await expect(popover(page)).toBeVisible();
  await expect(popoverInputs(page).first()).toHaveValue('板厚*2');
  await expect(inspection(page)).toContainText('欄の単位: in');
  await expect(inspection(page).locator('li').first()).toContainText('板厚 (1文字目)：3 mm');
  await expect(inspection(page).locator('li').first()).toContainText('形・数式での使用箇所: 1');
  await expect(inspection(page)).toContainText('影響するフィーチャー数: 1');
  await typeInto(page, 0, '1.5ft');
  await expect(inspection(page)).toContainText('入力中の誤りの位置: 4文字目');
  await expect(inspection(page).locator('mark')).toHaveText('f');
  await expect(popoverInputs(page).first()).toHaveValue('1.5ft');
  await typeInto(page, 0, '板厚*2');
  await unitButton.click();
  await expect(unitButton).toHaveText('単位: mm');
  await expect(popoverInputs(page).first()).toHaveValue('板厚*2');
  await popoverInputs(page).first().press('Escape');
  await expect(popover(page)).toHaveCount(0);

  // 度の使用先を作る: 押し出し1の「側面の傾き」(度の欄)へ 角 を書いて決める。
  await treeRow(page, '押し出し1').click();
  const draft = propertyPanel(page).locator('.pcad-field').filter({ hasText: '側面の傾き' }).locator('input');
  await draft.fill('角');
  await draft.press('Enter');
  await expect(draft).toHaveValue('角');
  await expect(propertyPanel(page).locator('.pcad-field').filter({ hasText: '側面の傾き' }).locator('.pcad-field__message'))
    .toHaveText('= 30');

  // 5) 度の欄: 線分の終点を「極」にして角度の欄へ 角*2 = 60 を入れる。角は押し出し1の側面の傾きが使う(使用先1件)。
  await chooseSketchTool(page, '線分');
  await expect(popoverTitle(page)).toHaveText('線分の始点');
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);
  await expect(popoverTitle(page)).toHaveText('線分の終点');
  await useAbsolute(page);
  await pickInPopover(page, '極');
  await typeInto(page, 1, '角*2');
  await expect(fieldMessage(page, 1)).toHaveText('= 60');
  await expect(inspection(page)).toContainText('欄の単位: °');
  await expect(inspection(page).locator('li')).toHaveCount(1);
  await expect(inspection(page).locator('li').first()).toContainText('角 (1文字目)：30°');
  await expect(inspection(page).locator('li').first()).toContainText('形・数式での使用箇所: 1');
  await expect(inspection(page)).toContainText('影響するフィーチャー数: 1');
  await typeInto(page, 1, '30deg deg');
  await expect(popover(page).locator('.pcad-field__message--error')).toHaveCount(1);
  await typeInto(page, 1, '角*2');
  await popoverInputs(page).nth(1).press('Escape');
  await expect(popover(page)).toHaveCount(0);

  // 保存済みの原式は表示の切替でも変わらず、押し出しの距離は板厚*2のまま。
  await treeRow(page, '押し出し1').click();
  await expect(propertyPanel(page).locator('.pcad-field').filter({ hasText: '距離' }).locator('input'))
    .toHaveValue('板厚 * 2');
}
