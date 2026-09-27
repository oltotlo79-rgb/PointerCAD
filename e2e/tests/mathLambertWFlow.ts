import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

/** Real Lambert W branches, original source and document edits. */
export async function mathLambertWFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('Lambertの値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  for (const [source, reason] of [
    ['lambertw(0,1/0)', '0では割れません。'],
    ['lambertw(0,[1])', 'Lambert Wの引数は一つの実数の式で指定してください。'],
    ['lambertw(1,1)', '実数のLambert Wの枝は0または-1で指定してください。'],
    ['0*lambertw(-1,0)', 'Lambert Wの枝-1には-1/e以上で0未満の値を指定してください。'],
    ['component([7,lambertw(0,-0.368)],1)', '実数のLambert Wには-1/e以上の値が必要です。'],
  ] as const) {
    await input.fill(source); await expect(result).toHaveText(reason, { timeout: 15_000 });
    await expect(apply).toBeDisabled();
  }
  for (const [formula, value] of [['lambertw(0,1)', '0.567143290'], ['lambertw(0,-0.1)', '-0.111832559'],
    ['lambertw(-1,-0.1)', '-3.577152063'], ['lambertw(0,0)', '= 0'], ['lambertw(-1,-1/e)', '= -1']] as const) {
    await input.fill(formula); await expect(result).toContainText(value); await expect(apply).toBeEnabled();
  }
  await input.fill('derivativeat(lambertw(0,x),x,0,2)');
  await expect(result).toContainText('= -2', { timeout: 225_000 }); await expect(apply).toBeEnabled();
  const source = 'lambertw(0,1)', changed = 'lambertw(-1,-0.1)';
  const initialValue = 0.5671432904097838, changedValue = Number('-3.577152063957297');
  await input.fill(source); await expect(result).toContainText('0.567143290');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '関数' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('Lambert');
  await expect(dialog.getByRole('button', { name: /Lambert W/u })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expect(result).toContainText('0.567143290');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-lambert-w', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: initialValue, arguments: [0,1] } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("Lambertの値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expect(result).toContainText('0.567143290');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'lambert-w.pcad', app);
  const parameter = saved.parameters.find(parameter => parameter.name === 'Lambertの値');
  expect(parameter?.value).toMatchObject({ source, mathDefinition: { source } });
  expect(parameter?.value.value).toBeCloseTo(initialValue, 14);
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('保存した絶対座標の点がありません');
  expect(point.at.x.source).toBe(coordinate); expect(point.at.x.value).toBeCloseTo(initialValue, 14);
  await reopenPart(page, info, 'lambert-w.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expect(result).toContainText('0.567143290');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('Lambert Wの二つの実数の答えを選ぶ');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expect(result).toContainText('-3.577152063'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'lambert-w-edited.pcad', app);
  const editedPoint = edited.sketches[0].features.find(feature => feature.kind === 'point');
  if (editedPoint?.kind !== 'point' || editedPoint.at.mode !== 'absolute') throw new Error('編集した絶対座標の点がありません');
  expect(editedPoint.at.x.value).toBeCloseTo(changedValue, 14);
  expect(edited.parameters.find(parameter => parameter.name === 'Lambertの値')?.value.source).toBe(changed);
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'lambert-w-undone.pcad', app);
  const undonePoint = undone.sketches[0].features.find(feature => feature.kind === 'point');
  if (undonePoint?.kind !== 'point' || undonePoint.at.mode !== 'absolute') throw new Error('取り消し後の絶対座標の点がありません');
  expect(undonePoint.at.x.value).toBeCloseTo(initialValue, 14);
  expect(undone.parameters.find(parameter => parameter.name === 'Lambertの値')?.value.source).toBe(source);
}
