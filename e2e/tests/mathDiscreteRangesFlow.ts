import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';
import { uiMessage } from './uiMessages.js';

/** The same stored ranges drive a parameter and point in both input notations. */
export async function mathDiscreteRangesFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('間隔の和'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const examples: readonly (readonly [string, number])[] = [
    ['sum(k,k,-5,5,3)', -2], ['product(k,k,-5,5,3)', 40],
    ['sum(k,k,5,1,3)', 0], ['product(k,k,5,1,3)', 1],
    ['sum(sum(j,j,1,i,2),i,2,8,3)', 26], ['product(k,k,1,10,2)', 945],
  ];
  for (const [source, value] of examples) {
    await input.fill(source);
    await expect(result).toHaveText(`= ${String(value)}`, { timeout: 225_000 });
    await expect(apply).toBeEnabled();
  }
  for (const source of ['sum(k,k,1,10,0)', 'product(k,k,1,10,-2)', 'sum(k,k,1,10,1/2)']) {
    await input.fill(source); await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(apply).toBeDisabled();
  }
  const source = 'sum(k,k,1,10,2)', product = 'product(k,k,1,10,2)';
  await input.fill(source); await expect(result).toHaveText('= 25', { timeout: 225_000 });
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await expect(result).toHaveText('= 25', { timeout: 225_000 });
  await captureManualDetail(page, info, { name: 'math-discrete-range-step', dialog,
    script: new URL(import.meta.url), fixture: { source, expected: 25, terms: [1, 3, 5, 7, 9] } });
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 25', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);

  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("間隔の和")';
  for (const [axis, expression, value] of [[0, coordinate, 25], [1, product, 945]] as const) {
    await popover.getByRole('button', { name: /数式で入力/u }).nth(axis).click();
    await waitForMathEditorText(dialog);
    await input.fill(expression); await expect(result).toHaveText(`= ${String(value)}`, { timeout: 225_000 });
    if (axis === 1) {
      await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
      await expect(dialog.locator('math-field')).toBeFocused();
      await expect(result).toHaveText('= 945', { timeout: 225_000 });
      await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
      await expect(input).toHaveValue(product);
    }
    await apply.click(); await expect(dialog).toHaveCount(0);
  }
  await popover.locator('input.pcad-field__input').nth(2).fill('0');
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const point = page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true });
  await expect(point).toBeVisible();
  const saved = await savePart(page, info, 'stepped-ranges.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '間隔の和')?.value).toMatchObject({
    value: 25, source, mathDefinition: { source, angleUnit: 'degree' },
  });
  expect(saved.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: {
    x: { value: 25, source: coordinate, mathDefinition: { source: coordinate } },
    y: { value: 945, source: product, mathDefinition: { source: product } },
  } });
  await reopenPart(page, info, 'stepped-ranges.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 25', { timeout: 225_000 });
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('一定の間隔で足す・掛ける');
  await page.keyboard.press('Escape');
  await input.fill('sum(k,k,1,10,3)'); await expect(result).toHaveText('= 22', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await point.click();
  const properties = page.locator('.pcad-panel--right');
  await properties.getByRole('tab', { name: uiMessage('propertyPanel', 'propertyPanel.tabProperties'), exact: true }).click();
  await properties.getByRole('button', { name: `${uiMessage('numericInput', 'numericInput.field.x')}: ${uiMessage('math', 'math.open')}`, exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(coordinate); await expect(result).toHaveText('= 22', { timeout: 225_000 });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await undoMathEdit(page);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await expect(row.locator('.pcad-field').nth(1).locator('.pcad-field__message')).toHaveText('= 25');
}
