import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

/** Real Legendre integrals and periods, original source and document edits. */
export async function mathEllipticFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('楕円積分の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  for (const [source, reason] of [
    ['elliptick(1)', '完全楕円積分の実数の範囲では母数mを1未満にしてください。第二種は1も使えます。'],
    ['ellipticpi(1,0.5)', '完全な第三種楕円積分はnが1以上で発散します。主値へは置き換えません。'],
    ['ellipticf(180,2)', '積分する途中の発散や実数でない範囲を越えることはできません。'],
    ['ellipticpiinc(2,180,0.5)', '積分する途中の発散や実数でない範囲を越えることはできません。'],
    ['elliptice([0])', '楕円積分の引数は一つずつ実数の式で指定してください。'],
    ['0*elliptick(1)', '完全楕円積分の実数の範囲では母数mを1未満にしてください。第二種は1も使えます。'],
  ] as const) {
    await input.fill(source); await expect(result).toHaveText(reason, { timeout: 15_000 });
    await expect(apply).toBeDisabled();
  }
  for (const [formula, value] of [['elliptick(0)', '= 1.570796326'], ['elliptice(1)', '= 1'],
    ['ellipticf(90,0)', '= 1.570796326'], ['ellipticeinc(90,1)', '= 1'],
    ['ellipticpi(0,0)', '= 1.570796326'], ['ellipticpiinc(0,90,0)', '= 1.570796326']] as const) {
    await input.fill(formula); await expect(result).toContainText(value); await expect(apply).toBeEnabled();
  }
  await input.fill('ellipticeinc(270,1)'); await expect(result).toHaveText('= 3');
  await input.fill('derivativeat(ellipticf(x,0),x,0,2)');
  await expect(result).toContainText('= 0', { timeout: 225_000 }); await expect(apply).toBeEnabled();
  const source = 'elliptick(0.5)', changed = 'elliptice(0.5)';
  const initialValue = Number('1.8540746773013719184'), changedValue = Number('1.3506438810476755025');
  await input.fill(source); await expect(result).toContainText('1.854074677');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '関数' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('楕円積分');
  await expect(dialog.getByRole('button', { name: '楕円積分 K（完全第1種）', exact: true })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expect(result).toContainText('1.854074677');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-elliptic', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: initialValue, arguments: [0.5] } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("楕円積分の値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expect(result).toContainText('1.854074677');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'elliptic.pcad', app);
  const parameter = saved.parameters.find(parameter => parameter.name === '楕円積分の値');
  expect(parameter?.value).toMatchObject({ source, mathDefinition: { source } });
  expect(parameter?.value.value).toBeCloseTo(initialValue, 14);
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBeCloseTo(initialValue, 14);
  await reopenPart(page, info, 'elliptic.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expect(result).toContainText('1.854074677');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('楕円積分の種類と角度を選ぶ');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expect(result).toContainText('1.350643881'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'elliptic-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBeCloseTo(changedValue, 14);
  expect(edited.parameters.find(parameter => parameter.name === '楕円積分の値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'elliptic-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBeCloseTo(initialValue, 14);
  expect(undone.parameters.find(parameter => parameter.name === '楕円積分の値')?.value.source).toBe(source);
}
