import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

/** Distribution parameters, support and source identity survive the ordinary document flow. */
export async function mathDistributionsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('分布の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  for (const [source, message] of [['uniformcdf(3,2,-1)', '下端を上端より小さく'],
    ['exponentialcdf(0,-1)', '発生率は0より大きく'], ['poissoncdf(-1,-1)', '平均回数は0以上']] as const) {
    await input.fill(source); await expect(result).toContainText(message); await expect(apply).toBeDisabled();
  }
  for (const [source, value] of [['uniformpdf(2,6,3)', '= 0.25'], ['uniformcdf(2,6,3)', '= 0.25'],
    ['uniformquantile(2,6,1/4)', '= 3'], ['exponentialpdf(2,0)', '= 2'], ['exponentialcdf(2,0)', '= 0'],
    ['exponentialquantile(2,0)', '= 0'], ['poissonpmf(0,0)', '= 1'], ['poissoncdf(0,3)', '= 1']] as const) {
    await input.fill(source); await expect(result).toHaveText(value);
  }
  await input.fill('poissoncdf(2,2)'); await expect(result).toHaveText(/^= 0\.6766764161/u);
  await input.fill('exponentialquantile(2,3/4)'); await expect(result).toHaveText(/^= 0\.6931471805/u);
  const source = 'uniformquantile(2,6,1/4)', changed = 'uniformquantile(2,10,1/4)';
  await input.fill(source); await expect(result).toHaveText('= 3');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '統計' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('一様');
  await expect(dialog.getByRole('button', { name: /一様分布の分位点/u })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 3');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-distributions', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: 3, distribution: 'uniform', lower: 2, upper: 6, probability: '1/4' } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("分布の値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expect(result).toHaveText('= 3');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'distributions.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '分布の値')?.value).toMatchObject({ value: 3, source, mathDefinition: { source } });
  expect(saved.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 3, source: coordinate } } });
  await reopenPart(page, info, 'distributions.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expect(result).toHaveText('= 3');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('一様分布・指数分布・ポアソン分布を使う');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expect(result).toHaveText('= 4'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'distributions-edited.pcad', app);
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 4, source: coordinate } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'distributions-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '分布の値')?.value).toMatchObject({ value: 3, source });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 3, source: coordinate } } });
}
