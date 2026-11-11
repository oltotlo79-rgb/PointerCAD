import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { expectFemQuiet, holdFirstFemAsset, trackFemWorkers, type AssetHold } from './analysisResultBindingFlow.js';
import { holdElectronFemAsset } from './electronFemAssetHold.js';
import { disableFilePickers } from './filePickers.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { reopenPart } from './reopenPart.js';
import { saveFlowFile } from './saveResponsivenessFlow.js';
import { clickWorldPoint, commitPopover, fillFields, popover, popoverTitle, selectionKindLabel, sketchTool } from './solidCaptureSupport.js';

/*
 * rev40: the real native linear tet4 solid stress of the current part goes to the existing solid-proportional fatigue
 * path (fatigueSolid.ts -> fatigueTensor.ts -> fatigue.ts) through the real screens only: clicks, typing and the existing
 * file save/open routes; nothing writes the store and no result is injected. The fatigue estimate is post-processing of
 * the retained native result (no native solve of its own). Native solves: one cancelled (asset hold), the initial one,
 * and one after reopening. Same flow for Chromium, Firefox and Electron.
 *
 * Independent oracle (not copied from the product): the six Cauchy components shown for the selected element are the
 * input of the post-processing; von Mises is recomputed here from them by the closed formula, and the counting is by
 * hand. Load factors 1, -0.5, 0.5, -1 repeated periodically (closed loop restarted at the largest value) give, for either
 * sign of the equivalent stress s, one full cycle of range |s| and two half cycles of range 2|s|, all with mean 0
 * (three-point stack rainflow as described in fatigue.ts countRainflow). With the single-slope curve
 * N = Nref (Sref / S)^m (fatigue.json curveHelp; fatigue.ts cycleDamage) on the range:
 *   D = R ((|s| / Sref)^m + (2 |s| / Sref)^m) / Nref = R (1 + 2^m) (|s| / Sref)^m / Nref, life = 1 / D.
 * The curve is a synthetic test-only calibration (Sref 1 MPa, Nref 1e6, m 3, no cut-off, fully reversed): it is not a
 * material value and the estimate is no material or structural guarantee.
 * Tolerance: the components are shown with 9 significant digits (beamDisplayNumber). Each displayed value is within half
 * a unit of its 9th digit; the first-order bound of the von Mises error is sum |dVM/dc_i| h_i, the damage error is m
 * times that relative bound, plus 5e-9 for the 9-digit display of the damage/life and 1e-12 for double evaluation.
 */

const FEM_ASSET = /\/fem\/assets\/[^/]+$/u;
// Loaded top face 40 x 30 mm, traction Z -0.001 N/mm^2: total force Z = -1.2 N (independent of the product).
const LOADED_AREA_MM2 = 1200;
const TRACTION_Z = -0.001;
const TOTAL_FORCE_Z = LOADED_AREA_MM2 * TRACTION_Z;
const CANCEL_E = '105000';
const CURVE = { referenceStress: 1, referenceCycles: 1_000_000, slope: 3 } as const;
// analyzeCadSolid performs one mesh request and one solve request in separate one-shot Workers.
const WORKERS_PER_SOLID_ANALYSIS = 2;
const REPEATS = 1000;
const FACTORS = [1, -0.5, 0.5, -1] as const;
const FACTORS_TEXT = FACTORS.map(String).join(', ');
const DOUBLED_TEXT = FACTORS.map(value => String(2 * value)).join(', ');
/** Texts copied from packages/ui/src/i18n/ja/fatigue.json (this spec cannot import the JSON). */
const TEXT = {
  refused: '選択と現在のソリッド結果、荷重係数、曲線の適用範囲を確認してください。別の版やメッシュの結果は使えません。',
  editing: '入力を確かめてから「計算する」を押してください。入力を変えると前の結果は消えます。',
  complete: '計算が終わりました。',
} as const;

type Tensor = readonly [number, number, number, number, number, number];

