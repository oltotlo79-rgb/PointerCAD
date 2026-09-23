import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

export async function mathDifferentialEquationFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('微分方程式から求めた値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const expectResult = expect.configure({ timeout: 225_000 });
  const problem = 'odesolve([y″=0],x,[y],[[y,0,2],[y,2,6]])';
  await input.fill(problem);
  await expectResult(result.locator(':scope > p').first()).toHaveText('微分方程式の確認できた解候補（全ての解とは限りません）');
  await expect(result).toContainText('y(x) ='); await expect(result).toContainText('指定が必要な積分定数: なし');
  await expect(apply).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-differential-equations', dialog, script: new URL(import.meta.url),
    fixture: { source: problem, expectedSolution: '2*x+2', initialConditions: [[0, 2], [2, 6]], angleUnit: 'degree' } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await input.fill('odesolve([dy/dx=2],x,[y],[])');
  await expectResult(result).toContainText('指定が必要な積分定数: C1'); await expect(apply).toBeDisabled();
  for (const source of [
    'odeat(odesolve([diff(y,x)=2],x,[y],[]),1,[],3)',
    'odeat(odesolve([diff(y,x)+0*(1/x)=1],x,[y],[[y,1,2]]),1,[],0)',
    'odesolve([diff(y,x)=1],x,[y],[[y,0,0],[y,0,1]])',
  ]) {
    await input.fill(source); await expectResult(result).toHaveClass(/pcad-math-editor__result--error/u);
    await expect(apply).toBeDisabled();
  }
  const source = 'component(odeat(' + problem + ',1,[],1),1)', changed = source.replace('[y,2,6]', '[y,2,10]');
  await input.fill(source); await expectResult(result).toHaveText('= 4');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 4');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("微分方程式から求めた値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 4');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'differential-equations.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '微分方程式から求めた値')?.value).toMatchObject({ source, mathDefinition: { source }, value: 4 });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBe(4);
  await reopenPart(page, info, 'differential-equations.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 4');
  await page.keyboard.press('F1'); await expect(page.locator('.pcad-help__article')).toContainText('微分方程式の条件と解候補を確認する');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= 6'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'differential-equations-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBe(6);
  expect(edited.parameters.find(parameter => parameter.name === '微分方程式から求めた値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'differential-equations-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBe(4);
  expect(undone.parameters.find(parameter => parameter.name === '微分方程式から求めた値')?.value.source).toBe(source);
}
