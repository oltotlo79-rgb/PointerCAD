import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

/** Exact coefficient selection retains its expansion, degree and editable document source. */
export async function mathTaylorCoefficientFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('展開の係数'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  // Notation changes and document reopen can prepare a new exact engine too.
  const expectResult = expect.configure({ timeout: 225_000 });
  for (const source of ['seriescoefficient(taylor(abs(x),x,0,3),0)',
    'seriescoefficient(taylor((x-1)/(x-1),x,1,3),0)',
    '0*seriescoefficient(taylor(abs(x),x,0,3),0)', 'seriescoefficient(taylor(x,x,0,3),4)']) {
    await input.fill(source); await expectResult(result).toContainText('式の成立条件または計算結果');
    await expect(apply).toBeDisabled();
  }
  await input.fill('seriescoefficient(taylor(0*2^20000+x,x,0,3),0)');
  await expectResult(result).toContainText('計算量の上限に達しました'); await expect(apply).toBeDisabled();
  for (const [formula, value] of [['seriescoefficient(taylor(x^3,x,2,4),0)', '8'],
    ['seriescoefficient(taylor(x^3,x,2,4),4)', '0'], ['seriescoefficient(maclaurin(1/(1-x),x,4),4)', '1'],
    ['2*seriescoefficient(taylor(x^3,x,2,4),1)+1', '25']] as const) {
    await input.fill(formula); await expectResult(result).toHaveText('= ' + value);
  }
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue('2*seriescoefficient(taylor(x^3,x,2,4),1)+1');
  await expectResult(result).toHaveText('= 25');
  const source = 'seriescoefficient(taylor(x^3,x,2,4),1)',
    changed = 'seriescoefficient(taylor(x^3,x,3,4),1)';
  await input.fill(source); await expectResult(result).toHaveText('= 12');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '数列・総和・総積' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('展開の係数を選ぶ');
  await expect(dialog.getByRole('button', { name: /展開の係数を選ぶ/u })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 12');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-taylor-coefficient', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: 12, center: 2, expansionDegree: 4, selectedDegree: 1 } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("展開の係数")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 12');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'taylor-coefficient.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '展開の係数')?.value).toMatchObject({ value: 12, source, mathDefinition: { source } });
  expect(saved.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 12, source: coordinate } } });
  await reopenPart(page, info, 'taylor-coefficient.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 12');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('展開の係数を座標に使う');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= 27'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'taylor-coefficient-edited.pcad', app);
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 27, source: coordinate } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'taylor-coefficient-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '展開の係数')?.value).toMatchObject({ value: 12, source });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 12, source: coordinate } } });
}