function vonMises([xx, yy, zz, yz, xz, xy]: Tensor): number {
  return Math.sqrt(((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) / 2 + 3 * (yz * yz + xz * xz + xy * xy));
}
/** Half a unit of the 9th significant digit of a displayed value; an exact 0 is displayed as 0. */
function halfUnit(value: number): number {
  return value === 0 ? 0 : 0.5 * 10 ** (Math.floor(Math.log10(Math.abs(value))) - 8);
}
/** First-order relative bound of the von Mises error caused by the 9-digit display of the components. */
function vonMisesRelativeBound(tensor: Tensor): number {
  const [xx, yy, zz, yz, xz, xy] = tensor;
  const vm = vonMises(tensor);
  const gradient = [(2 * xx - yy - zz) / (2 * vm), (2 * yy - zz - xx) / (2 * vm), (2 * zz - xx - yy) / (2 * vm),
    3 * yz / vm, 3 * xz / vm, 3 * xy / vm];
  return gradient.reduce((sum, g, index) => sum + Math.abs(g) * halfUnit(tensor[index] ?? 0), 0) / vm;
}
function expectedDamage(vm: number, factorScale: number): number {
  return REPEATS * (1 + 2 ** CURVE.slope) * (factorScale * vm / CURVE.referenceStress) ** CURVE.slope / CURVE.referenceCycles;
}

function input(panel: Locator, name: string): Locator { return panel.getByRole('textbox', { name, exact: true }); }
/** Existing fatigue fields carry data-fatigue-field on the input or its wrapper (as fatigueDetailFlow.ts). */
function field(panel: Locator, key: string): Locator {
  return panel.locator(`[data-fatigue-field="${key}"] input, [data-fatigue-field="${key}"] textarea, [data-fatigue-field="${key}"] select, input[data-fatigue-field="${key}"], textarea[data-fatigue-field="${key}"], select[data-fatigue-field="${key}"]`);
}
async function resultValue(result: Locator, label: string): Promise<string> {
  return result.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]').innerText();
}
function lastNumber(text: string): number {
  const match = [...text.replaceAll(',', '').matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/gu)].at(-1);
  if (match === undefined) throw new Error(`no number in ${JSON.stringify(text)}`);
  return Number(match[0]);
}

async function openAnalysis(page: Page): Promise<Locator> {
  await openToolMenu(page, '解析');
  await toolMenuPanel(page, '解析').getByRole('button', { name: '現在の立体を解析', exact: true }).click();
  const panel = page.getByTestId('solid-analysis-panel');
  await expect(panel).toBeVisible();
  return panel;
}
async function expectNoSolidResult(panel: Locator): Promise<void> {
  await expect(panel.getByTestId('solid-results')).toHaveCount(0);
  await expect(panel.getByTestId('solid-field-empty')).toBeVisible();
  await expect(panel.getByTestId('solid-fatigue-open')).toHaveCount(0);
}
/** One real native solve; a shown compute error fails at once with its text. Oracle: area x traction and reaction. */
async function solve(panel: Locator): Promise<void> {
  await panel.getByTestId('solid-run').click();
  const result = panel.getByTestId('solid-results'), alert = panel.locator(':scope > [role="alert"]');
  await expect(result.or(alert).first()).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  if (await alert.count() > 0) throw new Error(`solid analysis failed: ${(await alert.allInnerTexts()).join(' | ')}`);
  expect(Number.parseFloat(await resultValue(result, '荷重面積'))).toBeCloseTo(LOADED_AREA_MM2, 6);
  expect(Number.parseFloat((await resultValue(result, '荷重合力 X, Y, Z')).split(',')[2])).toBeCloseTo(TOTAL_FORCE_Z, 6);
  expect(Number.parseFloat((await resultValue(result, '支持反力の合計 X, Y, Z')).split(',')[2])).toBeCloseTo(-TOTAL_FORCE_Z, 4);
}
async function openFatigue(page: Page, solidPanel: Locator): Promise<Locator> {
  await solidPanel.getByTestId('solid-fatigue-open').click();
  const panel = page.getByTestId('fatigue-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('fatigue-input-mode')).toHaveValue('solid-proportional');
  await expect(panel.getByTestId('fatigue-solid-source')).toBeVisible();
  return panel;
}
async function expectNoFatigueResult(panel: Locator): Promise<void> {
  await expect(panel.getByTestId('fatigue-results')).toHaveCount(0);
  await expect(panel.getByTestId('fatigue-status')).toHaveText(TEXT.editing);
}
/** Runs the post-processing; a refusal shown after the run fails at once with its text (typing-time states are not read). */
async function runFatigue(panel: Locator): Promise<void> {
  await panel.getByTestId('fatigue-run').click();
  const results = panel.getByTestId('fatigue-results'), error = panel.getByTestId('fatigue-error');
  await expect(results.or(error).first()).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  if (await error.count() > 0) {
    const diagnostic = panel.getByTestId('fatigue-diagnostic');
    throw new Error(`fatigue refused: ${await error.innerText()}${await diagnostic.count() > 0 ? ` (${await diagnostic.innerText()})` : ''}`);
  }
  await expect(panel.getByTestId('fatigue-status')).toHaveText(TEXT.complete);
}
async function shownTensor(panel: Locator): Promise<Tensor> {
  const values = await panel.getByTestId('fatigue-solid-provenance').locator('dl > div > dd').allInnerTexts();
  expect(values).toHaveLength(6);
  const numbers = values.map(text => {
    const match = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?) MPa$/u.exec(text.trim());
    if (match === null) throw new Error(`unexpected component text ${JSON.stringify(text)}`);
    return Number(match[1]);
  });
  const [xx = NaN, yy = NaN, zz = NaN, yz = NaN, xz = NaN, xy = NaN] = numbers;
  return [xx, yy, zz, yz, xz, xy];
}
interface Checked { readonly vm: number; readonly bound: number }
/** Checks damage, life and the hand-counted cycles against the independent oracle; returns the von Mises used and its
 * relative display bound. */
