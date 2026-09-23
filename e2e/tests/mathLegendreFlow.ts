import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

/** Legendre input retains its degree, original domain and editable document source. */
export async function mathLegendreFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('多項式の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  // Notation changes and document reopen can prepare a new exact engine too.
  const expectResult = expect.configure({ timeout: 225_000 });
  for (const [source, reason] of [
    ['legendre(-1,0)', 'Legendre多項式の次数は0以上の整数です。'],
    ['legendre(1/2,0)', 'Legendre多項式の次数は0以上の整数です。'],
    ['legendre(0,1/0)', '0では割れません。'],
    ['0*legendre(-1,0)', 'Legendre多項式の次数は0以上の整数です。'],
  ] as const) {
    // These validation errors precede optional runtime preparation and finish locally.
    await input.fill(source); await expect(result).toHaveText(reason, { timeout: 15_000 });
    await expect(apply).toBeDisabled();
  }
  await input.fill('legendre(129,1)');
  await expectResult(result).toContainText('計算量の上限に達しました'); await expect(apply).toBeDisabled();
  for (const [formula, value] of [['legendre(2,0)', '-0.5'], ['legendre(4,0)', '0.375'],
    ['im(legendre(3,i))', '-4'], ['2*legendre(4,0)+1', '1.75']] as const) {
    await input.fill(formula); await expectResult(result).toHaveText('= ' + value);
  }
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue('2*legendre(4,0)+1');
  await expectResult(result).toHaveText('= 1.75');
  const source = 'legendre(3,2)',
    changed = 'legendre(2,2)';
  await input.fill(source); await expectResult(result).toHaveText('= 17');
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  const palette = dialog.locator('summary').filter({ hasText: '記号と演算を探す' });
  await palette.click();
  await dialog.getByLabel('数学の分野', { exact: true }).selectOption({ label: '関数' });
  await dialog.getByRole('searchbox', { name: '名前・記号で検索', exact: true }).fill('Legendre多項式');
  await expect(dialog.getByRole('button', { name: /Legendre多項式/u })).toBeVisible();
  await palette.click();
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 17');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-legendre', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: 17, degree: 3, argument: 2 } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("多項式の値")';
  await popover.getByRole('button', { name: /数式で入力/u }).first().click();
  await waitForMathEditorText(dialog); await input.fill(coordinate); await expectResult(result).toHaveText('= 17');
  await apply.click(); await expect(dialog).toHaveCount(0);
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'legendre.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '多項式の値')?.value).toMatchObject({ value: 17, source, mathDefinition: { source } });
  expect(saved.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 17, source: coordinate } } });
  await reopenPart(page, info, 'legendre.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog); await expect(input).toHaveValue(source); await expectResult(result).toHaveText('= 17');
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('Legendre多項式を数値や関数に使う');
  await page.keyboard.press('Escape');
  await input.fill(changed); await expectResult(result).toHaveText('= 5.5'); await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'legendre-edited.pcad', app);
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 5.5, source: coordinate } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'legendre-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '多項式の値')?.value).toMatchObject({ value: 17, source });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 17, source: coordinate } } });
}
