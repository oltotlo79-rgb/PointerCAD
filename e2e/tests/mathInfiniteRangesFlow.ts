import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { captureManualDetail } from './captureManualDetail.js';
import { undoMathEdit, waitForMathEditorText } from './mathEditorReady.js';
import { uiMessage } from './uiMessages.js';

/** Infinite bounds, original-term failures and exact results survive ordinary document operations. */
export async function mathInfiniteRangesFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const row = page.locator('.pcad-parameter').last(), dialog = page.locator('.pcad-math-dialog');
  const name = row.locator('.pcad-field').first().locator('input');
  await name.fill('級数の和'); await name.press('Enter');
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  const input = dialog.locator('textarea'), result = dialog.locator('.pcad-math-editor__result[role="status"]');
  const apply = dialog.getByRole('button', { name: 'この式を使う', exact: true });
  for (const source of ['sum(1/k,k,1,∞)', 'sum((-1)^k,k,0,∞)', '0*sum(1/k,k,1,∞)']) {
    await input.fill(source);
    await expect(result).toContainText('収束しません', { timeout: 225_000 });
    await expect(input).toHaveAttribute('aria-invalid', 'true'); await expect(apply).toBeDisabled();
  }
  for (const source of ['sum(1/(k-3)^2,k,1,∞)', 'product(1-1/k^2,k,1,∞)']) {
    await input.fill(source);
    await expect(result).toContainText('成立条件', { timeout: 225_000 }); await expect(apply).toBeDisabled();
  }
  const source = 'sum((1/2)^k,k,0,∞)', product = 'product(4*k^2/(4*k^2-1),k,1,∞)';
  await input.fill(source); await expect(result).toHaveText('= 2', { timeout: 225_000 });
  await dialog.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(dialog.locator('math-field')).toBeFocused();
  await expect(result).toHaveText('= 2', { timeout: 225_000 });
  await captureManualDetail(page, info, { name: 'math-infinite-range', dialog,
    script: new URL(import.meta.url), fixture: { source, expected: 2, upper: 'infinity' } });
  await dialog.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 2', { timeout: 225_000 });
  await apply.click(); await expect(dialog).toHaveCount(0);

  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '点', exact: true }).click();
  const popover = page.locator('.pcad-popover'), coordinate = 'coef("級数の和")';
  for (const [axis, expression] of [[0, coordinate], [1, product]] as const) {
    await popover.getByRole('button', { name: /数式で入力/u }).nth(axis).click();
    await waitForMathEditorText(dialog);
    await input.fill(expression);
    if (axis === 0) await expect(result).toHaveText('= 2', { timeout: 225_000 });
    else await expect(result).toHaveText(/^= 1\.57079632679/u, { timeout: 225_000 });
    await expect(apply).toBeEnabled();
    await apply.click(); await expect(dialog).toHaveCount(0);
  }
  await popover.locator('input.pcad-field__input').nth(2).fill('0');
  await popover.getByRole('button', { name: '決定', exact: true }).click();
  await popover.getByRole('button', { name: '取消', exact: true }).click();
  const point = page.locator('.pcad-panel--left').getByRole('button', { name: '点1', exact: true });
  await expect(point).toBeVisible();
  const saved = await savePart(page, info, 'infinite-ranges.pcad', app);
  expect(saved.parameters.find(parameter => parameter.name === '級数の和')?.value).toMatchObject({
    value: 2, source, mathDefinition: { source, angleUnit: 'degree' },
  });
  const feature = saved.sketches[0].features.find(candidate => candidate.kind === 'point');
  if (feature === undefined || feature.kind !== 'point') throw new Error('級数から作成した点がありません。');
  if (feature.at.mode !== 'absolute') throw new Error('級数の座標を原点からの位置として保存する必要があります。');
  expect(feature.at.x).toMatchObject({ value: 2, source: coordinate, mathDefinition: { source: coordinate } });
  expect(feature.at.y.value).toBeCloseTo(Math.PI/2, 12);
  expect(feature.at.y).toMatchObject({ source: product, mathDefinition: { source: product } });

  await reopenPart(page, info, 'infinite-ranges.pcad', app);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await row.getByRole('button', { name: '数式で入力', exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(source); await expect(result).toHaveText('= 2', { timeout: 225_000 });
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText('無限に続く和・積');
  await page.keyboard.press('Escape');
  await input.fill('sum((1/3)^k,k,0,∞)'); await expect(result).toHaveText('= 1.5', { timeout: 225_000 });
  // Applying re-evaluates the document's mathematics, including the infinite product of the Y
  // coordinate (Firefox: 26.3 s of 27.8 s on 2026-09-23, then over the default 30 s on a rerun).
  await apply.click(); await expect(dialog).toHaveCount(0, { timeout: 225_000 });
  await point.click();
  const properties = page.locator('.pcad-panel--right');
  await properties.getByRole('tab', { name: uiMessage('propertyPanel', 'propertyPanel.tabProperties'), exact: true }).click();
  await properties.getByRole('button', { name: `${uiMessage('numericInput', 'numericInput.field.x')}: ${uiMessage('math', 'math.open')}`, exact: true }).click();
  await waitForMathEditorText(dialog);
  await expect(input).toHaveValue(coordinate); await expect(result).toHaveText('= 1.5', { timeout: 225_000 });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await undoMathEdit(page);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await expect(row.locator('.pcad-field').nth(1).locator('.pcad-field__message')).toHaveText('= 2');
  const undone = await savePart(page, info, 'infinite-ranges-undone.pcad', app);
  expect(undone.parameters.find(parameter => parameter.name === '級数の和')?.value).toMatchObject({
    value: 2, source, mathDefinition: { source, angleUnit: 'degree' },
  });
  const undonePoint = undone.sketches[0].features.find(candidate => candidate.kind === 'point');
  if (undonePoint === undefined || undonePoint.kind !== 'point' || undonePoint.at.mode !== 'absolute') {
    throw new Error('取り消し後の級数の点を原点からの位置として保存する必要があります。');
  }
  expect(undonePoint.at.x).toMatchObject({ value: 2, source: coordinate, mathDefinition: { source: coordinate } });
  expect(undonePoint.at.y.value).toBeCloseTo(Math.PI/2, 12);
  expect(undonePoint.at.y).toMatchObject({ source: product, mathDefinition: { source: product } });
  console.log('[確認] Undo後の保存内容を照合: 級数の和=2（元の原式）、点のX=2（係数の参照）、点のY=π/2（無限積）');
}