async function expectIndependentResult(panel: Locator, element: number, factorScale: number): Promise<Checked> {
  const provenance = panel.getByTestId('fatigue-solid-provenance');
  await expect(provenance).toContainText(`選択中の要素: ${element}`);
  const tensor = await shownTensor(panel);
  const vm = vonMises(tensor);
  expect(Number.isFinite(vm) && vm > 0).toBe(true);
  const bound = vonMisesRelativeBound(tensor);
  const tolerance = CURVE.slope * bound + 5e-9 + 1e-12;
  const damage = expectedDamage(vm, factorScale);
  const shownDamage = lastNumber(await panel.getByTestId('fatigue-damage').innerText());
  expect(Math.abs(shownDamage - damage) / damage).toBeLessThanOrEqual(tolerance);
  await expect(panel.getByTestId('fatigue-life')).toHaveAttribute('data-life', 'finite');
  const shownLife = lastNumber(await panel.getByTestId('fatigue-life').innerText());
  expect(Math.abs(shownLife - 1 / damage) * damage).toBeLessThanOrEqual(tolerance);
  const row = panel.getByTestId('fatigue-history-results').locator('tr[data-fatigue-history-result="0"] td');
  await expect(row.nth(1)).toHaveText('1');
  await expect(row.nth(2)).toHaveText('2');
  await expect(panel.getByTestId('fatigue-history-results').locator('tr[data-fatigue-history-result]')).toHaveCount(1);
  return { vm, bound };
}
async function elementCount(panel: Locator): Promise<number> {
  const match = /（(\d+)要素）/u.exec(await panel.getByTestId('fatigue-solid-source').innerText());
  if (match === null) throw new Error('element count not shown');
  return Number(match[1]);
}
/** "documentId; revision; meshKey; inputSha256" of the current retained native result, as the panel shows it. */
async function currentIdentity(panel: Locator): Promise<string> {
  const code = panel.getByTestId('fatigue-solid-selection').locator('details code');
  await expect(code).toHaveCount(1);
  return (await code.textContent()) ?? '';
}
async function configureFatigue(panel: Locator): Promise<void> {
  await field(panel, 'stressDefinition').selectOption('range');
  await field(panel, 'meanStressAssumption').selectOption('fully-reversed-only');
  await field(panel, 'referenceStress').fill(String(CURVE.referenceStress));
  await field(panel, 'referenceCycles').fill(String(CURVE.referenceCycles));
  await field(panel, 'slope').fill(String(CURVE.slope));
  await field(panel, 'cutoffMode').selectOption('none');
  await field(panel, 'curve:reference').fill('Synthetic test-only single-slope curve (not a material value)');
  await field(panel, 'curve:condition').fill('rev40 hand-derived oracle only');
  await expect(panel.getByTestId('fatigue-correction-mode')).toHaveValue('none');
  await field(panel, 'history:0:stress').fill(FACTORS_TEXT);
  await field(panel, 'history:0:sequence').selectOption('repeated-periodic');
  await field(panel, 'history:0:repeats').fill(String(REPEATS));
  await field(panel, 'history:0:reference').fill('Hand-written proportional load factors');
}

