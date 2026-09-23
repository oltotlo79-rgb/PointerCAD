import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

/** Gamma/Beta distribution parameters and source identity survive the ordinary document flow. */
export async function mathGammaBetaDistributionFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('Gamma・Beta分布の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  for (const [source, message] of [['gammapdf(0,1,1)', '形状と尺度は0より大きく'],
    ['gammaquantile(1,2,1)', '0以上1未満'], ['betapdf(1/2,2,0)', '確率密度は無限大'],
    ['betaquantile(2,3,2)', '確率は0以上1以下']] as const) {
    await input.fill(source); await expect(result).toContainText(message); await expect(apply).toBeDisabled();
  }
  for (const [formula, value] of [['gammapdf(2,1,1)', '0.367879441'], ['gammacdf(2,1,1)', '0.264241117'],
    ['gammaquantile(1,2,0.5)', '1.386294361'], ['betapdf(2,2,0.5)', '1.5'],
    ['betacdf(2,3,0.5)', '0.6875'], ['betaquantile(1/2,1/2,0.25)', '0.146446609']] as const) {
    await input.fill(formula); await expect(result).toContainText(value);
  }
  const source = '6*betaquantile(2,2,1/2)', changed = '12*betaquantile(2,2,1/2)';
  await input.fill(source); await expect(result).toHaveText('= 3');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '統計' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('Beta分布');
  await expect(dialog.getByRole('button', { name: /Beta分布の分位点/u })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 3');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-gamma-beta-distributions', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: 3, shapeA: 2, shapeB: 2, multiplier: 6, probability: '1/2' } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("Gamma・Beta分布の値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expect(result).toHaveText('= 3');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'gamma-beta-distributions.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === 'Gamma・Beta分布の値')?.value).toMatchObject({ value: 3, source, mathDefinition: { source } });
  expect(saved.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 3, source: coordinate } } });
  await reopenPart(page, info, 'gamma-beta-distributions.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expect(result).toHaveText('= 3');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('Gamma・Beta分布の確率と位置を求める');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expect(result).toHaveText('= 6'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'gamma-beta-distributions-edited.pcad', app);
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 6, source: coordinate } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'gamma-beta-distributions-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === 'Gamma・Beta分布の値')?.value).toMatchObject({ value: 3, source });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 3, source: coordinate } } });
}
