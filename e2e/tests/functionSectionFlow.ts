import { functionPlotMessage, functionSectionMessage } from './functionMessages.js';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { reopenPart } from './reopenPart.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { savePart } from './scriptsFlow.js';
import { uiMessage } from './uiMessages.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';

const section = functionSectionMessage;

export async function functionSectionScenario(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const plot = functionPlotMessage;
  await chooseToolMenuItem(page, '作図', plot('menuTitle'));
  const dialog = page.locator('.pcad-function-dialog');
  await dialog.getByRole('combobox', { name: plot('geometry'), exact: true }).selectOption('surface');
  await dialog.getByRole('textbox', { name: `Z ${plot('formula')}`, exact: true }).fill('X+Y');
  for (const [axis, min, max] of [['X', '-1', '1'], ['Y', '-1', '1'], ['Z', '-0.5', '0.5']]) {
    await dialog.getByRole('textbox', { name: `${axis} ${plot('minimum')}`, exact: true }).fill(min);
    await dialog.getByRole('textbox', { name: `${axis} ${plot('maximum')}`, exact: true }).fill(max);
  }
  await dialog.getByRole('button', { name: plot('preview'), exact: true }).click();
  const confirm = dialog.getByRole('button', { name: plot('surfaceApply'), exact: true });
  await expect(confirm).toBeEnabled({ timeout: 60_000 });
  const created = await beginRecompute(page); await confirm.click(); await waitForRecompute(page, created);
  const original = await savePart(page, info, 'function-section-source.pcad', app);
  const parent = original.solids.find(feature => feature.kind === 'functionSurface');
  if (!parent) throw new Error('The section source surface was not saved');
  await functionSectionFlow(page, info, parent, app);
}

/** Z=X+Y is bounded by X/Y +/-1 and Z +/-0.5. All mutations use real UI and persistence. */
export async function functionSectionFlow(page: Page, info: TestInfo, parent: { readonly id: string; readonly name: string },
  app?: ElectronApplication): Promise<void> {
  const original = await savePart(page, info, 'function-section-before.pcad', app);
  await page.getByText(parent.name, { exact: true }).click();
  await page.getByRole('button', { name: section('title'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: section('title'), exact: true });
  await dialog.getByRole('radio', { name: 'Y', exact: true }).check();
  const coordinate = dialog.getByRole('textbox', { name: 'Y (mm)', exact: true });
  await coordinate.fill('3');
  await dialog.getByRole('button', { name: section('apply'), exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(uiMessage('sketch', 'functionPoint.outside'));
  await coordinate.fill('0.25');
  await coordinate.press('F1');
  await expect(page.locator('.pcad-help').getByRole('heading', { name: '関数とXYZの範囲から曲面を作る', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(coordinate).toHaveValue('0.25');
  await captureManualDetail(page, info, { name: 'function-section-coordinate', dialog, fixture: original, script: new URL(import.meta.url) });
  const created = await beginRecompute(page);
  await dialog.getByRole('button', { name: section('apply'), exact: true }).click();
  await expect(dialog).toHaveCount(0); await waitForRecompute(page, created);
  const saved = await savePart(page, info, 'function-section.pcad', app);
  expect(saved.sketches).toHaveLength(original.sketches.length + 1);
  expect(saved.references).toHaveLength(original.references.length + 1);
  const sketch = saved.sketches.find(item => item.id === saved.activeSketchId);
  const feature = sketch?.features.find(item => item.kind === 'planeSection');
  if (feature?.kind !== 'planeSection') throw new Error('Coordinate section was not saved');
  expect(feature.targetFeatureId).toBe(parent.id);
  expect(saved.references.find(item => item.id === feature.planeId)).toMatchObject({ plane: { kind: 'workPlane', planeId: 'xz', offset: { value: -0.25 } } });
  await expect(page.getByText(feature.name, { exact: true })).toBeVisible();
  await page.getByText(feature.name, { exact: true }).click();
  await page.getByRole('button', { name: section('edit'), exact: true }).click();
  const editing = page.getByRole('dialog', { name: section('edit'), exact: true });
  const editedCoordinate = editing.getByRole('textbox', { name: 'Y (mm)', exact: true });
  await expect(editedCoordinate).toHaveValue('0.25');
  await editedCoordinate.fill('-0.25');
  await captureManualDetail(page, info, { name: 'function-section-edit', dialog: editing, fixture: saved, script: new URL(import.meta.url) });
  const moved = await beginRecompute(page);
  await editing.getByRole('button', { name: section('update'), exact: true }).click(); await waitForRecompute(page, moved);
  const movedFile = await savePart(page, info, 'function-section-moved.pcad', app);
  expect(movedFile.sketches).toEqual(saved.sketches);
  expect(movedFile.references).toHaveLength(saved.references.length);
  expect(movedFile.references.find(item => item.id === feature.planeId)).toMatchObject({ plane: { offset: { value: 0.25 } } });
  const restored = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z'); await waitForRecompute(page, restored);
  expect((await savePart(page, info, 'function-section-restored.pcad', app)).references).toEqual(saved.references);
  const undone = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z'); await waitForRecompute(page, undone);
  const undoFile = await savePart(page, info, 'function-section-undone.pcad', app);
  expect(undoFile.sketches).toEqual(original.sketches); expect(undoFile.references).toEqual(original.references);
  await reopenPart(page, info, 'function-section.pcad', app);
  const reopened = await savePart(page, info, 'function-section-reopened.pcad', app);
  expect(reopened.sketches).toEqual(saved.sketches); expect(reopened.references).toEqual(saved.references);
}