export async function analysisFatigueNativeFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const workers = trackFemWorkers(page);
  if (app === undefined) { await disableFilePickers(page); await page.goto('/'); }
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  // The actual box tool creates 40 x 30 x 10 mm centred at the origin (as analysisStaticPersistenceFlow.ts).
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await fillFields(page, ['40', '30', '10']);
  const generation = await beginRecompute(page);
  await commitPopover(page); await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, generation);
  await sketchTool(page, '選択').click(); await page.keyboard.press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  let solid = await openAnalysis(page);
  await clickWorldPoint(page, [20, 0, 0]); await solid.getByTestId('solid-fixed').click();
  await clickWorldPoint(page, [0, 0, 5]); await solid.getByTestId('solid-loaded').click();
  await expect(solid.getByTestId('solid-fixed')).toHaveText('選択面を固定 (1)');
  await expect(solid.getByTestId('solid-loaded')).toHaveText('選択面に荷重 (1)');
  await input(solid, '面荷重 Z (N/mm²)').fill(String(TRACTION_Z));
  await input(solid, 'ヤング率 E (MPa)').fill('210000');
  await input(solid, 'ポアソン比 ν').fill('0.3');
  await input(solid, '曲面の最大体積差 (mm³)').fill('1');
  await expectNoSolidResult(solid);

  // Cancel of the solid analysis the fatigue estimate rests on: one real FEM asset request of its first Worker is held,
  // the material edit cancels the run, the Worker closes while held, the real response is then released, no result.
  const hold: AssetHold = app === undefined ? await holdFirstFemAsset(page) : await holdElectronFemAsset(app);
  try {
    await solid.getByTestId('solid-run').click();
    await expect.poll(() => hold.held(), { timeout: KERNEL_TIMEOUT_MS, message: 'the FEM worker asset request must be held' })
      .toMatch(FEM_ASSET);
    await expect.poll(() => workers.started(), { timeout: KERNEL_TIMEOUT_MS }).toBe(1);
    expect(workers.closed()).toBe(0);
    const running = solid.locator(':scope > [role="status"]');
    await expect(running).toHaveAttribute('data-stage', 'meshing');
    await expect(running).toHaveText('メッシュの作成');
    await input(solid, 'ヤング率 E (MPa)').fill(CANCEL_E);
    await expect(running).toHaveCount(0);
    await expectFemQuiet(workers);
    expect(await hold.holding()).toBe(true);
    await expectNoSolidResult(solid);
    info.annotations.push({ type: 'rev40-held-fem-asset', description: await hold.release() });
  } finally {
    await hold.dispose();
  }
  expect(workers.started()).toBe(1);
  await expectNoSolidResult(solid);

  // Native solve 1 (E = 105000 MPa), then the fatigue estimate of its retained result.
  await solve(solid);
  await expectFemQuiet(workers);
  expect(workers.started()).toBe(1 + WORKERS_PER_SOLID_ANALYSIS);
  let fatigue = await openFatigue(page, solid);
  await expectNoFatigueResult(fatigue);
  const count = await elementCount(fatigue);
  expect(count).toBeGreaterThan(1);
  await configureFatigue(fatigue);
  await fatigue.getByTestId('fatigue-solid-element').fill('1');
  await expect(fatigue.getByTestId('fatigue-solid-saved-selection')).toHaveText('選択中の要素: 1');
  await expectNoFatigueResult(fatigue);
  await runFatigue(fatigue);
  const first = await expectIndependentResult(fatigue, 1, 1);
  const vm1 = first.vm;

  // An input edit drops the result at once; the new run follows the new factors only (2x factors -> 2^m damage) on the
  // same retained native stress (identical shown components).
  await field(fatigue, 'history:0:stress').fill(DOUBLED_TEXT);
  await expectNoFatigueResult(fatigue);
  await runFatigue(fatigue);
  expect((await expectIndependentResult(fatigue, 1, 2)).vm).toBe(vm1);
  await field(fatigue, 'history:0:stress').fill(FACTORS_TEXT);
  await expectNoFatigueResult(fatigue);

  // Explicit element selection by the maximum button: a different binding drops the result; its own oracle follows and
  // its von Mises cannot be below element 1's beyond the display bound.
  await fatigue.getByTestId('fatigue-solid-maximum').click();
  const maximum = Number(await fatigue.getByTestId('fatigue-solid-element').inputValue());
  expect(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= count).toBe(true);
  await expectNoFatigueResult(fatigue);
  await runFatigue(fatigue);
  const largest = await expectIndependentResult(fatigue, maximum, 1);
  // Both von Mises values come from 9-digit components; compare only beyond their own first-order display bounds.
  expect(largest.vm * (1 + largest.bound)).toBeGreaterThanOrEqual(vm1 * (1 - first.bound));

  // Back to element 1 for the saved input (typed: '' then '1' rebinds even if the maximum was element 1).
  await fatigue.getByTestId('fatigue-solid-element').fill('');
  await expectNoFatigueResult(fatigue);
  await fatigue.getByTestId('fatigue-solid-element').fill('1');
  await runFatigue(fatigue);
  expect((await expectIndependentResult(fatigue, 1, 1)).vm).toBe(vm1);

  // Saving the input changes the document: the earlier result is no longer shown (its snapshot is stale) and only a
  // fresh run of the same saved input shows a result again.
  await fatigue.getByTestId('fatigue-save').click();
  await expect(fatigue.getByTestId('fatigue-saved')).toHaveAttribute('data-saved', 'true');
  await expectNoFatigueResult(fatigue);
  await runFatigue(fatigue);
  expect((await expectIndependentResult(fatigue, 1, 1)).vm).toBe(vm1);
  await expect(fatigue.getByTestId('fatigue-saved')).toHaveAttribute('data-saved', 'true');
  await fatigue.getByTestId('fatigue-close').click();
  await expect(fatigue).toHaveCount(0);

  // Solid inputs are saved too; a different solid input (E) removes the native result and with it the way to fatigue.
  solid = page.getByTestId('solid-analysis-panel');
  await expect(solid.getByTestId('solid-results')).toBeVisible();
  await solid.getByTestId('solid-save').click();
  await expect(solid.locator(':scope > [role="alert"]')).toHaveCount(0);
  await input(solid, 'ヤング率 E (MPa)').fill('210000');
  await expectNoSolidResult(solid);
  await input(solid, 'ヤング率 E (MPa)').fill(CANCEL_E);
  await expectNoSolidResult(solid);
  await expectFemQuiet(workers);
  // Fatigue post-processing, saving and input edits must not start additional native workers.
  expect(workers.started()).toBe(1 + WORKERS_PER_SOLID_ANALYSIS);
  await solid.getByRole('button', { name: '戻る', exact: true }).click();

  // The file holds the inputs and the binding only: no stress, cycles, damage or life.
  const filename = 'fatigue-native.pcad';
  const read = readPcadFile(new Uint8Array(await saveFlowFile(page, info.outputPath(filename), app)));
  if (!read.ok) throw new Error(read.error.message);
  const analyses = read.document.beamAnalysisInputs?.analyses ?? [];
  const solidSaved = analyses.find(row => row.kind === 'solid-cad');
  expect(solidSaved?.kind === 'solid-cad' ? solidSaved.definition.youngMPa : null).toBe(Number(CANCEL_E));
  const fatigueSaved = analyses.find(row => row.kind === 'fatigue-solid-proportional');
  const definition = fatigueSaved?.kind === 'fatigue-solid-proportional' ? fatigueSaved.definition : null;
  if (definition === null) throw new Error('solid fatigue input not saved');
  expect(definition).toMatchObject({ schema: 'pointercad-fatigue-solid-saved/1', elementIndex: 0, loadFactors: [...FACTORS],
    sequence: 'repeated-periodic', repeats: REPEATS, curve: { stressDefinition: 'range', meanStressAssumption: 'fully-reversed-only',
      referenceStressMpa: CURVE.referenceStress, referenceCycles: CURVE.referenceCycles, slope: CURVE.slope, cutoffStressMpa: null } });
  expect(JSON.stringify(read.document.beamAnalysisInputs)).not.toMatch(/"(?:result|stressMPa|damage|cycles|life|solidAnalyzed|provenance)"\s*:/u);
  const savedIdentity = `${definition.source.documentId}; ${definition.source.revision}; ${definition.source.meshKey}; ${definition.inputSha256}`;
  expect(definition.inputSha256).toMatch(/^[a-f0-9]{64}$/u);

  // Reopen through the existing host route: inputs are back, no solid or fatigue result until the native solve.
  await reopenPart(page, info, filename, app);
  solid = await openAnalysis(page);
  await expectNoSolidResult(solid);
  await expect(solid.getByTestId('solid-fixed')).toHaveText('選択面を固定 (1)');
  await expect(solid.getByTestId('solid-loaded')).toHaveText('選択面に荷重 (1)');
  await expect(input(solid, 'ヤング率 E (MPa)')).toHaveValue(CANCEL_E);
  const beforeReopenSolve = workers.started();
  await solve(solid); // native solve 2
  expect(workers.started()).toBe(beforeReopenSolve + WORKERS_PER_SOLID_ANALYSIS);
  await expectFemQuiet(workers);
  fatigue = await openFatigue(page, solid);
  await expectNoFatigueResult(fatigue);
  await expect(fatigue.getByTestId('fatigue-saved')).toHaveAttribute('data-saved', 'true');
  await expect(fatigue.getByTestId('fatigue-solid-element')).toHaveValue('1');
  await expect(field(fatigue, 'history:0:stress')).toHaveValue(FACTORS_TEXT);
  await expect(field(fatigue, 'history:0:sequence')).toHaveValue('repeated-periodic');
  // The restored curve and repeats are shown in the product's exact expression form (exactExpressionValueFromNumber), so
  // their text is not guessed here: data-saved above is the product's own equality with the saved input, and the final
  // run below must match the independent oracle built from Sref, Nref, m and R.

  // The saved binding is used only if it names exactly the current native result (identity read from the file and the
  // panel, not assumed); otherwise the run is refused and shows no result.
  const identity = await currentIdentity(fatigue);
  expect(identity).toContain(definition.source.documentId);
  await fatigue.getByTestId('fatigue-run').click();
  if (identity === savedIdentity) {
    const results = fatigue.getByTestId('fatigue-results'), error = fatigue.getByTestId('fatigue-error');
    await expect(results.or(error).first()).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    if (await error.count() > 0) throw new Error(`fatigue refused for an identical binding: ${await error.innerText()}`);
    info.annotations.push({ type: 'rev40-reopen-binding', description: 'identical to the saved binding: run accepted' });
  } else {
    await expect(fatigue.getByTestId('fatigue-error')).toHaveText(TEXT.refused, { timeout: KERNEL_TIMEOUT_MS });
    await expectNoFatigueResult(fatigue);
    info.annotations.push({ type: 'rev40-reopen-binding', description: `saved ${savedIdentity} != current ${identity}: refused` });
  }
  // Explicit rebinding to the current native result, then the recalculation from it.
  await fatigue.getByTestId('fatigue-solid-element').fill('');
  await expectNoFatigueResult(fatigue);
  await fatigue.getByTestId('fatigue-solid-element').fill('1');
  await runFatigue(fatigue);
  await expectIndependentResult(fatigue, 1, 1);
  await expectFemQuiet(workers);
  expect(errors).toEqual([]);
}
