import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';
import { uiMessage } from './uiMessages.js';

/** Side and angle choices must survive actual editing and document round trips. */
export async function mathLimitsFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('左からの極限'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  const angle = dialog.getByRole('combobox', { name: uiMessage('math', 'math.angleUnit'), exact: true });
  await expect(angle).toHaveValue('degree');
  for (const expression of ['limit(abs(t)/t,t,0)', 'limit(1/t,t,0)', 'limit(sin(1/t),t,0)']) {
    await input.fill(expression);
    await expect(result).toContainText('この極限は一定の値に収まりません', { timeout: 225_000 });
    await expect(apply).toBeDisabled();
  }
  await input.fill('limit(sin(t)/t,t,0)');
  await expect.poll(async () => {
    const text = await result.innerText(); return /^= /u.test(text) ? Number(text.slice(2)) : NaN;
  }, { timeout: 225_000 }).toBeCloseTo(Math.PI/180, 12);
  await angle.selectOption('radian'); await expect(result).toHaveText('= 1', { timeout: 225_000 });
  await angle.selectOption('degree');
  const left = 'limit(abs(t)/t,t,0,-1)', right = 'limit(abs(t)/t,t,0,1)';
  await input.fill(left); await expect(result).toHaveText('= -1', { timeout: 225_000 });
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await expect(result).toHaveText('= -1', { timeout: 225_000 });
  await captureManualDetail(page, info, { name: 'math-limit-left', dialog,
    script: new URL(import.meta.url), fixture: { source: left, direction: -1, expected: -1 } });
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(left); await expect(result).toHaveText('= -1', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);

  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popup = page.locator('.pcad-popover'), coordinate = 'coef("左からの極限")';
  for (const [axis, expression, value] of [[0, coordinate, '-1'], [1, 'limit(1/t,t,∞)', '0']] as const) {
    await popup.getByRole('button', { name: /数式で入力/u }).nth(axis).click();
    await waitForMathEditorText(dialog);
    await input.fill(expression); await expect(result).toHaveText(`= ${value}`, { timeout: 225_000 });
    await apply.click(); await expect(dialog).toHaveCount(0);
  }
  await popup.locator('input.pcad-field__input').nth(2).fill('0');
  await popup.getByRole('button', { name: '決定', exact: true }).click();
  await popup.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await savePart(page, info, 'limits-left.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '左からの極限')?.value).toMatchObject({
    value: -1, source: left, mathDefinition: { source: left, angleUnit: 'degree' },
  });
  const feature = saved.sketches[0].features.find(candidate => candidate.kind === 'point');
  if (feature === undefined || feature.kind !== 'point' || feature.at.mode !== 'absolute') {
    throw new Error('極限の答えを使った点の絶対座標がありません。');
  }
  expect(feature.at.x).toMatchObject({ value: -1, source: coordinate });
  expect(feature.at.y).toMatchObject({ value: 0, source: 'limit(1/t,t,∞)' });

  await reopenPart(page, info, 'limits-left.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(left); await expect(result).toHaveText('= -1', { timeout: 225_000 });
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('左右から近づける極限');
  await page.keyboard.press('Escape');
  await input.fill(right); await expect(result).toHaveText('= 1', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);
  const changed = await savePart(page, info, 'limits-right.pcad', app);
  expect(changed.parameters.find(parameter => parameter.name === '左からの極限')?.value).toMatchObject({ value: 1, source: right });
  const moved = changed.sketches[0].features.find(candidate => candidate.kind === 'point');
  if (moved === undefined || moved.kind !== 'point' || moved.at.mode !== 'absolute') throw new Error('編集後の点がありません。');
  expect(moved.at.x).toMatchObject({ value: 1, source: coordinate });
  await undoMathEdit(page);
  const undone = await savePart(page, info, 'limits-undo.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '左からの極限')?.value).toMatchObject({ value: -1, source: left });
}
