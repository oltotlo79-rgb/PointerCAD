import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { functionPlotMessage as text } from './functionMessages.js';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { waitForFunctionPreview } from './waitForFunctionPreview.js';
import { captureManualDetail } from './captureManualDetail.js';
import { uiMessage } from './uiMessages.js';

export async function functionHyperbolicFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await chooseToolMenuItem(page, '作図', text('menuTitle'));
  const dialog = page.locator('.pcad-function-dialog');
  const formula = dialog.getByRole('textbox', { name: `Y ${text('formula')}`, exact: true });
  const preview = dialog.getByRole('button', { name: text('preview'), exact: true });
  const apply = dialog.getByRole('button', { name: text('apply'), exact: true });
  const source = 'cosh(X)', changedSource = 'sech(X)';
  await formula.fill(source);
  for (const [axis, min, max] of [['X', '-2', '2'], ['Y', '0', '4'], ['Z', '-1', '1']] as const) {
    await dialog.getByRole('textbox', { name: `${axis} ${text('minimum')}`, exact: true }).fill(min);
    await dialog.getByRole('textbox', { name: `${axis} ${text('maximum')}`, exact: true }).fill(max);
  }
  await dialog.getByRole('button', { name: `Y: ${uiMessage('math', 'math.open')}`, exact: true }).click();
  const math = page.locator('.pcad-math-dialog');
  await expect(math.locator('textarea')).toHaveValue(source);
  await math.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(math.locator('math-field')).toBeVisible();
  await math.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  // Merely viewing structured input preserves the original spelling and the chosen hyperbolic function.
  await expect(math.locator('textarea')).toHaveValue(source);
  await math.getByRole('button', { name: 'この式を使う', exact: true }).click();
  await expect(math).toHaveCount(0);
  await preview.click(); await waitForFunctionPreview(page, info, text('apply'));
  await expect(dialog.locator('canvas')).toBeVisible();
  // The manual image includes the title and every field, then normal-size editing resumes.
  await page.setViewportSize({ width: 1440, height: 1100 });
  await expect.poll(() => dialog.evaluate(element => element.scrollTop === 0
    && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await captureManualDetail(page, info, { name: 'function-hyperbolic', dialog, script: new URL(import.meta.url),
    fixture: { source, expected: 'Y=cosh(X)', bounds: { X: [-2, 2], Y: [0, 4], Z: [-1, 1] } } });
  await page.setViewportSize({ width: 1440, height: 900 });
  const created = await beginRecompute(page); await apply.click(); await waitForRecompute(page, created);
  const original = await savePart(page, info, 'function-hyperbolic.pcad', app);
  const curve = original.sketches.flatMap(sketch => sketch.features).find(feature => feature.kind === 'functionCurve');
  if (curve?.kind !== 'functionCurve') throw new Error('双曲線関数の曲線が保存されていません。');
  expect(curve.definition.formula).toMatchObject({ outputs: { Y: { source, angleUnit: 'degree' } } });
  await reopenPart(page, info, 'function-hyperbolic.pcad', app);
  await page.getByText(curve.name, { exact: true }).click();
  await page.getByRole('button', { name: text('edit'), exact: true }).click();
  await expect(formula).toHaveValue(source);
  await formula.fill(changedSource); await preview.click(); await waitForFunctionPreview(page, info, text('apply'));
  const changed = await beginRecompute(page); await apply.click(); await waitForRecompute(page, changed);
  const edited = await savePart(page, info, 'function-hyperbolic-edited.pcad', app);
  expect(edited.sketches.flatMap(sketch => sketch.features).find(feature => feature.id === curve.id))
    .toMatchObject({ definition: { formula: { outputs: { Y: { source: changedSource } } } } });
  const undo = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z'); await waitForRecompute(page, undo);
  expect((await savePart(page, info, 'function-hyperbolic-undone.pcad', app)).sketches).toEqual(original.sketches);

  await chooseToolMenuItem(page, '作図', text('menuTitle'));
  await dialog.getByRole('combobox', { name: text('geometry'), exact: true }).selectOption('surface');
  await dialog.getByRole('textbox', { name: `Z ${text('formula')}`, exact: true }).fill('asinh(X)+acosh(Y)');
  for (const [axis, min, max] of [['X', '-1', '1'], ['Y', '1.1', '2'], ['Z', '-2', '3']] as const) {
    await dialog.getByRole('textbox', { name: `${axis} ${text('minimum')}`, exact: true }).fill(min);
    await dialog.getByRole('textbox', { name: `${axis} ${text('maximum')}`, exact: true }).fill(max);
  }
  await preview.click(); await waitForFunctionPreview(page, info, text('surfaceApply'));
  const surfaceCreated = await beginRecompute(page);
  await dialog.getByRole('button', { name: text('surfaceApply'), exact: true }).click(); await waitForRecompute(page, surfaceCreated);
  const saved = await savePart(page, info, 'function-hyperbolic-surface.pcad', app);
  const surface = saved.solids.find(feature => feature.kind === 'functionSurface');
  expect(surface).toMatchObject({ definition: { formula: { kind: 'coordinate-surface', output: 'Z',
    expression: { source: 'asinh(X)+acosh(Y)' } } } });
  await reopenPart(page, info, 'function-hyperbolic-surface.pcad', app);
  if (surface?.kind !== 'functionSurface') throw new Error('双曲線関数の曲面が保存されていません。');
  await page.getByText(surface.name, { exact: true }).click();
  await page.getByRole('button', { name: text('edit'), exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: `Z ${text('formula')}`, exact: true })).toHaveValue('asinh(X)+acosh(Y)');
  await dialog.getByRole('button', { name: text('surfaceHelp'), exact: true }).click();
  await expect(page.locator('.pcad-help__article')).toContainText('asinh');
  await page.keyboard.press('Escape'); await expect(page.locator('.pcad-help')).toHaveCount(0);
}
