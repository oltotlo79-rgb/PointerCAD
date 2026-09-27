import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

export async function mathIntegralTransformsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('連続変換の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const expectResult = expect.configure({ timeout: 225_000 });
  await input.fill('laplace(exp(-x),x,s)');
  await expectResult(result).toContainText('変換結果 F(s) = 1/(1 + s)');
  await expect(dialog).toContainText('成立範囲: re(s) > -1。');
  await expect(apply).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-integral-transforms', dialog, script: new URL(import.meta.url),
    fixture: { source: 'laplace(exp(-x),x,s)', expectedFormula: '1/(s+1)', expectedRegion: 'Re(s)>-1', angleUnit: 'degree' } });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const source of ['transformat(laplace(exp(-x),x,s),-1)',
    'transformat(inverselaplace(1/x,x,t),0)', 'transformat(ztransform((1/2)^n,n,z),1/2)',
    '0*transformat(laplace(1/0,x,s),1)']) {
    await input.fill(source);
    await expectResult(result).toHaveText('式の成立条件または計算結果を確認してください。');
    await expect(apply).toBeDisabled();
  }
  for (const [source, expected] of [
    ['transformat(fourier(exp(-pi*x^2),x,k),0)', '= 1'],
    ['transformat(inversefourier(exp(-pi*x^2),x,t),0)', '= 1'],
    ['transformat(laplace(exp(-x),x,s),1)', '= 0.5'],
    ['transformat(inverselaplace(1/x,x,t),1)', '= 1'],
    ['transformat(ztransform((1/2)^n,n,z),1)', '= 2'],
  ] as const) {
    await input.fill(source); await expectResult(result).toHaveText(expected); await expect(apply).toBeEnabled();
  }
  const source = 'transformat(laplace(exp(-x),x,s),1)', changed = 'transformat(laplace(exp(-x),x,s),3)';
  await input.fill(source); await expectResult(result).toHaveText('= 0.5');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 0.5');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("連続変換の値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 0.5');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'integral-transforms.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '連続変換の値')?.value).toMatchObject({ source, mathDefinition: { source }, value: 0.5 });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBe(0.5);
  await reopenPart(page, info, 'integral-transforms.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 0.5');
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('連続変換の式と成立範囲を確認する');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= 0.25'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'integral-transforms-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBe(0.25);
  expect(edited.parameters.find(parameter => parameter.name === '連続変換の値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'integral-transforms-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBe(0.5);
  expect(undone.parameters.find(parameter => parameter.name === '連続変換の値')?.value.source).toBe(source);
}
