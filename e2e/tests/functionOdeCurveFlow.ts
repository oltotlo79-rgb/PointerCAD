import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { functionPlotMessage as plot, functionPointMessage as pointText } from './functionMessages.js';
import { functionDirectionMessage as directionText } from './functionDirectionMessages.js';
import { savePart } from './scriptsFlow.js';
import { reopenPart } from './reopenPart.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { captureManualDetail } from './captureManualDetail.js';
import { uiMessage } from './uiMessages.js';
import { waitForMathEditorText } from './mathEditorReady.js';

// Multiple independent preparations, saved-file reopen and dependent geometry are
// exercised in one journey. Each calculation retains its own finite deadline.
export const ODE_CURVE_SCENARIO_TIMEOUT_MS = 900_000;

async function ready(dialog: Locator, name: string): Promise<void> {
  let outcome = 'waiting';
  await expect.poll(async () => {
    const error = dialog.getByRole('alert');
    outcome = await error.count() > 0 ? 'failed: ' + (await error.allTextContents()).join('\n')
      : await dialog.getByRole('button', { name, exact: true }).isEnabled() ? 'ready' : 'waiting';
    return outcome;
  }, { timeout: 225_000, message: '解曲線の準備を終え、現在の入力の結果を表示すること' }).not.toBe('waiting');
  expect(outcome).toBe('ready');
}

