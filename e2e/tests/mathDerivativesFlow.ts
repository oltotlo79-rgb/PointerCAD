import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';
import { uiMessage } from './uiMessages.js';

/** Original point domains, order, angle units and bound-variable identity use the ordinary editor. */
export async function mathDerivativesFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('微分の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const angle = dialog.getByRole('combobox', { name: uiMessage('math', 'math.angleUnit'), exact: true });
  await expect(angle).toHaveValue('degree');
  for (const source of ['derivativeat(abs(t),t,0)', '0*derivativeat(abs(t),t,0)', 'derivativeat(t/t,t,0)', 'derivativeat(sqrt(t),t,0)']) {
    await input.fill(source);
    await expect(result).toHaveText('式の成立条件または計算結果を確認してください。', { timeout: 225_000 });
    await expect(apply).toBeDisabled();
  }
  await input.fill('derivativeat(sin(t),t,0)');
  await expect.poll(async () => {
    const text = await result.innerText(); return /^= /u.test(text) ? Number(text.slice(2)) : NaN;
  }, { timeout: 225_000 }).toBeCloseTo(Math.PI / 180, 12);
  await angle.selectOption('radian'); await expect(result).toHaveText('= 1', { timeout: 225_000 });
  await angle.selectOption('degree');
  // Wait for the degree result first: typing or switching notation while it runs cancels it, and a cancelled
  // calculation part is replaced and prepares the exact runtime again (rules/06 §10.149).
  await expect.poll(async () => {
    const text = await result.innerText(); return /^= /u.test(text) ? Number(text.slice(2)) : NaN;
  }, { timeout: 225_000 }).toBeCloseTo(Math.PI / 180, 12);
  await input.fill('derivativeat(derivativeat(x^2*y,x,2),y,3)');
  await expect(result).toHaveText('= 4', { timeout: 225_000 });
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await expect(result).toHaveText('= 4', { timeout: 225_000 });
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  const source = 'derivativeat(t^3,t,2,3)', changedSource = 'derivativeat(t^3,t,2,2)';
  await input.fill(source); await expect(result).toHaveText('= 6', { timeout: 225_000 });
  await captureManualDetail(page, info, { name: 'math-derivative-at', dialog,
    script: new URL(import.meta.url), fixture: { source, expected: 6, point: 2, order: 3 } });
  await apply.click(); await expect(dialog).toHaveCount(0);

  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("微分の値")';
  for (const [axis, expression, expected] of [[0, coordinate, '6'], [1, 'derivativeat(ln(t),t,2)', '0.5']] as const) {
    await popover.getByRole('button', { name: /数式で入力/u }).nth(axis).click();
    await waitForMathEditorText(dialog); await input.fill(expression);
    await expect(result).toHaveText(`= ${expected}`, { timeout: 225_000 });
    await apply.click(); await expect(dialog).toHaveCount(0);
  }
  await popover.locator('input.pcad-field__input').nth(2).fill('0');
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'derivatives.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '微分の値')?.value).toMatchObject({
    value: 6, source, mathDefinition: { source, angleUnit: 'degree' },
  });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('微分の答えを使った点がありません。');
  expect(point.at.x).toMatchObject({ value: 6, source: coordinate });
  expect(point.at.y).toMatchObject({ value: 0.5, source: 'derivativeat(ln(t),t,2)' });
  await reopenPart(page, info, 'derivatives.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 6', { timeout: 225_000 });
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('指定した位置で微分する');
  await page.keyboard.press('Escape');
  await input.fill(changedSource); await expect(result).toHaveText('= 12', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'derivatives-edited.pcad', app);
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 12, source: coordinate } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'derivatives-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '微分の値')?.value).toMatchObject({ value: 6, source });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 6, source: coordinate } } });
  console.log('[確認] Undo後の保存内容を照合: 微分の値=6（元の原式）、点のX=6（係数の参照）');
}
