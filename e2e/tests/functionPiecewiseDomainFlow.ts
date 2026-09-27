import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { functionPlotMessage as text } from './functionMessages.js';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { waitForFunctionPreview } from './waitForFunctionPreview.js';
import { uiMessage } from './uiMessages.js';

/** Help headings of packages/help-content/docs/ja/math-input.md that the math dialog's F1 must reach. */
const PIECEWISE_HEADING = '関数作図で場合分けする';
const DOMAIN_HEADING = '条件が成り立つ範囲だけで曲線・曲面を作る';
/** Rejection reasons as the help text quotes them (math-input.md). */
const CURVE_PRECISION_REASON = '指定した精度で曲線を計算しきれませんでした。範囲や精度を見直してください。';
const CONDITION_BOUNDARY_REASON = '条件を満たす範囲の境界を指定した精度で確かめられないため、形を作れません。';

const curveCount = (curves: number) => `${text('curveCount')}: ${curves} / ${text('closedCurveCount')}: 0`;

async function fillBounds(dialog: Locator, bounds: readonly (readonly [string, string, string])[]): Promise<void> {
  for (const [axis, min, max] of bounds) {
    await dialog.getByRole('textbox', { name: `${axis} ${text('minimum')}`, exact: true }).fill(min);
    await dialog.getByRole('textbox', { name: `${axis} ${text('maximum')}`, exact: true }).fill(max);
  }
}

/** Open the axis's math dialog, keep the typed source, reach the named help section by F1, and accept it unchanged. */
async function confirmInMathDialog(page: Page, dialog: Locator, axis: 'Y' | 'Z', source: string, heading: string): Promise<void> {
  await dialog.getByRole('button', { name: `${axis}: ${uiMessage('math', 'math.open')}`, exact: true }).click();
  const math = page.locator('.pcad-math-dialog');
  await expect(math.locator('textarea')).toHaveValue(source);
  await page.keyboard.press('F1');
  await expect(page.locator('.pcad-help__article')).toContainText(heading);
  await page.keyboard.press('Escape'); await expect(page.locator('.pcad-help')).toHaveCount(0);
  const use = math.getByRole('button', { name: 'この式を使う', exact: true });
  await expect(use).toBeEnabled(); await use.click(); await expect(math).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: `${axis} ${text('formula')}`, exact: true })).toHaveValue(source);
}

/** A rejected preview names the reason, enables nothing, and shows no shape. */
async function expectRejected(dialog: Locator, applyLabel: string, reason: string): Promise<void> {
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(reason, { timeout: 90_000 });
  await expect(dialog.getByRole('button', { name: applyLabel, exact: true })).toBeDisabled();
  await expect(dialog.locator('canvas')).toHaveCount(0);
}

/**
 * ADD-25 25-02・25-05 (curve): a which() split draws separate branches without bridging the gap,
 * a root guarded by its condition draws the semicircle up to the boundary, and an unguarded root
 * is refused with the reason. The original source survives save/reopen and Undo restores it.
 */
