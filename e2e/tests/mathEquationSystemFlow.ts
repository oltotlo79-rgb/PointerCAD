import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

export async function mathEquationSystemFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('複数式から選んだ値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const expectResult = expect.configure({ timeout: 225_000 });
  await input.fill('solvesystem([x*y=1],[x,y],ℝ)');
  await expectResult(result.locator(':scope > p')).toHaveText([
    '複数の方程式の解',
    '指定範囲: ℝ。候補 1: x = 1/y, y = y。値を指定する変数の順番: y。成立条件: y ≠ 0\nsystemsolution(...,候補番号,[自由変数の値])で選び、component(...,成分番号)で座標に使う成分を指定します。番号は1からです。有限個の解は未知数の順に実部、次に虚部の小さい順、自由変数がある場合は表示順です。条件を満たさない値は使えません。',
  ]);
  await expect(apply).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-equation-system', dialog, script: new URL(import.meta.url),
    fixture: { source: 'solvesystem([x*y=1],[x,y],ℝ)', expectedDomain: 'real-y-nonzero', angleUnit: 'degree' } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await input.fill('solvesystem([x+y=2,x+y=3],[x,y],ℝ)');
  await expectResult(result.locator(':scope > p').first()).toHaveText('指定した範囲に解はありません。');
  await expect(apply).toBeDisabled();
  for (const source of [
    'systemsolution(solvesystem([x+y=2],[x,y],ℝ),1,[])',
    'systemsolution(solvesystem([x*y=1],[x,y],ℝ),1,[0])',
  ]) {
    await input.fill(source); await expectResult(result).toHaveClass(/pcad-math-editor__result--error/u);
    await expect(apply).toBeDisabled();
  }
  for (const [source, expected] of [
    ['component(systemsolution(solvesystem([x^2=1,y=x],[x,y],ℝ),1,[]),1)', '= -1'],
    ['component(systemsolution(solvesystem([x+y=3,x-y=1],[y,x],ℝ),1,[]),1)', '= 1'],
    ['im(component(systemsolution(solvesystem([x^2=-1,y=x],[x,y],ℂ),1,[]),1))', '= -1'],
  ] as const) {
    await input.fill(source); await expectResult(result).toHaveText(expected); await expect(apply).toBeEnabled();
  }
  const source = 'component(systemsolution(solvesystem([x+y=5],[x,y],ℝ),1,[3]),1)',
    changed = 'component(systemsolution(solvesystem([x+y=5],[x,y],ℝ),1,[2]),1)';
  await input.fill(source); await expectResult(result).toHaveText('= 2');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 2');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("複数式から選んだ値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 2');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'equation-system.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '複数式から選んだ値')?.value).toMatchObject({ source, mathDefinition: { source }, value: 2 });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBe(2);
  await reopenPart(page, info, 'equation-system.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 2');
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('複数の方程式の解と自由な値を使う');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= 3'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'equation-system-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBe(3);
  expect(edited.parameters.find(parameter => parameter.name === '複数式から選んだ値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'equation-system-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBe(2);
  expect(undone.parameters.find(parameter => parameter.name === '複数式から選んだ値')?.value.source).toBe(source);
}
