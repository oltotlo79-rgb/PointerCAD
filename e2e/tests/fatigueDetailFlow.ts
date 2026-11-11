import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { fileAction } from './fileCaptureSupport.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

// DNV-RP-C203 (2005/2006) Table 2-1, air, explicit test calibration only:
// E: log a1=12.010, m=3. F1: log a1=11.699, m=3. No product default is inferred.
// Weld: 2*5*100=1000 mm², range 80000/1000=80 MPa, N=10^12.010/80³≈1.998619e6.
// M20x2.5: As=pi/4*(20-(13*sqrt(3)/24)*2.5)²≈244.794 mm², range=15000/As≈61.276 MPa,
// N=10^11.699/range³≈2.1734e6 cycles, spectrum life N/1000≈2173.4 applications.
const WELD_AREA = 1000;
const WELD_RANGE = 80;
const WELD_LIFE = 10 ** 12.010 / 80 ** 3;
const BOLT_AREA = Math.PI / 4 * (20 - 13 * Math.sqrt(3) / 24 * 2.5) ** 2;
const BOLT_RANGE = 15000 / BOLT_AREA;
const BOLT_LIFE = 10 ** 11.699 / BOLT_RANGE ** 3 / 1000;

async function openStrength(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^見た目/u }).click();
  await page.getByRole('group', { name: '見た目', exact: true }).getByRole('button', { name: '簡易強度計算', exact: true }).click();
}
async function history(page: Page, name: '元に戻す' | 'やり直す'): Promise<void> {
  const button = page.getByRole('group', { name: '履歴', exact: true }).getByRole('button', { name, exact: true });
  await expect(button).toHaveAttribute('aria-disabled', 'false');
  await button.click();
}
async function saveInput(page: Page, info: TestInfo, app: ElectronApplication | undefined, name: string, kind: 'weld' | 'bolt'): Promise<string> {
  const path = info.outputPath(name);
  const opened = readPcadFile(new Uint8Array(await saveFlowFile(page, path, app)));
  if (!opened.ok) throw new Error(opened.error.message);
  expect(opened.document.beamAnalysisInputs?.analyses).toContainEqual(expect.objectContaining({ kind: 'fatigue-detail', definition: expect.objectContaining({ schema: 'pointercad-fatigue-saved/6', input: expect.objectContaining({ detail: expect.objectContaining({ kind }) }) }) }));
  expect(JSON.stringify(opened.document.beamAnalysisInputs)).not.toMatch(/"(?:areaMm2|stressHistories|damage|life|result)"\s*:/u);
  return path;
}
// UI contract is pending; the public-operation scenario and its selectors are intentionally not guessed.