export async function functionOdeCurveFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const dialog = page.locator('.pcad-function-dialog'), tree = page.locator('.pcad-panel--left');
  const source = 'component(odeat(odesolve([diff(y,x)=2*x],x,[y],[[y,0,1]]),1,[],X),1)';
  const changedSource = source.replace('[y,0,1]', '[y,0,2]');
  await chooseToolMenuItem(page, '作図', plot('menuTitle'));
  const formula = dialog.getByRole('textbox', { name: `Y ${plot('formula')}`, exact: true });
  await formula.fill(source);
  await dialog.getByRole('textbox', { name: `Z ${plot('formula')}`, exact: true }).fill('0');
  for (const [axis, min, max] of [['X', '-2', '2'], ['Y', '0', '8'], ['Z', '-1', '1']] as const) {
    await dialog.getByRole('textbox', { name: `${axis} ${plot('minimum')}`, exact: true }).fill(min);
    await dialog.getByRole('textbox', { name: `${axis} ${plot('maximum')}`, exact: true }).fill(max);
  }
  await dialog.getByRole('button', { name: `Y: ${uiMessage('math', 'math.open')}`, exact: true }).click();
  const math = page.locator('.pcad-math-dialog');
  await waitForMathEditorText(math); await expect(math.locator('textarea')).toHaveValue(source);
  await math.getByRole('button', { name: '構造入力', exact: true }).click();
  await expect(math.locator('math-field')).toBeVisible();
  await math.getByRole('button', { name: 'テキスト入力', exact: true }).click();
  await expect(math.locator('textarea')).toHaveValue(source);
  await math.getByRole('button', { name: 'この式を使う', exact: true }).click();
  await expect(math).toHaveCount(0);
  await dialog.getByRole('button', { name: plot('preview'), exact: true }).click(); await ready(dialog, plot('apply'));
  await expect(dialog.locator('canvas')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await captureManualDetail(page, info, { name: 'function-ode-curve', dialog, script: new URL(import.meta.url),
    fixture: { source, solution: 'Y=1+X^2', point: [1, 2, 0], normal: [-2, 1, 0] } });
  await page.setViewportSize({ width: 1440, height: 900 });
  const created = await beginRecompute(page);
  await dialog.getByRole('button', { name: plot('apply'), exact: true }).click(); await waitForRecompute(page, created);
  const document = await savePart(page, info, 'ode-curve.pcad', app);
  const curve = document.sketches.flatMap(sketch => sketch.features).find(feature => feature.kind === 'functionCurve');
  if (curve?.kind !== 'functionCurve') throw new Error('微分方程式の曲線が保存されていません。');
  expect(curve.definition.formula).toMatchObject({ outputs: { Y: { source } } });

  await tree.getByRole('button', { name: curve.name, exact: true }).click();
  await page.getByRole('button', { name: pointText('title'), exact: true }).click();
  await dialog.getByRole('textbox', { name: `X ${pointText('coordinate')}`, exact: true }).fill('1');
  await dialog.getByRole('button', { name: pointText('search'), exact: true }).click(); await ready(dialog, pointText('apply'));
  await expect(dialog.getByRole('radio')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: `${pointText('candidate')} 1: X=1, Y=2, Z=0`, exact: true })).toBeVisible();
  const added = await beginRecompute(page);
  await dialog.getByRole('button', { name: pointText('apply'), exact: true }).click(); await waitForRecompute(page, added);
  const withPoint = await savePart(page, info, 'ode-curve-point.pcad', app);
  const point = withPoint.sketches.flatMap(sketch => sketch.features).find(feature => feature.kind === 'point');
  if (point?.kind !== 'point' || point.at.mode === 'absolute' || point.at.base.kind !== 'functionPoint') {
    throw new Error('解曲線から求めた点が保存されていません。');
  }
  await tree.getByRole('button', { name: point.name, exact: true }).click();
  await page.getByRole('button', { name: directionText('title'), exact: true }).click();
  await dialog.getByRole('radio', { name: directionText('normal'), exact: true }).check();
  await dialog.getByRole('textbox', { name: directionText('length'), exact: true }).fill('sqrt(5)');
  await dialog.getByRole('button', { name: directionText('preview'), exact: true }).click(); await ready(dialog, directionText('apply'));
  const values = await dialog.getByRole('region', { name: directionText('result'), exact: true }).locator('dd').allTextContents();
  const coordinates = values.map(value => [...value.matchAll(/[XYZ] = ([-+\d.eE]+)/gu)].map(match => Number(match[1])));
  expect(coordinates).toHaveLength(2);
  for (const [index, expected] of [[1, 2, 0], [-1, 3, 0]].entries()) {
    expect(coordinates[index]).toHaveLength(3);
    expected.forEach((value, axis) => expect(coordinates[index][axis]).toBeCloseTo(value, 6));
  }
  const direction = await beginRecompute(page);
  await dialog.getByRole('button', { name: directionText('apply'), exact: true }).click(); await waitForRecompute(page, direction);
  const original = await savePart(page, info, 'ode-curve-direction.pcad', app);
  expect(original.sketches.flatMap(sketch => sketch.features).some(feature => feature.kind === 'line'
    && feature.to.mode === 'relative' && feature.to.base.kind === 'functionPoint'
    && feature.to.base.direction?.sourcePointId === point.id)).toBe(true);

  await reopenPart(page, info, 'ode-curve-direction.pcad', app);
  await tree.getByRole('button', { name: curve.name, exact: true }).click();
  await page.getByRole('button', { name: plot('edit'), exact: true }).click();
  await expect(formula).toHaveValue(source); await formula.fill(changedSource);
  await dialog.getByRole('button', { name: plot('preview'), exact: true }).click(); await ready(dialog, plot('apply'));
  const editing = await beginRecompute(page);
  await dialog.getByRole('button', { name: plot('apply'), exact: true }).click(); await waitForRecompute(page, editing);
  const edited = await savePart(page, info, 'ode-curve-edited.pcad', app);
  expect(edited.sketches.flatMap(sketch => sketch.features).find(feature => feature.id === curve.id))
    .toMatchObject({ definition: { formula: { outputs: { Y: { source: changedSource } } } } });
  await tree.getByRole('button', { name: point.name, exact: true }).click();
  await page.getByRole('button', { name: pointText('edit'), exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: `X ${pointText('coordinate')}`, exact: true })).toHaveValue('1');
  await dialog.getByRole('button', { name: pointText('search'), exact: true }).click(); await ready(dialog, pointText('update'));
  await expect(dialog.getByRole('button', { name: `${pointText('candidate')} 1: X=1, Y=3, Z=0`, exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  const undo = await beginRecompute(page);
  await page.locator('canvas.pcad-viewport__canvas').focus(); await page.keyboard.press('Control+z'); await waitForRecompute(page, undo);
  expect((await savePart(page, info, 'ode-curve-undone.pcad', app)).sketches).toEqual(original.sketches);
  await page.screenshot({ path: info.outputPath('ode-curve-restored.png'), fullPage: true });
}
