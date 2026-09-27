import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

/** Integer Bessel input, original domains, immutable source and document edits. */
export async function mathBesselFunctionFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('Besselの値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  for (const [source, reason] of [
    ['besselj(0,1/0)', '0では割れません。'],
    ['besseli(0,[1])', 'Bessel関数の引数は一つの実数の式で指定してください。'],
    ['besselj(0.5,1)', 'この計算ではBessel関数の次数を整数で確定してください。'],
    ['0*bessely(0,0)', 'Bessel関数のYとKには正の実数の引数が必要です。'],
    ['component([7,besselk(0,-1)],1)', 'Bessel関数のYとKには正の実数の引数が必要です。'],
  ] as const) {
    await input.fill(source); await expect(result).toHaveText(reason, { timeout: 15_000 });
    await expect(apply).toBeDisabled();
  }
  await input.fill('besselj(129,1)');
  await expect(result).toContainText('計算量の上限に達しました'); await expect(apply).toBeDisabled();
  for (const [formula, value] of [['besselj(0,1)', '0.765197686'], ['bessely(0,1)', '0.088256964'],
    ['besseli(0,1)', '1.266065877'], ['besselk(0,1)', '0.421024438'], ['besselj(0,0)', '= 1'],
    ['besseli(1,0)', '= 0']] as const) {
    await input.fill(formula); await expect(result).toContainText(value); await expect(apply).toBeEnabled();
  }
  await input.fill('derivativeat(besselj(0,x),x,0,2)');
  await expect(result).toContainText('= -0.5', { timeout: 225_000 });
  await expect(apply).toBeEnabled();
  const source = 'besselj(0,1)', changed = 'besseli(0,1)', initialValue = 0.7651976865579666, changedValue = Number('1.2660658777520083');
  await input.fill(source); await expect(result).toContainText('0.765197686');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '関数' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('Bessel');
  for (const kind of ['J','Y','I','K']) await expect(dialog.getByRole('button', { name: new RegExp('Bessel '+kind, 'u') })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expect(result).toContainText('0.765197686');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-bessel-function', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: initialValue, arguments: [0,1] } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("Besselの値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expect(result).toContainText('0.765197686');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'bessel-function.pcad', app);
  const parameter = saved.parameters.find(parameter => parameter.name === 'Besselの値');
  expect(parameter?.value).toMatchObject({ source, mathDefinition: { source } });
  expect(parameter?.value.value).toBeCloseTo(initialValue, 14);
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBeCloseTo(initialValue, 14);
  await reopenPart(page, info, 'bessel-function.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expect(result).toContainText('0.765197686');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('Bessel関数を数値や作図に使う');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expect(result).toContainText('1.266065877'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'bessel-function-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBeCloseTo(changedValue, 14);
  expect(edited.parameters.find(parameter => parameter.name === 'Besselの値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'bessel-function-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBeCloseTo(initialValue, 14);
  expect(undone.parameters.find(parameter => parameter.name === 'Besselの値')?.value.source).toBe(source);
}
