import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { disableFilePickers } from './filePickers.js';
import { KERNEL_TIMEOUT_MS, waitForSettledRecompute } from './recompute.js';
import { reopenPart } from './reopenPart.js';
import { saveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage } from './uiMessages.js';

const FEM_WORKER = /\/fem\/worker\.js$/u;
const MENU = uiMessage('toolbar', 'toolbar.analysis.groupLabel');
const OPEN = uiMessage('plasticBar', 'plasticBar.open');
const EQUILIBRIUM = uiMessage('plasticBar', 'plasticBar.equilibrium');
const DEVIATION = uiMessage('plasticBar', 'plasticBar.referenceDeviation');
const REFERENCE = '数値照合用の入力値(実在の材料ではない。降伏棚 1% の一軸の例)';
const FILENAME = 'plastic-bar-plateau.pcad';
const RECORD = 'plastic-bar-plateau-record.json';

/** Panel units (mm, mm², MPa). Run A of the plateau native run sheet: E 200000 MPa, σ0 250 MPa, H 2000 MPa, plateau
 * 1% (= 0.01), L 1000 mm, A 100 mm², end displacement 0 → 5 → 20 → 19 → -5 → 0 mm, 3 steps between the points. */
const VALUES = [['young', '200000'], ['poisson', '0.3'], ['yieldStress', '250'], ['hardening', '2000'],
  ['plateau', '1%'], ['length', '1000'], ['area', '100'], ['stepsPerSegment', '3']] as const;
const KNOTS = ['5', '20', '19', '-5', '0'] as const;
/** restorePlasticBarSession writes the saved doubles in plain decimal form; the plateau is the fraction (no x100). */
const RESTORED = [['young', '200000'], ['poisson', '0.3'], ['yieldStress', '250'], ['hardening', '2000'],
  ['plateau', '0.01'], ['length', '1000'], ['area', '100'], ['stepsPerSegment', '3']] as const;

/** PLASTIC_BAR_TOLERANCES (packages/fem/src/plasticBarResults.ts), unchanged: stress, plastic strain and force 1e-8,
 * displacement 1e-12, each divided by the scale of comparePlasticBar (packages/fem/src/plasticBar.ts): σ0, σ0 / E,
 * σ0 × A and σ0 / E × L. Written here in the units the table shows (MPa, -, N, mm). */
const STRESS_SCALE_MPA = 250;
const STRAIN_SCALE = 250 / 200000;
const FORCE_SCALE_N = 250 * 100;
const DISPLACEMENT_SCALE_MM = STRAIN_SCALE * 1000;
const BOUND = { target: 1e-12 * DISPLACEMENT_SCALE_MM, stress: 1e-8 * STRESS_SCALE_MPA,
  plastic: 1e-8 * STRAIN_SCALE, force: 1e-8 * FORCE_SCALE_N } as const;
/** The panel shows beamDisplayNumber(x) = roundToSignificantDigits(x, FIELD_VALUE_DISPLAY_DIGITS = 9), so a shown
 * cell is compared with the exact value at the shown digits: the tolerance above plus half a unit of the 9th shown
 * digit (and a few doubles of the rounding arithmetic). The unrounded native values are not on the screen and are not
 * claimed here; the product itself shows a result only when every unrounded sample is inside the tolerances. */
const SHOWN_DIGITS = 9;

interface Expected { readonly step: number; readonly target: number; readonly stress: number;
  readonly plastic: number; readonly force: number }

