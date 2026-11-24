import { expect, type Page } from '@playwright/test';
import { goHome } from './boltedJointTestSupport.js';
import { clickWorldPoint } from './homeViewProjection.js';
import { extrudeFace } from './sketchFinishCaptureSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { chooseSheet, rectangleFace, tree, volume } from './sheetUiFlow.js';

const historyButton = (page: Page, name: '元に戻す' | 'やり直す') => page.getByRole('button', { name, exact: true });

export async function openConvertTool(page: Page, source: string) {
  await tree(page, source).click();
  await chooseSheet(page, '板金へ変換');
  const form = page.getByRole('form', { name: '板金へ変換', exact: true });
  await expect(form.getByRole('status').first()).toHaveText('板金に変える立体の、板の表か裏の平らな面を選んでください。');
  return form;
}

/**
 * M-08 立体を板金へ変える。50×30 の面を 2 押し出した板の上の面(z = 2)を基準に選び、計算部が板金として読めた時だけ
 * 履歴に「板金へ変換1」が入り、元の押し出しを消費して体積 3000 の板金になる事を確かめる。
 * 画面の作り: 窓の名前と案内(packages/ui/src/sheetMetal/SheetConvertPanel.tsx の form の aria-label と最初の role="status")、
 * 欄の名前(SHEET_FIELD_DEFINITIONS.sheetRadius の「内半径」)、作成の釦(sheetMetal.create)。メニューは sheetMetalMenuItems.ts の sheetConvert。
 */
export async function convertExtrudedPlate(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await rectangleFace(page);
  await extrudeFace(page, '面1', '2');
  await tree(page, '押し出し1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000, 5);
  const form = await openConvertTool(page, '押し出し1');
  await clickWorldPoint(page, [25, 15, 2]);
  await expect(form.getByRole('status').first()).toHaveText('元の立体: 押し出し1');
  await form.getByRole('textbox', { name: /^内半径/ }).fill('3');
  await form.getByRole('button', { name: '作成', exact: true }).click();
  await expect(tree(page, '板金へ変換1')).toBeVisible({ timeout: 60_000 });
  await tree(page, '板金へ変換1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000, 5);
}

/**
 * 取り消すと変換の行が消えて元の押し出しが戻り、やり直すと変換の行が戻る。
 * 展開を表示すると固定面を部品に保存して取り消しが 1 段増える(sheetUnfoldActions.ts の applyDocument。既存の決まり)ので、展開の前に確かめる。
 */
export async function undoRedoConvert(page: Page): Promise<void> {
  const undo = await beginRecompute(page);
  await historyButton(page, '元に戻す').click();
  await waitForRecompute(page, undo);
  await expect(tree(page, '板金へ変換1')).toHaveCount(0);
  await tree(page, '押し出し1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000, 5);
  const redo = await beginRecompute(page);
  await historyButton(page, 'やり直す').click();
  await waitForRecompute(page, redo);
  await expect(tree(page, '板金へ変換1')).toBeVisible({ timeout: 60_000 });
  await tree(page, '板金へ変換1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(3000, 5);
}

/** 変換した板金を展開の元にできる(model sheetMetal/sheetUnfoldDefinition.ts の種類の判定)。平板 1 枚なので展開の体積も 3000。 */
export async function unfoldConvertedPlate(page: Page): Promise<void> {
  await chooseSheet(page, '板金の展開');
  const unfold = page.getByRole('form', { name: '板金の展開', exact: true });
  await unfold.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(unfold.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });
  await expect.poll(async () => Number(await unfold.getByRole('status').getAttribute('title')), { timeout: 60_000 }).toBeCloseTo(3000, 4);
  await unfold.getByRole('button', { name: '閉じる', exact: true }).click();
}

/**
 * 変換した板金の手前の長い縁(基準の面 z = 2 の y = 0 の縁)へ、長さ 20・90 度のフランジを足す。内半径は変換の行の 3、
 * K 係数は 0.4 なので、体積は 3000 + 2000 + 200π(帯は (5² − 3²)·π/4·50)。縁は画面で押して選ぶ(SheetMetalPanel.tsx の
 * 選んだ辺 → pickSheetBoundary)。変換した板金がフランジの対象に出て確定できるのは、板金の窓の確かめが再計算と同じ認識の答えで解くため。
 */
export async function addFlangeToConvertedPlate(page: Page): Promise<void> {
  await chooseSheet(page, 'フランジ');
  const flange = page.getByRole('form', { name: 'フランジ', exact: true });
  // 押す場所はホーム視点の式で計算する(展開の表示の後でも視点をそろえる)。
  await goHome(page);
  await clickWorldPoint(page, [25, 0, 2]);
  await expect(flange.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await flange.getByRole('textbox', { name: /^フランジの長さ/ }).fill('20');
  await flange.getByRole('button', { name: '作成', exact: true }).click();
  await expect(tree(page, 'フランジ1')).toBeVisible({ timeout: 60_000 });
  await tree(page, 'フランジ1').click();
  await expect.poll(() => volume(page), { timeout: 60_000 }).toBeCloseTo(5000 + 200 * Math.PI, 4);
}

/** フランジを足した板金を展開する。展開の体積は 3000 + 2000 + 曲げ代 1.9π·50·2 = 5000 + 190π。窓は開いたまま(DXF を書き出すため)。 */
export async function unfoldConvertedFlange(page: Page): Promise<void> {
  await chooseSheet(page, '板金の展開');
  const unfold = page.getByRole('form', { name: '板金の展開', exact: true });
  await unfold.getByRole('button', { name: '展開を表示', exact: true }).click();
  await expect(unfold.getByRole('status')).toContainText('展開を表示中', { timeout: 60_000 });
  await expect.poll(async () => Number(await unfold.getByRole('status').getAttribute('title')), { timeout: 60_000 })
    .toBeCloseTo(5000 + 190 * Math.PI, 4);
}