/** Existing fatigue fields carry the canonical data-fatigue-field key on either the input or its wrapper. */
function field(panel: Locator, key: string): Locator {
  return panel.locator(`[data-fatigue-field="${key}"] input, [data-fatigue-field="${key}"] textarea, [data-fatigue-field="${key}"] select, input[data-fatigue-field="${key}"], textarea[data-fatigue-field="${key}"], select[data-fatigue-field="${key}"]`);
}
async function openFatigue(page: Page): Promise<Locator> {
  await openStrength(page);
  await page.getByRole('form', { name: '簡易強度計算', exact: true }).getByTestId('fatigue-open').click();
  const panel = page.getByTestId('fatigue-panel');
  await expect(panel).toBeVisible();
  return panel;
}
async function numberText(locator: Locator, expected: number): Promise<void> {
  // beamDisplayNumber prints 9 significant digits; permit only the rounding of the displayed value.
  await expect.poll(async () => {
    const text = await locator.textContent() ?? '';
    const matches = [...text.replaceAll(',', '').matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/gu)];
    const match = matches.at(-1);
    return match === undefined ? Infinity : Math.abs(Number(match[0]) - expected) / Math.max(1, Math.abs(expected));
  }).toBeLessThan(1e-8);
}
async function configure(panel: Locator, kind: 'weld' | 'bolt'): Promise<void> {
  const weld = kind === 'weld';
  await panel.getByTestId('fatigue-curve-family').selectOption('detail');
  await panel.getByTestId('fatigue-detail-kind').selectOption(kind);
  if (weld) {
    await panel.getByTestId('fatigue-detail-weld-area').selectOption('fillet-throat-area');
    await panel.getByTestId('fatigue-detail-weld-concentric').check();
    await field(panel, 'detail:weldSize').fill('5');
    await field(panel, 'detail:weldLength').fill('100');
    await field(panel, 'detail:weldLines').fill('2');
  } else {
    await panel.getByTestId('fatigue-detail-bolt-area').selectOption('iso-metric-thread-tensile-stress-area');
    await field(panel, 'detail:boltDiameter').fill('20');
    await field(panel, 'detail:boltPitch').fill('2.5');
  }
  await panel.getByTestId('fatigue-detail-quantity').selectOption(weld ? 'weld-group-concentric-shear-force' : 'bolt-total-axial-force');
  await panel.getByTestId('fatigue-detail-location').fill('independent joint fixture');
  await panel.getByTestId('fatigue-detail-curve-stress').selectOption(weld ? 'weld-fillet-throat-nominal-shear' : 'bolt-axial-normal-tensile-stress-area');
  await field(panel, 'stressDefinition').selectOption('range');
  await field(panel, 'meanStressAssumption').selectOption('mean-independent');
  const segments = panel.locator('[data-fatigue-segment]');
  while (await segments.count() > 1) await panel.locator('[data-fatigue-segment-remove]').last().click();
  const logA = weld ? 12.010 : 11.699;
  await field(panel, 'piecewise:segment:0:fromStress').fill(String((10 ** logA / 100000) ** (1 / 3)));
  await field(panel, 'piecewise:segment:0:fromCycles').fill('100000');
  await field(panel, 'piecewise:segment:0:slope').fill('3');
  await panel.getByTestId('fatigue-piecewise-add').click();
  await field(panel, 'piecewise:segment:1:fromStress').fill(String((10 ** logA / 10000000) ** (1 / 3)));
  await field(panel, 'piecewise:segment:1:fromCycles').fill('10000000');
  await field(panel, 'piecewise:segment:1:slope').fill('5');
  await field(panel, 'piecewise:endCycles').fill('100000000');
  await panel.getByTestId('fatigue-piecewise-end').selectOption('none');
  for (const name of ['material', 'detail', 'scope']) await field(panel, `piecewise:${name}`).fill('independent test calibration');
  await field(panel, 'curve:reference').fill('DNV-RP-C203 2005 Table 2-1 air: explicit test calibration');
  await field(panel, 'curve:condition').fill('test only, no product default');
  await panel.getByTestId('fatigue-detail-force-0').fill(weld ? '0, 80000' : '120000, 135000');
  await field(panel, 'history:0:sequence').selectOption('repeated-periodic');
  await field(panel, 'history:0:repeats').fill(weld ? '1' : '1000');
  await field(panel, 'history:0:reference').fill('hand written independent joint history');
  await field(panel, 'history:0:condition').fill('test only');
}
async function checkResult(panel: Locator, kind: 'weld' | 'bolt'): Promise<void> {
  await expect(panel.getByTestId('fatigue-error')).toHaveCount(0);
  await expect(panel.getByTestId('fatigue-detail-result')).toHaveAttribute('data-detail-kind', kind);
  await numberText(panel.getByTestId('fatigue-detail-area'), kind === 'weld' ? WELD_AREA : BOLT_AREA);
  await expect(panel.getByTestId('fatigue-life')).toHaveAttribute('data-life', 'finite');
  await numberText(panel.getByTestId('fatigue-life'), kind === 'weld' ? WELD_LIFE : BOLT_LIFE);
  const stress = panel.getByTestId('fatigue-detail-stresses').locator('tr[data-fatigue-detail-stress="0"]');
  await expect(stress).toHaveCount(1);
  await expect(stress).toHaveAttribute('data-min-mpa', /[-+0-9.eE]+/u);
  await expect(stress).toHaveAttribute('data-max-mpa', /[-+0-9.eE]+/u);
  const minimum = kind === 'weld' ? 0 : 120000 / BOLT_AREA;
  const maximum = kind === 'weld' ? WELD_RANGE : 135000 / BOLT_AREA;
  await expect.poll(async () => Math.abs(Number(await stress.getAttribute('data-min-mpa')) - minimum)).toBeLessThan(1e-7);
  await expect.poll(async () => Math.abs(Number(await stress.getAttribute('data-max-mpa')) - maximum)).toBeLessThan(1e-7);
  await numberText(stress.locator('td').nth(1), minimum);
  await numberText(stress.locator('td').nth(2), maximum);
}
export async function fatigueDetailFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  if (app === undefined) await page.evaluate(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await expect(fileAction(page, '開く')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
  let panel = await openFatigue(page);
  for (const kind of ['weld', 'bolt'] as const) {
    await configure(panel, kind);
    await panel.getByTestId('fatigue-run').click();
    await checkResult(panel, kind);
    const forces = panel.getByTestId('fatigue-detail-force-0');
    const expectedForces = kind === 'weld' ? '0, 80000' : '120000, 135000';
    await forces.fill(kind === 'weld' ? '0, 40000' : '120000, 130000');
    await expect(panel.getByTestId('fatigue-detail-result')).toHaveCount(0);
    await forces.fill(expectedForces);
    await panel.getByTestId('fatigue-detail-curve-stress').selectOption(kind === 'weld' ? 'bolt-axial-normal-tensile-stress-area' : 'weld-fillet-throat-nominal-shear');
    await panel.getByTestId('fatigue-run').click();
    await expect(panel.getByTestId('fatigue-error')).toBeVisible();
    await expect(panel.getByTestId('fatigue-detail-result')).toHaveCount(0);
    await panel.getByTestId('fatigue-detail-curve-stress').selectOption(kind === 'weld' ? 'weld-fillet-throat-nominal-shear' : 'bolt-axial-normal-tensile-stress-area');
    await panel.getByTestId('fatigue-run').click();
    await checkResult(panel, kind);
    await panel.getByTestId('fatigue-save').click();
    await expect(panel.getByTestId('fatigue-saved')).toHaveAttribute('data-saved', 'true');
    await history(page, '元に戻す');
    await expect(panel.getByTestId('fatigue-saved')).toHaveAttribute('data-saved', 'false');
    await history(page, 'やり直す');
    await expect(panel.getByTestId('fatigue-saved')).toHaveAttribute('data-saved', 'true');
    const path = await saveInput(page, info, app, `fatigue-detail-${kind}.pcad`, kind);
    await fileAction(page, '新規').click();
    await expect(panel).toHaveCount(0);
    const fresh = await openFatigue(page);
    await expect(fresh.getByTestId('fatigue-detail-result')).toHaveCount(0);
    await fresh.getByTestId('fatigue-close').click();
    await expect(fresh).toHaveCount(0);
    await page.getByRole('form', { name: '簡易強度計算', exact: true }).getByRole('button', { name: '計算を閉じる', exact: true }).click();
    await openSaveFlowFile(page, path, app);
    panel = await openFatigue(page);
    await expect(panel.getByTestId('fatigue-detail-kind')).toHaveValue(kind);
    await expect(panel.getByTestId('fatigue-detail-force-0')).toHaveValue(expectedForces);
    await expect(panel.getByTestId('fatigue-detail-result')).toHaveCount(0);
    await panel.getByTestId('fatigue-run').click();
    await checkResult(panel, kind);
  }
}