/** The 15 exact rows of the plateau oracle (rev53 oracle53.json sha256 983411c2489145fb0d7d2d957a0b5c2696cc0e0d33f4e0826a189ea732bde877, case stepsPerSegment 3), in shown units: end displacement mm, stress MPa, plastic strain, axial force N. */
const PLATEAU_ROWS: readonly Expected[] = [
  { step: 1, target: 1.6666666666666667, stress: 250, plastic: 0.0004166666666666667, force: 25000 }, // 5/3, 250, 1/2400, 25000
  { step: 2, target: 3.3333333333333335, stress: 250, plastic: 0.0020833333333333333, force: 25000 }, // 10/3, 250, 1/480, 25000
  { step: 3, target: 5, stress: 250, plastic: 0.00375, force: 25000 }, // 5, 250, 3/800, 25000
  { step: 4, target: 10, stress: 250, plastic: 0.00875, force: 25000 }, // 10, 250, 7/800, 25000
  { step: 5, target: 15, stress: 257.4257425742574, plastic: 0.013712871287128713, force: 25742.574257425742 }, // 15, 26000/101, 277/20200, 2600000/101
  { step: 6, target: 20, stress: 267.3267326732673, plastic: 0.018663366336633663, force: 26732.673267326732 }, // 20, 27000/101, 377/20200, 2700000/101
  { step: 7, target: 19.666666666666668, stress: 200.66006600660066, plastic: 0.018663366336633663, force: 20066.006600660065 }, // 59/3, 60800/303, 377/20200, 6080000/303
  { step: 8, target: 19.333333333333332, stress: 133.993399339934, plastic: 0.018663366336633663, force: 13399.339933993399 }, // 58/3, 40600/303, 377/20200, 4060000/303
  { step: 9, target: 19, stress: 67.32673267326733, plastic: 0.018663366336633663, force: 6732.6732673267325 }, // 19, 6800/101, 377/20200, 680000/101
  { step: 10, target: 11, stress: -279.8549161846878, plastic: 0.01239927458092344, force: -27985.49161846878 }, // 11, -2854800/10201, 25297/2040200, -285480000/10201
  { step: 11, target: 3, stress: -295.6965003431036, plastic: 0.004478482501715518, force: -29569.65003431036 }, // 3, -3016400/10201, 9137/2040200, -301640000/10201
  { step: 12, target: -5, stress: -311.53808450151945, plastic: -0.0034423095774924026, force: -31153.808450151944 }, // -5, -3178000/10201, -7023/2040200, -317800000/10201
  { step: 13, target: -3.3333333333333335, stress: 21.795248831813876, plastic: -0.0034423095774924026, force: 2179.5248831813874 }, // -10/3, 667000/30603, -7023/2040200, 66700000/30603
  { step: 14, target: -1.6666666666666667, stress: 311.96967358729796, plastic: -0.0032265150346031564, force: 31196.967358729795 }, // -5/3, 964268000/3090903, -1994569/618180600, 96426800000/3090903
  { step: 15, target: 0, stress: 315.2700036203012, plastic: -0.0015763500181015062, force: 31527.000362030125 }, // 0, 324823000/1030301, -324823/206060200, 32482300000/1030301
];
/** The same independent exact-rational return (rev52 oracle) with no plateau (kp = 0): the original linear isotropic law from the first yield, same inputs and schedule. */
const LINEAR_ROWS: readonly Expected[] = [
  { step: 1, target: 1.6666666666666667, stress: 250.82508250825083, plastic: 0.00041254125412541255, force: 25082.50825082508 }, // 5/3, 76000/303, 1/2424, 7600000/303
  { step: 2, target: 3.3333333333333335, stress: 254.12541254125412, plastic: 0.0020627062706270625, force: 25412.54125412541 }, // 10/3, 77000/303, 5/2424, 7700000/303
  { step: 3, target: 5, stress: 257.4257425742574, plastic: 0.0037128712871287127, force: 25742.574257425742 }, // 5, 26000/101, 3/808, 2600000/101
  { step: 4, target: 10, stress: 267.3267326732673, plastic: 0.008663366336633664, force: 26732.673267326732 }, // 10, 27000/101, 7/808, 2700000/101
  { step: 5, target: 15, stress: 277.2277227722772, plastic: 0.013613861386138614, force: 27722.772277227723 }, // 15, 28000/101, 11/808, 2800000/101
  { step: 6, target: 20, stress: 287.1287128712871, plastic: 0.018564356435643563, force: 28712.871287128713 }, // 20, 29000/101, 15/808, 2900000/101
  { step: 7, target: 19.666666666666668, stress: 220.46204620462046, plastic: 0.018564356435643563, force: 22046.204620462046 }, // 59/3, 66800/303, 15/808, 6680000/303
  { step: 8, target: 19.333333333333332, stress: 153.7953795379538, plastic: 0.018564356435643563, force: 15379.53795379538 }, // 58/3, 46600/303, 15/808, 4660000/303
  { step: 9, target: 19, stress: 87.12871287128714, plastic: 0.018564356435643563, force: 8712.871287128713 }, // 19, 8800/101, 15/808, 880000/101
  { step: 10, target: 11, stress: -299.26477796294483, plastic: 0.012496323889814724, force: -29926.477796294483 }, // 11, -3052800/10201, 5099/408040, -305280000/10201
  { step: 11, target: 3, stress: -315.10636212136063, plastic: 0.004575531810606803, force: -31510.636212136065 }, // 3, -3214400/10201, 1867/408040, -321440000/10201
  { step: 12, target: -5, stress: -330.9479462797765, plastic: -0.0033452602686011176, force: -33094.79462797765 }, // -5, -3376000/10201, -273/81608, -337600000/10201
  { step: 13, target: -3.3333333333333335, stress: 2.385387053556841, plastic: -0.0033452602686011176, force: 238.53870535568407 }, // -10/3, 73000/30603, -273/81608, 7300000/30603
  { step: 14, target: -1.6666666666666667, stress: 330.9951816669756, plastic: -0.0033216425750015447, force: 33099.51816669756 }, // -5/3, 1023074000/3090903, -82135/24727224, 102307400000/3090903
  { step: 15, target: 0, stress: 334.29551169997893, plastic: -0.0016714775584998948, force: 33429.551169997896 }, // 0, 344425000/1030301, -13777/8242408, 34442500000/1030301
];

