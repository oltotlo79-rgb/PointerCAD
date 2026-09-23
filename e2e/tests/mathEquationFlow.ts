import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

export async function mathEquationFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('方程式から選んだ値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const expectResult = expect.configure({ timeout: 225_000 });
  await input.fill('solve(1/x>0,x,ℝ)');
  await expectResult(result.locator(':scope > p')).toHaveText([
    '解集合: (0, ∞)',
    '指定範囲: ℝ。有限個の解から使うものをsolution(...,番号)で選びます。番号は1から、実部、次に虚部の小さい順です。',
  ]);
  await expect(apply).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-equation', dialog, script: new URL(import.meta.url),
    fixture: { source: 'solve(1/x>0,x,ℝ)', expectedDomain: 'positive-real-open-at-zero', angleUnit: 'degree' } });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [source, heading] of [
    ['solve(x/x=1,x,ℝ)', '解集合: (-∞, 0) ∪ (0, ∞)'],
    ['solve(x=x,x,ℝ)', '解集合: ℝ'],
    ['solve(sqrt(x)=-1,x,ℝ)', '指定した範囲に解はありません。'],
  ] as const) {
    await input.fill(source); await expectResult(result.locator(':scope > p').first()).toHaveText(heading);
    await expect(apply).toBeDisabled();
  }
  for (const [source, expected] of [
    ['solution(solve(x^2=4,x,ℝ),1)', '= -2'],
    ['component(polynomialroots((x-1)^2*(x+2),x,ℂ),2,2)', '= 2'],
    ['im(solution(solve(x^2=-1,x,ℂ),1))', '= -1'],
  ] as const) {
    await input.fill(source); await expectResult(result).toHaveText(expected); await expect(apply).toBeEnabled();
  }
  const source = 'solution(solve(x^2=4,x,ℝ),2)', changed = 'solution(solve(x^2=9,x,ℝ),2)';
  await input.fill(source); await expectResult(result).toHaveText('= 2');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 2');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("方程式から選んだ値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 2');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'equation.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '方程式から選んだ値')?.value).toMatchObject({ source, mathDefinition: { source }, value: 2 });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBe(2);
  await reopenPart(page, info, 'equation.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 2');
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('方程式・不等式の解を選んで使う');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= 3'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'equation-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBe(3);
  expect(edited.parameters.find(parameter => parameter.name === '方程式から選んだ値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'equation-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBe(2);
  expect(undone.parameters.find(parameter => parameter.name === '方程式から選んだ値')?.value.source).toBe(source);
}
