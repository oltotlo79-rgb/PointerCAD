import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';
import { uiMessage } from './uiMessages.js';

/** Arc length and oriented work retain independent path/field domains through real file operations. */
export async function mathLineIntegralsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('線積分の値'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const angle = dialog.getByRole('combobox', { name: uiMessage('math', 'math.angleUnit'), exact: true });
  await input.fill('lineintegral(1,[x],[t/t],t,0,1)');
  await expect(result).toHaveText('式の成立条件または計算結果を確認してください。', { timeout: 225_000 });
  await expect(apply).toBeDisabled();
  await input.fill('0*lineintegral(1/x,[x],[t],t,-1,1)');
  await expect(result).toContainText('収束しません', { timeout: 225_000 });
  await expect(apply).toBeDisabled();
  for (const [source, value] of [
    ['lineintegral(1,[x,y],[3*t,4*t],t,1,0)', 5],
    ['lineintegral(1/sqrt(x),[x],[t],t,0,1)', 2],
    ['circulation([2*x,2*y],[x,y],[t,t^2],t,1,0)', -2],
  ] as const) {
    await input.fill(source); await expect(result).toHaveText(`= ${value}`, { timeout: 225_000 });
  }
  await input.fill('lineintegral(1,[x,y],[cos(t),sin(t)],t,0,360)');
  await expect(result).toHaveText(/^= 6\.28318530717/u, { timeout: 225_000 });
  await angle.selectOption('radian');
  // In radians the same parameter range traverses length 360, not one circle.
  await expect(result).toHaveText('= 360', { timeout: 225_000 });
  await input.fill('circulation([2*x,2*y],[x,y],[t,t^2],t,0,1)');
  await expect(result).toHaveText('= 2', { timeout: 225_000 });
  await angle.selectOption('degree');
  const source = 'circulation([2*x,2*y],[x,y],[t,t^2],t,0,1)';
  const changedSource = 'circulation([2*x,2*y],[x,y],[t,t^2],t,0,2)';
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await expect(result).toHaveText('= 2', { timeout: 225_000 });
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'math-line-integrals', dialog,
    script: new URL(import.meta.url), fixture: { source, expected: 2, field: ['2*x', '2*y'], path: ['t', 't^2'], range: [0, 1] } });
  await apply.click(); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("線積分の値")';
  const ySource = 'lineintegral(1,[x,y],[3*t,4*t],t,0,1)';
  for (const [axis, expression, expected] of [[0, coordinate, '2'], [1, ySource, '5']] as const) {
    await popover.getByRole('button', { name: /数式で入力/u }).nth(axis).click();
    await waitForMathEditorText(dialog); await input.fill(expression);
    await expect(result).toHaveText(`= ${expected}`, { timeout: 225_000 });
    await apply.click(); await expect(dialog).toHaveCount(0);
  }
  await popover.locator('input.pcad-field__input').nth(2).fill('0');
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'line-integrals.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '線積分の値')?.value).toMatchObject({
    value: 2, source, mathDefinition: { source, angleUnit: 'degree' },
  });
  const point = saved.sketches[0].features.find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('線積分から作った点がありません。');
  expect(point.at.x).toMatchObject({ value: 2, source: coordinate });
  expect(point.at.y).toMatchObject({ value: 5, source: ySource });
  await reopenPart(page, info, 'line-integrals.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 2', { timeout: 225_000 });
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('曲線に沿って量を積分する');
  await page.keyboard.press('Escape');
  await input.fill(changedSource); await expect(result).toHaveText('= 20', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);
  const edited = await savePart(page, info, 'line-integrals-edited.pcad', app);
  expect(edited.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 20, source: coordinate } } });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'line-integrals-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '線積分の値')?.value).toMatchObject({ value: 2, source });
  expect(undone.sketches[0].features.find(feature => feature.kind === 'point')).toMatchObject({ at: { x: { value: 2, source: coordinate } } });
}