type Shown = readonly (readonly string[])[];

function field(panel: Locator, key: string): Locator {
  return panel.locator(`[data-plastic-bar-field="${key}"] input.pcad-field__input`);
}
function alerts(panel: Locator): Locator { return panel.locator('[role="alert"]'); }
function results(panel: Locator): Locator { return panel.getByTestId('plastic-bar-results'); }
function shownHalfUnit(shown: number, expected: number): number {
  const size = Math.max(Math.abs(shown), Math.abs(expected));
  if (size === 0) return 0;
  return 0.5 * 10 ** (Math.floor(Math.log10(size)) - (SHOWN_DIGITS - 1)) + 4 * Number.EPSILON * size;
}
function nearShown(text: string, expected: number, bound: number, label: string): void {
  const shown = Number(text);
  expect(text.trim() !== '' && Number.isFinite(shown), `${label}: ${JSON.stringify(text)}`).toBe(true);
  expect(Math.abs(shown - expected), `${label}: shown ${text} vs exact ${String(expected)}`)
    .toBeLessThanOrEqual(bound + shownHalfUnit(shown, expected));
}

async function openPanel(page: Page): Promise<Locator> {
  await chooseToolMenuItem(page, MENU, OPEN);
  const panel = page.getByTestId('plastic-bar-panel');
  await expect(panel).toBeVisible();
  return panel;
}
/** The expression fields evaluate asynchronously; every field must have settled without an error. */
async function expectFieldsSettled(panel: Locator): Promise<void> {
  for (const key of [...VALUES.map(([name]) => name), ...KNOTS.map((_, index) => `knot:${String(index)}`)]) {
    await expect(field(panel, key)).not.toHaveAttribute('aria-busy', 'true');
    await expect(field(panel, key), key).toHaveAttribute('aria-invalid', 'false');
  }
}
/** A real failure already shown by the panel (alert, failed or cancelled status) ends the wait with its text. */
async function waitForResult(panel: Locator): Promise<void> {
  let reason = '';
  await expect.poll(async () => {
    if (await results(panel).isVisible()) return 'result';
    if (await alerts(panel).count() > 0) { reason = (await alerts(panel).first().innerText()) || 'alert'; return 'failed'; }
    const status = await panel.getByTestId('plastic-bar-status').getAttribute('data-status');
    if (status === 'failed' || status === 'cancelled') { reason = `status ${status}`; return 'failed'; }
    return 'running';
  }, { timeout: KERNEL_TIMEOUT_MS, message: 'plastic-bar run must finish or report its real failure' }).not.toBe('running');
  if (reason !== '') throw new Error(`plastic-bar run failed: ${reason}`);
}
/** The two shown summary values, each the 9-digit rounding of a value the product requires to be <= 1e-8. */
async function expectSummary(panel: Locator): Promise<void> {
  for (const label of [EQUILIBRIUM, DEVIATION]) {
    const line = results(panel).locator('p').filter({ hasText: `${label}: ` });
    await expect(line).toHaveCount(1);
    const text = (await line.innerText()).slice(label.length + 2);
    const shown = Number(text);
    expect(text.trim() !== '' && Number.isFinite(shown), `${label}: ${text}`).toBe(true);
    expect(shown, label).toBeGreaterThanOrEqual(0);
    expect(shown, label).toBeLessThanOrEqual(1e-8);
  }
}
async function readShown(panel: Locator): Promise<Shown> {
  const rows = results(panel).getByTestId('plastic-bar-samples').locator('tbody tr');
  const count = await rows.count();
  const shown: (readonly string[])[] = [];
  for (let index = 0; index < count; index += 1) shown.push(await rows.nth(index).locator('td').allTextContents());
  return shown;
}
function compareShown(shown: Shown, expected: readonly Expected[], label: string): void {
  expect(shown, label).toHaveLength(expected.length);
  for (const [index, row] of expected.entries()) {
    const cells = shown[index];
    const name = `${label} step ${String(row.step)}`;
    expect(cells, name).toHaveLength(5);
    expect(cells[0], name).toBe(String(row.step));
    nearShown(cells[1], row.target, BOUND.target, `${name} end displacement (mm)`);
    nearShown(cells[2], row.stress, BOUND.stress, `${name} stress (MPa)`);
    nearShown(cells[3], row.plastic, BOUND.plastic, `${name} plastic strain`);
    nearShown(cells[4], row.force, BOUND.force, `${name} axial force (N)`);
  }
}

