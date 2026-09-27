import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

/** Real Gamma input, original poles, immutable source and document edits. */
export async function mathGammaFunctionFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('Gammaの値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  for (const [source, reason] of [
    ['gamma(1/0)', '0では割れません。'],
    ['gamma(true)', 'Gamma関数の引数は実数の式で指定してください。'],
    ['gamma([1])', 'Gamma関数の引数は実数の式で指定してください。'],
    ['0*gamma(0)', 'Gamma関数には0と負の整数を指定できません。'],
    ['component([7,gamma(-2)],1)', 'Gamma関数には0と負の整数を指定できません。'],
    ['polygamma(0.5,1)', 'Gamma関数の微分の次数は0から17までの整数で指定してください。'],
  ] as const) {
    await input.fill(source); await expect(result).toHaveText(reason, { timeout: 15_000 });
    await expect(apply).toBeDisabled();
  }
  await input.fill('gamma(20001)');
  await expect(result).toContainText('計算量の上限に達しました'); await expect(apply).toBeDisabled();
  for (const [formula, value] of [['gamma(1)', '= 1'], ['gamma(0.5)', '1.772453850'],
    ['gamma(-0.5)', '-3.544907701'], ['polygamma(1,1)', '1.644934066']] as const) {
    await input.fill(formula); await expect(result).toContainText(value); await expect(apply).toBeEnabled();
  }
  await input.fill('derivativeat(gamma(x),x,1)');
  await expect(result).toContainText('-0.5772156649015328', { timeout: 225_000 });
  await expect(apply).toBeEnabled();
  const source = 'gamma(5)', changed = 'gamma(6)', initialValue = 24, changedValue = 120;
  await input.fill(source); await expect(result).toHaveText('= 24');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '関数' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('Gamma関数');
  await expect(dialog.getByRole('button', { name: /Gamma関数/u })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 24');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-gamma-function', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: initialValue, argument: 5 } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("Gammaの値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expect(result).toContainText('= 24');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'gamma-function.pcad', app);
  const parameter = saved.parameters.find(parameter => parameter.name === 'Gammaの値');
  expect(parameter?.value).toMatchObject({ source, mathDefinition: { source } });
  expect(parameter?.value.value).toBeCloseTo(initialValue, 14);
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBeCloseTo(initialValue, 14);
  await reopenPart(page, info, 'gamma-function.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expect(result).toContainText('= 24');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('Gamma関数と微分した関数を数値や作図に使う');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expect(result).toContainText('= 120'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'gamma-function-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBeCloseTo(changedValue, 14);
  expect(edited.parameters.find(parameter => parameter.name === 'Gammaの値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'gamma-function-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBeCloseTo(initialValue, 14);
  expect(undone.parameters.find(parameter => parameter.name === 'Gammaの値')?.value.source).toBe(source);
}
