import { functionPlotMessage } from './functionMessages.js';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { openTarget } from './electronAppFlow.js';
import { savePart } from './scriptsFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

const text = functionPlotMessage;
export async function functionPlotFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await chooseToolMenuItem(page, '作図', text('menuTitle'));
  const dialog = page.locator('.pcad-function-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: text('help'), exact: true }).click();
  const help = page.locator('.pcad-help');
  await expect(help.getByRole('heading', { name: '関数とXYZの範囲から曲線を作る', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(help).toHaveCount(0);
  for (const axis of ['X', 'Y', 'Z']) for (const endpoint of ['minimum', 'maximum'] as const) {
    await expect(dialog.getByRole('textbox', { name: `${axis} ${text(endpoint)}`, exact: true })).toHaveValue('');
  }
  await dialog.getByRole('textbox', { name: `Y ${text('formula')}`, exact: true }).fill('X^2');
  await page.keyboard.press('F1');
  await expect(help.getByRole('heading', { name: '関数とXYZの範囲から曲線を作る', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: `Y ${text('formula')}`, exact: true })).toHaveValue('X^2');
  await dialog.getByRole('button', { name: `Y: ${uiMessage('math', 'math.open')}`, exact: true }).click();
  const math = page.locator('.pcad-math-dialog');
  const angleUnit = math.getByRole('combobox', { name: uiMessage('math', 'math.angleUnit'), exact: true });
  await expect(angleUnit).toHaveValue('degree');
  await angleUnit.selectOption('radian');
  await expect(math.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  await math.getByRole('button', { name: 'この式を使う', exact: true }).click();
  await expect(math).toHaveCount(0);
  for (const [axis, min, max] of [['X', '-2', '2'], ['Y', '-1', '2'], ['Z', '-1', '']] as const) {
    await dialog.getByRole('textbox', { name: `${axis} ${text('minimum')}`, exact: true }).fill(min);
    if (max) await dialog.getByRole('textbox', { name: `${axis} ${text('maximum')}`, exact: true }).fill(max);
  }
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  await expect(dialog.getByRole('button', { name: text('apply'), exact: true })).toBeDisabled();
  await expect(dialog.locator('canvas')).toHaveCount(0);
  await dialog.getByRole('textbox', { name: `Z ${text('maximum')}`, exact: true }).fill('1');
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  await expect(dialog.getByRole('button', { name: text('apply'), exact: true })).toBeEnabled({ timeout: 60_000 });
  await expect(dialog.locator('canvas')).toBeVisible();
  await expect(dialog.locator('canvas')).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole('button', { name: text('apply'), exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('function-xyz-preview.png'), fullPage: true });
  const created = await beginRecompute(page);
  await dialog.getByRole('button', { name: text('apply'), exact: true }).click();
  await expect(dialog).toHaveCount(0); await waitForRecompute(page, created);
  const original = await savePart(page, info, 'function-curve.pcad', app);
  const curve = original.sketches.flatMap(sketch => sketch.features).find(feature => feature.kind === 'functionCurve');
  if (curve?.kind !== 'functionCurve') throw new Error('Function feature was not saved');
  expect(curve.definition.formula).toMatchObject({outputs:{Y:{angleUnit:'radian'}}});
  expect(curve.definition.bounds.Z.max.value).toBe(1); expect(curve.definition.bounds.Y.max.value).toBe(2);
  await page.reload();
  if (app !== undefined) {
    await openTarget(app, info.outputPath('function-curve.pcad'));
    await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
  } else {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
    await (await chooser).setFiles(info.outputPath('function-curve.pcad'));
  }
  await waitForRecompute(page);
  await page.getByText(curve.name, { exact: true }).click();
  await page.getByRole('button', { name: text('edit'), exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: `Y ${text('formula')}`, exact: true })).toHaveValue('X^2');
  await dialog.getByRole('button', { name: `Y: ${uiMessage('math', 'math.open')}`, exact: true }).click();
  await expect(angleUnit).toHaveValue('radian');
  await expect(math.locator('textarea')).toBeVisible();
  await math.locator('textarea').fill('1/X');
  await math.getByRole('combobox', { name: uiMessage('math', 'math.angleUnit'), exact: true }).selectOption('degree');
  await expect(math.getByRole('button', { name: 'この式を使う', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('function-axis-math.png'), fullPage: true });
  await math.getByRole('button', { name: 'この式を使う', exact: true }).click();
  await expect(math).toHaveCount(0);
  await dialog.getByRole('textbox', { name: `Y ${text('formula')}`, exact: true }).fill('2/X');
  await expect(dialog.getByRole('group', { name: `Y ${text('formula')}`, exact: true }))
    .toContainText(`${uiMessage('math', 'math.angleUnit')}: ${uiMessage('math', 'math.degree')}`);
  await dialog.getByRole('textbox', { name: `Z ${text('minimum')}`, exact: true }).fill('0.2');
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('範囲');
  await expect(dialog.getByRole('button', { name: text('apply'), exact: true })).toBeDisabled();
  await expect(dialog.locator('canvas')).toHaveCount(0);
  await dialog.getByRole('textbox', { name: `Z ${text('minimum')}`, exact: true }).fill('-1');
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  await expect(dialog.getByRole('button', { name: text('apply'), exact: true })).toBeEnabled();
  const changed = await beginRecompute(page);
  await dialog.getByRole('button', { name: text('apply'), exact: true }).click(); await waitForRecompute(page, changed);
  const saved = await savePart(page, info, 'function-hyperbola.pcad', app);
  const edited = saved.sketches.flatMap(sketch => sketch.features).find(feature => feature.id === curve.id);
  expect(edited).toMatchObject({ definition: { formula: { outputs: { Y: { source: '2/X', angleUnit: 'degree' } } } } });
  const undo = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z'); await waitForRecompute(page, undo);
  expect((await savePart(page, info, 'function-undone.pcad', app)).sketches).toEqual(original.sketches);
  // Also exercise the enclosed polynomial through the real math and CAD Workers. The earlier
  // parabola crosses Y=2 and must continue to exercise the separate clipping route.
  await page.getByText(curve.name, { exact: true }).click();
  await page.getByRole('button', { name: text('edit'), exact: true }).click();
  await dialog.getByRole('textbox', { name: `Y ${text('minimum')}`, exact: true }).fill('-2');
  await dialog.getByRole('textbox', { name: `Y ${text('maximum')}`, exact: true }).fill('5');
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  await expect(dialog.getByRole('button', { name: text('apply'), exact: true })).toBeEnabled();
  const enclosed = await beginRecompute(page);
  await page.screenshot({ path: info.outputPath('function-polynomial-preview.png'), fullPage: true });
  await dialog.getByRole('button', { name: text('apply'), exact: true }).click();
  await waitForRecompute(page, enclosed);
  const polynomial = await savePart(page, info, 'function-polynomial.pcad', app);
  expect(polynomial.sketches.flatMap(sketch => sketch.features).find(feature => feature.id === curve.id))
    .toMatchObject({ definition: { formula: curve.definition.formula, bounds: { Y: { min: { value: -2 }, max: { value: 5 } } } } });
  await page.screenshot({ path: info.outputPath('function-polynomial.png'), fullPage: true });
  // A real user must be able to use this function as an ordinary sweep path.
  const tree = (name: string) => page.locator('.pcad-panel--left').getByRole('button', { name, exact: true });
  const popup = page.locator('.pcad-popover'), fields = popup.locator('input.pcad-field__input');
  await chooseToolMenuItem(page, '作図', '円');
  await expect(page.locator('.pcad-popover__title')).toHaveText('円の中心');
  for (let i = 0; i < 3; i++) await fields.nth(i).fill('0');
  await fields.first().press('Enter');
  await expect(page.locator('.pcad-popover__title')).toHaveText('円の半径');
  const circle = await beginRecompute(page);
  await fields.first().fill('0.05'); await fields.first().press('Enter');
  await waitForRecompute(page, circle);
  await fields.first().press('Escape');
  await expect(popup).toHaveCount(0); await tree('円弧1').click();
  const face = await beginRecompute(page);
  await page.getByRole('group', { name: 'スケッチ', exact: true }).getByRole('button', { name: '面', exact: true }).click();
  await page.locator('canvas.pcad-viewport__canvas').press('Enter');
  await expect(tree('面1')).toBeVisible(); await waitForRecompute(page, face);
  await tree('面1').click(); await tree(curve.name).click({ modifiers: ['Shift'] });
  await chooseToolMenuItem(page, '作る', 'スイープ');
  const swept = await beginRecompute(page);
  await popup.getByRole('button', { name: '決定', exact: true }).click(); await waitForRecompute(page, swept);
  const savedSweep = await savePart(page, info, 'function-sweep.pcad', app);
  expect(savedSweep.solids[0]).toMatchObject({ kind: 'sweep', path: { curveIds: [curve.id] } });
  expect(savedSweep.sketches.flatMap(sketch => sketch.features).find(feature => feature.id === curve.id))
    .toEqual(polynomial.sketches.flatMap(sketch => sketch.features).find(feature => feature.id === curve.id));
  await tree('スイープ1').click();
  const cell = page.locator('.pcad-panel--right dt.pcad-properties__key').filter({ hasText: /^体積$/u }).locator('xpath=following-sibling::dd[1]');
  const volume = Number((await cell.textContent())?.replaceAll(',', '').match(/[\d.]+/u)?.[0] ?? NaN);
  const expected = Math.PI * 0.05 ** 2 * (2 * Math.sqrt(17) + Math.asinh(4) / 2);
  expect(Math.abs(volume / expected - 1)).toBeLessThan(0.005);
  await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
  await page.screenshot({ path: info.outputPath('function-sweep.png'), fullPage: true });
}
