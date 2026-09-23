import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';

/** Several independent exact calculations and document reopen/Undo share this finite scenario ceiling. */
export const INTEGRAL_SCENARIO_TIMEOUT_MS = 600_000;

/** Original integral domains, convergent endpoints, saved ranges and Undo use the ordinary editor. */
export async function mathIntegralsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('積分の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  for (const source of ['integrate(1/t,t,-1,1)', '0*integrate(1/t,t,-1,1)', 'integrate(1/t,t,1,∞)']) {
    await input.fill(source); await expect(result).toContainText('収束しません', { timeout: 225_000 });
    await expect(input).toHaveAttribute('aria-invalid', 'true'); await expect(apply).toBeDisabled();
  }
  await input.fill('integrate(0*integrate(t*exp(u),u,0,∞),t,1,2)');
  await expect(result).toHaveText('値を決めるための条件や計算結果がまだ揃っていません。', { timeout: 225_000 });
  await expect(apply).toBeDisabled();
  for (const [source, expected] of [
    ['integrate(ln(t),t,0,1)', '-1'],
    ['integrate((t^2-1)/(t-1),t,0,2)', '4'],
    ['integrate((t^2-1)/(t-1),t,2,0)', '-4'],
    ['integrate(integrate(t*exp(-u),u,0,∞),t,1,2)', '1.5'],
    ['integrate(integrate(t*exp(-u),u,0,∞),t,2,1)', '-1.5'],
  ] as const) {
    await input.fill(source); await expect(result).toHaveText(`= ${expected}`, { timeout: 225_000 });
    await expect(apply).toBeEnabled();
  }
  const source = 'integrate(1/sqrt(t),t,0,1)', changedSource = 'integrate(1/sqrt(t),t,0,4)';
  await input.fill(source); await expect(result).toHaveText('= 2', { timeout: 225_000 });
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await expect(result).toHaveText('= 2', { timeout: 225_000 });
  await captureManualDetail(page, info, { name: 'math-integral-endpoint', dialog,
    script: new URL(import.meta.url), fixture: { source, expected: 2, lower: 0, upper: 1 } });
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 2', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);

  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("積分の値")';
  for (const [axis, expression] of [[0, coordinate], [1, 'integrate(1/(1+t^2),t,-∞,∞)']] as const) {
    await popover.getByRole('button', { name: /数式で入力/u }).nth(axis).click();
    await waitForMathEditorText(dialog); await input.fill(expression);
    if (axis === 0) await expect(result).toHaveText('= 2', { timeout: 225_000 });
    else await expect(result).toHaveText(/^= 3\.14159265358/u, { timeout: 225_000 });
    await apply.click(); await expect(dialog).toHaveCount(0);
  }
  await popover.locator('input.pcad-field__input').nth(2).fill('0');
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'integrals.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '積分の値')?.value).toMatchObject({
    value: 2, source, mathDefinition: { source, angleUnit: 'degree' },
  });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('積分の答えを使った点がありません。');
  expect(point.at.x).toMatchObject({ value: 2, source: coordinate });
  expect(point.at.y.value).toBeCloseTo(Math.PI, 12);
  await reopenPart(page, info, 'integrals.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 2', { timeout: 225_000 });
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('端点や途中に注意が必要な積分');
  await page.keyboard.press('Escape');
  await input.fill(changedSource); await expect(result).toHaveText('= 4', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'integrals-edited.pcad', app);
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 4, source: coordinate } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'integrals-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '積分の値')?.value).toMatchObject({ value: 2, source });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 2, source: coordinate } } });
}
