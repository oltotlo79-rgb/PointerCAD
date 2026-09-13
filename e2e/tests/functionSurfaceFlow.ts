import { functionPlotMessage } from './functionMessages.js';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { openTarget } from './electronAppFlow.js';
import { savePart } from './scriptsFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { helpNavigationFlow } from './helpNavigationFlow.js';

const text = functionPlotMessage;
export async function functionSurfaceFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await chooseToolMenuItem(page, '作図', text('menuTitle'));
  const dialog = page.locator('.pcad-function-dialog');
  await dialog.getByRole('combobox', { name: text('geometry'), exact: true }).selectOption('surface');
  await expect(dialog.getByRole('heading', { name: text('surfaceTitle'), exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: text('surfaceHelp'), exact: true }).click();
  const help = page.locator('.pcad-help');
  await expect(help.getByRole('heading', { name: '関数とXYZの範囲から曲面を作る', exact: true })).toBeVisible();
  await helpNavigationFlow(page);
  await page.keyboard.press('Escape'); await expect(help).toHaveCount(0);
  for (const axis of ['X', 'Y', 'Z']) for (const endpoint of ['minimum', 'maximum'] as const) {
    await expect(dialog.getByRole('textbox', { name: `${axis} ${text(endpoint)}`, exact: true })).toHaveValue('');
  }
  await dialog.getByRole('textbox', { name: `Z ${text('formula')}`, exact: true }).fill('X+Y');
  for (const [axis, min, max] of [['X', '-1', '1'], ['Y', '-1', '1'], ['Z', '-0.5', '']] as const) {
    await dialog.getByRole('textbox', { name: `${axis} ${text('minimum')}`, exact: true }).fill(min);
    if (max) await dialog.getByRole('textbox', { name: `${axis} ${text('maximum')}`, exact: true }).fill(max);
  }
  const confirm = dialog.getByRole('button', { name: text('surfaceApply'), exact: true });
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  await expect(confirm).toBeDisabled(); await expect(dialog.locator('canvas')).toHaveCount(0);
  await dialog.getByRole('textbox', { name: `Z ${text('maximum')}`, exact: true }).fill('0.5');
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  await expect(confirm).toBeEnabled({ timeout: 60_000 });
  await expect(dialog.getByText(text('openSurface'), { exact: false })).toBeVisible();
  const previewCanvas = dialog.locator('canvas'); await expect(previewCanvas).toBeVisible();
  await expect(previewCanvas).toBeInViewport({ ratio: 1 });
  const box = await previewCanvas.boundingBox(); if (!box) throw new Error('Preview canvas not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 18, { steps: 6 }); await page.mouse.up();
  await expect(confirm).toBeInViewport();
  await expect(previewCanvas).toHaveAttribute('aria-label', text('surfacePreviewLabel'));
  await page.screenshot({ path: info.outputPath('function-surface-xyz-preview.png'), fullPage: true });
  const created = await beginRecompute(page); await confirm.click(); await expect(dialog).toHaveCount(0); await waitForRecompute(page, created);
  const original = await savePart(page, info, 'function-surface.pcad', app);
  const surface = original.solids.find(feature => feature.kind === 'functionSurface');
  if (surface?.kind !== 'functionSurface') throw new Error('Surface formula not saved');
  expect(surface.definition).toMatchObject({ bounds: { Z: { min: { value: -0.5 }, max: { value: 0.5 } } },
    formula: { kind: 'coordinate-surface', output: 'Z', expression: { source: 'X+Y' } } });
  await page.reload();
  if (app) {
    await openTarget(app, info.outputPath('function-surface.pcad'));
    await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
  } else {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
    await (await chooser).setFiles(info.outputPath('function-surface.pcad'));
  }
  await waitForRecompute(page); await page.getByText(surface.name, { exact: true }).click();
  await expect(page.getByText('Z = X+Y', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: text('edit'), exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: text('geometry'), exact: true })).toBeDisabled();
  await expect(dialog.getByRole('textbox', { name: `Z ${text('maximum')}`, exact: true })).toHaveValue('0.5');
  await dialog.getByRole('textbox', { name: `Z ${text('maximum')}`, exact: true }).fill('-0.5');
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(text('invalidRange')); await expect(confirm).toBeDisabled();
  await expect(dialog.getByRole('textbox', { name: `Z ${text('minimum')}`, exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.locator('canvas')).toHaveCount(0);
  await dialog.getByRole('textbox', { name: `Z ${text('maximum')}`, exact: true }).fill('0.5');
  await dialog.getByRole('combobox', { name: text('form'), exact: true }).selectOption('parametric');
  const parameterTable = dialog.getByRole('table', { name: text('surfaceParameterRange'), exact: true });
  for (const axis of ['U', 'V']) await expect(parameterTable.getByRole('rowheader', { name: axis, exact: true })).toBeVisible();
  for (const [axis, expression] of [['X', 'U'], ['Y', 'V'], ['Z', 'U*V']] as const) await dialog.getByRole('textbox', { name: `${axis} ${text('formula')}`, exact: true }).fill(expression);
  for (const axis of ['U', 'V']) {
    await dialog.getByRole('textbox', { name: `${axis} ${text('minimum')}`, exact: true }).fill('-1');
    await dialog.getByRole('textbox', { name: `${axis} ${text('maximum')}`, exact: true }).fill('1');
  }
  await dialog.getByRole('textbox', { name: text('surfaceTolerance'), exact: true }).fill('0.05');
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click(); await expect(confirm).toBeEnabled({ timeout: 60_000 });
  await expect(previewCanvas).toBeInViewport({ ratio: 1 }); await expect(confirm).toBeInViewport();
  await expect(dialog.getByText(text('openSurface'), { exact: false })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('function-surface-parametric.png'), fullPage: true });
  const changed = await beginRecompute(page); await confirm.click(); await waitForRecompute(page, changed);
  const edited = (await savePart(page, info, 'function-surface-edited.pcad', app)).solids.find(feature => feature.id === surface.id);
  expect(edited).toMatchObject({ definition: { formula: { kind: 'parametric-surface', U: { min: { value: -1 }, max: { value: 1 } } }, bounds: surface.definition.bounds } });
  const undo = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z'); await waitForRecompute(page, undo);
  expect((await savePart(page, info, 'function-surface-undone.pcad', app)).solids).toEqual(original.solids);
}