function savedPlasticBar(bytes: Uint8Array) {
  const read = readPcadFile(bytes);
  if (!read.ok) throw new Error(read.error.message);
  const found = read.document.beamAnalysisInputs?.analyses.find(row => row.kind === 'plastic-bar');
  if (found?.kind !== 'plastic-bar') throw new Error('Missing saved plastic-bar input');
  return found.definition;
}

/**
 * Real panel, the real FEM Worker (Pyodide and the packaged OOFEM MisesMat) and a real saved file, in one test:
 * plateau run from typed inputs → the saved file holds plateauPlasticStrain 0.01 → close, reopen, the inputs (1% as
 * 0.01) come back → the same run gives the same plateau law → a plateau edit removes the result → an empty plateau
 * runs the original linear law. Every shown table cell is compared with the exact rational of the independent oracle.
 */
export async function plasticBarPlateauFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const events: string[] = [], errors: string[] = [];
  const runs: { readonly label: string; readonly cells: Shown }[] = [];
  let saved: unknown = null;
  let started = 0, closed = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('worker', worker => {
    if (!FEM_WORKER.test(worker.url())) return;
    started += 1; events.push(`started ${String(started)}`);
    worker.once('close', () => { closed += 1; events.push(`closed ${String(closed)}`); });
  });
  const quiet = async (): Promise<void> => {
    expect(started).toBeGreaterThan(0);
    await expect.poll(() => closed, { timeout: KERNEL_TIMEOUT_MS }).toBe(started);
  };
  const run = async (panel: Locator, label: string, expected: readonly Expected[]): Promise<Shown> => {
    await expectFieldsSettled(panel);
    await expect(alerts(panel)).toHaveCount(0);
    await expect(results(panel)).toHaveCount(0);
    const previous = started;
    const button = panel.getByTestId('plastic-bar-run');
    await expect(button).toBeEnabled();
    await button.click();
    await waitForResult(panel);
    await expect(panel.getByTestId('plastic-bar-status')).toHaveAttribute('data-status', 'complete');
    await expect(panel.getByTestId('plastic-bar-yielded')).toHaveAttribute('data-yielded', 'true');
    await expectSummary(panel);
    const shown = await readShown(panel);
    runs.push({ label, cells: shown });
    compareShown(shown, expected, label);
    expect(started).toBeGreaterThan(previous);
    await quiet();
    events.push(`${label} compared ${String(shown.length)} rows`);
    return shown;
  };
  try {
    if (app === undefined) { await disableFilePickers(page); await page.goto('/'); }
    await waitForSettledRecompute(page);

    // Inputs typed into the real panel; the first knot 0 is fixed, five more points are added.
    let panel = await openPanel(page);
    await expect(results(panel)).toHaveCount(0);
    await expect(panel.getByTestId('plastic-bar-saved')).toHaveAttribute('data-saved', 'false');
    for (const [key, value] of VALUES) await field(panel, key).fill(value);
    await panel.getByTestId('plastic-bar-source').fill(REFERENCE);
    for (const [index, value] of KNOTS.entries()) {
      if (index > 0) await panel.getByTestId('plastic-bar-add-knot').click();
      await expect(panel.locator('[data-plastic-bar-knot]')).toHaveCount(index + 1);
      await field(panel, `knot:${String(index)}`).fill(value);
    }
    const first = await run(panel, 'plateau', PLATEAU_ROWS);

    // Save the inputs into the document, close the panel and save the file; the bytes are read back here.
    await panel.getByTestId('plastic-bar-save').click();
    await expect(alerts(panel)).toHaveCount(0);
    await expect(panel.getByTestId('plastic-bar-saved')).toHaveAttribute('data-saved', 'true');
    await panel.getByTestId('plastic-bar-close').click();
    await expect(panel).toHaveCount(0);
    await quiet();
    const definition = savedPlasticBar(await saveFlowFile(page, info.outputPath(FILENAME), app));
    saved = definition;
    expect(definition).toMatchObject({ units: 'N-mm', lengthMm: 1000, areaMm2: 100, youngModulusMPa: 200000,
      poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 2000, plateauPlasticStrain: 0.01,
      endDisplacementMm: [0, 5, 20, 19, -5, 0], stepsPerSegment: 3,
      materialSource: { kind: 'user-supplied', reference: REFERENCE } });
    expect(definition.plateauPlasticStrain).toBe(0.01);
    expect(definition.hardeningEvidence).toBeUndefined();

    // Reopen the saved file through the host's file gateway; the inputs come back, no result does.
    await reopenPart(page, info, FILENAME, app);
    panel = await openPanel(page);
    await expect(results(panel)).toHaveCount(0);
    for (const [key, value] of RESTORED) await expect(field(panel, key), key).toHaveValue(value);
    await expect(panel.locator('[data-plastic-bar-knot]')).toHaveCount(KNOTS.length);
    for (const [index, value] of KNOTS.entries()) await expect(field(panel, `knot:${String(index)}`)).toHaveValue(value);
    await expect(panel.getByTestId('plastic-bar-source')).toHaveValue(REFERENCE);
    await expect(panel.getByTestId('plastic-bar-saved')).toHaveAttribute('data-saved', 'true');

    // The same plateau law again: the same oracle rows and the same shown cells as the first run.
    const again = await run(panel, 'plateau after reopen', PLATEAU_ROWS);
    expect(again).toEqual(first);

    // A plateau edit discards the shown result at once (no run).
    await field(panel, 'plateau').fill('2%');
    await expect(results(panel)).toHaveCount(0);
    await expect(panel.getByTestId('plastic-bar-status')).toHaveAttribute('data-status', 'editing');
    await expect(panel.getByTestId('plastic-bar-saved')).toHaveAttribute('data-saved', 'false');
    await quiet();

    // An empty plateau returns to the original linear law (hardening H from the first yield).
    await field(panel, 'plateau').fill('');
    await expect(field(panel, 'plateau')).toHaveValue('');
    await expect(results(panel)).toHaveCount(0);
    const linear = await run(panel, 'linear (empty plateau)', LINEAR_ROWS);
    expect(linear[0][2]).not.toBe(first[0][2]);
    expect(errors).toEqual([]);
  } finally {
    const path = info.outputPath(RECORD);
    await writeFile(path, `${JSON.stringify({ schema: 'pointercad-e2e-plastic-bar-plateau/1', project: info.project.name,
      events, errors, started, closed, runs, saved }, null, 2)}\n`, { flag: 'wx' });
    await info.attach('plastic-bar-plateau-record', { path, contentType: 'application/json' });
  }
}