export async function functionPiecewiseCurveFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await chooseToolMenuItem(page, '作図', text('menuTitle'));
  const dialog = page.locator('.pcad-function-dialog');
  const formula = dialog.getByRole('textbox', { name: `Y ${text('formula')}`, exact: true });
  const preview = dialog.getByRole('button', { name: text('preview'), exact: true });
  const apply = dialog.getByRole('button', { name: text('apply'), exact: true });
  const status = dialog.getByRole('status').filter({ hasText: text('curveCount') });
  // The help example: value -2 for X<=-1 and 3 for X>=1, with no line between -1 and 1.
  const source = 'which(X<=-1,-2,X>=1,3)', semicircle = 'which(X^2<1,sqrt(1-X^2))', unguarded = 'which(X^2<1,sqrt(0.5-X^2))';
  await formula.fill(source);
  await fillBounds(dialog, [['X', '-2', '2'], ['Y', '-3', '4'], ['Z', '-1', '1']]);
  await confirmInMathDialog(page, dialog, 'Y', source, PIECEWISE_HEADING);
  await preview.click(); await waitForFunctionPreview(page, info, text('apply'));
  await expect(dialog.locator('canvas')).toBeVisible();
  await expect(status).toHaveText(curveCount(2));
  await page.screenshot({ path: info.outputPath('function-piecewise-preview.png'), fullPage: true });
  const created = await beginRecompute(page); await apply.click(); await expect(dialog).toHaveCount(0);
  await waitForRecompute(page, created);
  const original = await savePart(page, info, 'function-piecewise.pcad', app);
  const curve = original.sketches.flatMap(sketch => sketch.features).find(feature => feature.kind === 'functionCurve');
  if (curve?.kind !== 'functionCurve') throw new Error('場合分けの関数曲線が保存されていません。');
  expect(curve.definition.formula).toMatchObject({ outputs: { Y: { source } } });

  await reopenPart(page, info, 'function-piecewise.pcad', app);
  await page.getByText(curve.name, { exact: true }).click();
  await expect(page.getByText(`Y = ${source}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: text('edit'), exact: true }).click();
  await expect(formula).toHaveValue(source);
  // The reopened original still yields the same two separate branches.
  await preview.click(); await waitForFunctionPreview(page, info, text('apply'));
  await expect(status).toHaveText(curveCount(2));
  // A root that the condition does not keep defined is refused with the reason, not approximated.
  await formula.fill(unguarded);
  await expectRejected(dialog, text('apply'), CURVE_PRECISION_REASON);
  await formula.fill(semicircle);
  await confirmInMathDialog(page, dialog, 'Y', semicircle, DOMAIN_HEADING);
  await preview.click(); await waitForFunctionPreview(page, info, text('apply'));
  await expect(status).toHaveText(curveCount(1));
  await page.screenshot({ path: info.outputPath('function-semicircle-preview.png'), fullPage: true });
  const changed = await beginRecompute(page); await apply.click(); await waitForRecompute(page, changed);
  const edited = await savePart(page, info, 'function-semicircle.pcad', app);
  expect(edited.sketches.flatMap(sketch => sketch.features).find(feature => feature.id === curve.id))
    .toMatchObject({ definition: { formula: { outputs: { Y: { source: semicircle } } } } });
  const undo = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z'); await waitForRecompute(page, undo);
  expect((await savePart(page, info, 'function-piecewise-undone.pcad', app)).sketches).toEqual(original.sketches);
}

/** Area (mm²) that the surface preview reports for the actual clipped mesh. */
async function previewArea(dialog: Locator): Promise<number> {
  const summary = dialog.locator('figure.pcad-function-preview > p');
  await expect(summary).toContainText(text('openSurface'));
  const match = (await summary.textContent())?.match(new RegExp(`${text('area')}: ([\\d.,]+) mm²`, 'u'));
  return Number(match?.[1].replaceAll(',', '') ?? NaN);
}

/**
 * ADD-25 25-05 (surface): the hemisphere which(X^2+Y^2<1,sqrt(1-X^2-Y^2)) is drawn up to the
 * boundary where its root is undefined, a condition that holds only on an equality is refused with
 * the reason, and the conditional source survives save/reopen, edit and Undo.
 */
export async function functionDomainSurfaceFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await chooseToolMenuItem(page, '作図', text('menuTitle'));
  const dialog = page.locator('.pcad-function-dialog');
  await dialog.getByRole('combobox', { name: text('geometry'), exact: true }).selectOption('surface');
  await expect(dialog.getByRole('heading', { name: text('surfaceTitle'), exact: true })).toBeVisible();
  const formula = dialog.getByRole('textbox', { name: `Z ${text('formula')}`, exact: true });
  const preview = dialog.getByRole('button', { name: text('preview'), exact: true });
  const confirm = dialog.getByRole('button', { name: text('surfaceApply'), exact: true });
  const hemisphere = 'which(X^2+Y^2<1,sqrt(1-X^2-Y^2))', disc = 'which(X^2+Y^2<1,X^2-Y^2)', equality = 'which(X^2+Y^2=1,0.5)';
  await fillBounds(dialog, [['X', '-1.5', '1.5'], ['Y', '-1.5', '1.5'], ['Z', '-1', '1.5']]);
  // The help limits a hemisphere of radius 1 to a precision coarser than about a tenth of the radius.
  // 0.3 keeps Firefox's first sampling near 30 s (0.2 took 69 s there against the 90 s preview wait).
  const tolerance = 0.3;
  await dialog.getByRole('textbox', { name: text('surfaceTolerance'), exact: true }).fill(String(tolerance));
  await formula.fill(equality);
  await expectRejected(dialog, text('surfaceApply'), CONDITION_BOUNDARY_REASON);
  await formula.fill(hemisphere);
  await confirmInMathDialog(page, dialog, 'Z', hemisphere, DOMAIN_HEADING);
  await preview.click(); await waitForFunctionPreview(page, info, text('surfaceApply'));
  await expect(dialog.locator('canvas')).toBeVisible();
  const area = await previewArea(dialog);
  // Vertices lie on the unit hemisphere and the facets are its chords, so the mesh cannot exceed 2π.
  expect(area).toBeLessThanOrEqual(2 * Math.PI);
  // The omitted strip at the boundary is within the precision, so the mesh covers at least the disc of
  // radius 1-tolerance seen from above, and a surface is never smaller than its projection.
  expect(area).toBeGreaterThanOrEqual(Math.PI * (1 - tolerance) ** 2);
  await page.screenshot({ path: info.outputPath('function-hemisphere-preview.png'), fullPage: true });
  const created = await beginRecompute(page); await confirm.click(); await expect(dialog).toHaveCount(0);
  await waitForRecompute(page, created);
  const original = await savePart(page, info, 'function-hemisphere.pcad', app);
  const surface = original.solids.find(feature => feature.kind === 'functionSurface');
  if (surface?.kind !== 'functionSurface') throw new Error('条件付きの関数曲面が保存されていません。');
  expect(surface.definition).toMatchObject({ tolerance: { value: tolerance },
    formula: { kind: 'coordinate-surface', output: 'Z', expression: { source: hemisphere } } });

  await reopenPart(page, info, 'function-hemisphere.pcad', app);
  await page.getByText(surface.name, { exact: true }).click();
  await expect(page.getByText(`Z = ${hemisphere}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: text('edit'), exact: true }).click();
  await expect(formula).toHaveValue(hemisphere);
  // The reopened source reproduces the same hemisphere mesh.
  await preview.click(); await waitForFunctionPreview(page, info, text('surfaceApply'));
  expect(await previewArea(dialog)).toBe(area);
  await formula.fill(disc);
  await preview.click(); await waitForFunctionPreview(page, info, text('surfaceApply'));
  await expect(dialog.locator('figure.pcad-function-preview > p')).toContainText(text('openSurface'));
  const changed = await beginRecompute(page); await confirm.click(); await waitForRecompute(page, changed);
  const edited = await savePart(page, info, 'function-disc-surface.pcad', app);
  expect(edited.solids.find(feature => feature.id === surface.id)).toMatchObject({ definition: {
    formula: { kind: 'coordinate-surface', expression: { source: disc } }, bounds: surface.definition.bounds } });
  const undo = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z'); await waitForRecompute(page, undo);
  expect((await savePart(page, info, 'function-hemisphere-undone.pcad', app)).solids).toEqual(original.solids);
}
