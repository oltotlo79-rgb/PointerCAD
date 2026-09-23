import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';
import { uiMessage } from './uiMessages.js';

/** Declared joint laws and source identity survive the ordinary document flow. */
export async function mathGeneralProbabilityFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('確率変数の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  // Notation changes and document reopen can prepare a new exact engine too.
  const expectResult = expect.configure({ timeout: 225_000 });
  for (const source of ['randomexpectation(x,[x],normaldistribution(0,-1))',
    'givenprobability(x>0,x=0,[x],normaldistribution(0,1))',
    'randomcorrelation(x,x,[x],finitedistribution([1],[1]))']) {
    await input.fill(source); await expectResult(result).toContainText('式の成立条件または計算結果'); await expect(apply).toBeDisabled();
  }
  for (const [formula, value] of [['probability(x>0,[x],normaldistribution(0,1))', '0.5'],
    ['givenprobability(x>2,x>0,[x],uniformdistribution(0,4))', '0.5'],
    ['randomvariance(x,[x],normaldistribution(3,2))', '4'],
    ['randomcovariance(x,2*x,[x],normaldistribution(1,3))', '18'],
    ['randomcorrelation(x,-2*x,[x],uniformdistribution(-1,1))', '-1'],
    ['randomexpectation(x+y,[x,y],jointfinitedistribution([[0,0],[2,2]],[1/4,3/4]))', '3']] as const) {
    await input.fill(formula); await expectResult(result).toHaveText('= ' + value);
  }
  const source = 'randomexpectation(x,[x],normaldistribution(3,2))', changed = 'randomexpectation(x,[x],normaldistribution(6,2))';
  for (const [formula, truth] of [['independentevents(x>1,x<3,[x],uniformdistribution(0,4))', 'false'],
    ['independentvariables(x,y,[x,y],independentdistributions([normaldistribution(0,1),normaldistribution(0,1)]))', 'true']] as const) {
    await input.fill(formula); await expectResult(result).toHaveText(uiMessage('math', `math.boolean.${truth}`));
    await expect(apply).toBeDisabled();
  }
  await input.fill(source); await expectResult(result).toHaveText('= 3');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '統計' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('確率変数の期待値');
  await expect(dialog.getByRole('button', { name: /確率変数の期待値/u })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 3');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-general-probability', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: 3, mean: 3, standardDeviation: 2 } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("確率変数の値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 3');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'general-probability.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '確率変数の値')?.value).toMatchObject({ value: 3, source, mathDefinition: { source } });
  expect(saved.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 3, source: coordinate } } });
  await reopenPart(page, info, 'general-probability.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 3');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('分布を宣言して事象と確率変数を計算する');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= 6'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'general-probability-edited.pcad', app);
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 6, source: coordinate } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'general-probability-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '確率変数の値')?.value).toMatchObject({ value: 3, source });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 3, source: coordinate } } });
}
