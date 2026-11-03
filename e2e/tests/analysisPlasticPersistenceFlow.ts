import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { holdFirstFemAsset } from './analysisResultBindingFlow.js';
import { holdElectronFemAsset } from './electronFemAssetHold.js';
import { disableFilePickers } from './filePickers.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { reopenPart } from './reopenPart.js';
import { saveFlowFile } from './saveResponsivenessFlow.js';
import { clickWorldPoint, commitPopover, fillFields, popover, popoverTitle, selectionKindLabel, sketchTool } from './solidCaptureSupport.js';

const FEM_WORKER = /\/fem\/worker\.js$/u;
const FEM_ASSET = /\/fem\/assets\/[^/]+$/u;
/** solidPlasticNative.test.ts near(): 1e-8 of the scale; SOLID_PLASTIC_RESIDUAL_BOUND (solidPlasticResults.ts) is 1e-8. */
const NATIVE = 1e-8;
/** analysisStaticPersistenceFlow.ts / analysisAdvancedFlow.ts (W72): ratio of two real runs to three decimals. */
const CROSS_RUN = 1e-3;
const HISTORY = '0, 0.5, 1, 0';
const FACTORS = [0.5, 1, 0] as const;
/** Far above every stress of this load, still below E as readSolidPlasticPlan requires (yield strain < 1). */
const ELASTIC_YIELD = '100000';
const REFERENCE = '数値照合用の入力値(実在の材料ではない。完全塑性 H=0 は solidPlasticNative.test.ts と同じ扱い)';
const RUNNING = 'メッシュを作成し、荷重の履歴に沿って増分ごとに計算しています。';
const CANCELLED = '計算を中止しました。結果はありません。';
const YIELDED = '降伏した要素があります。';
const NOT_YIELDED = '降伏した要素はありません。';

interface Row { readonly factor: number; readonly displacement: number; readonly stress: number;
  readonly plastic: number; readonly residual: number }
interface Outcome { readonly yielded: boolean; readonly rows: readonly [Row, Row, Row] }

function input(panel: Locator, name: string): Locator { return panel.getByRole('textbox', { name, exact: true }); }
function alerts(panel: Locator): Locator { return panel.locator(':scope > [role="alert"]'); }
function results(panel: Locator): Locator { return panel.getByTestId('solid-plastic-results'); }
async function openPlastic(page: Page): Promise<Locator> {
  await openToolMenu(page, '解析');
  await toolMenuPanel(page, '解析').getByRole('button', { name: '小変形の弾塑性', exact: true }).click();
  const panel = page.getByTestId('solid-plastic-panel');
  await expect(panel).toBeVisible();
  return panel;
}
/** |actual - expected| <= tolerance * scale, with the values in the message. */
function near(actual: number, expected: number, scale: number, tolerance: number, label: string): void {
  expect(Math.abs(actual - expected) / scale, `${label}: ${String(actual)} vs ${String(expected)}`).toBeLessThanOrEqual(tolerance);
}

/** A real failure already shown by the panel (alert or cancelled status) ends the wait at once with its text. */
async function waitForResult(panel: Locator): Promise<void> {
  let reason = '';
  await expect.poll(async () => {
    if (await results(panel).isVisible()) return 'result';
    if (await alerts(panel).count() > 0) { reason = (await alerts(panel).first().innerText()) || 'alert'; return 'failed'; }
    if (await panel.getByText(CANCELLED, { exact: true }).isVisible()) { reason = CANCELLED; return 'failed'; }
    return 'running';
  }, { timeout: KERNEL_TIMEOUT_MS, message: 'solid plastic run must finish or report its real failure' }).not.toBe('running');
  if (reason !== '') throw new Error(`solid plastic run failed: ${reason}`);
}

async function readOutcome(panel: Locator): Promise<Outcome> {
  const result = results(panel);
  const yielded = await result.getByText(YIELDED, { exact: true }).count() === 1;
  await expect(result.getByText(yielded ? YIELDED : NOT_YIELDED, { exact: true })).toHaveCount(1);
  await expect(result.getByText(yielded ? NOT_YIELDED : YIELDED, { exact: true })).toHaveCount(0);
  const body = result.locator('tbody tr');
  await expect(body).toHaveCount(FACTORS.length);
  const rows: Row[] = [];
  for (const [index, factor] of FACTORS.entries()) {
    const cells = await body.nth(index).locator('td').allTextContents();
    expect(cells).toHaveLength(5);
    expect(cells.every(cell => cell.trim() !== ''), JSON.stringify(cells)).toBe(true);
    const values = cells.map(Number);
    expect(values.every(Number.isFinite), JSON.stringify(cells)).toBe(true);
    const row: Row = { factor: values[0], displacement: values[1], stress: values[2], plastic: values[3], residual: values[4] };
    expect(row.factor).toBe(factor);
    expect(row.displacement).toBeGreaterThanOrEqual(0);
    expect(row.stress).toBeGreaterThanOrEqual(0);
    expect(row.plastic).toBeGreaterThanOrEqual(0);
    expect(row.residual).toBeGreaterThanOrEqual(0);
    expect(row.residual).toBeLessThanOrEqual(NATIVE);
    rows.push(row);
  }
  return { yielded, rows: [rows[0], rows[1], rows[2]] };
}

function savedPlastic(bytes: Uint8Array) {
  const read = readPcadFile(bytes);
  if (!read.ok) throw new Error(read.error.message);
  const found = read.document.beamAnalysisInputs?.analyses.find(row => row.kind === 'solid-plastic-cad');
  if (found?.kind !== 'solid-plastic-cad') throw new Error('Missing saved solid-plastic-cad input');
  return found.definition;
}

/**
 * Real tools, the real FEM Worker (meshing and the packaged OOFEM J2 solver) and a real saved file.
 * Solves: one run cancelled while its first FEM asset is held, run A (elastic), run B (after reopen, yielding).
 */
export async function analysisPlasticPersistenceFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  const events: string[] = [], errors: string[] = [];
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
  const run = async (panel: Locator): Promise<Outcome> => {
    // Completed input: no panel error may remain before the run (field messages while typing are not checked here).
    await expect(alerts(panel)).toHaveCount(0);
    const previous = started;
    await panel.getByTestId('solid-plastic-run').click();
    // The cancelled status of an earlier run must be gone before the wait may read this run's outcome.
    await expect(panel.getByText(CANCELLED, { exact: true })).toHaveCount(0);
    await waitForResult(panel);
    const outcome = await readOutcome(panel);
    expect(started).toBeGreaterThan(previous);
    await quiet();
    return outcome;
  };
  try {
    if (app === undefined) { await disableFilePickers(page); await page.goto('/'); }
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
    await openToolMenu(page, '作る');
    await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
    await expect(popoverTitle(page)).toHaveText('箱を置く');
    await fillFields(page, ['40', '30', '10']);
    const token = await beginRecompute(page);
    await commitPopover(page); await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, token);
    await sketchTool(page, '選択').click(); await page.keyboard.press('3');
    await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');

    // Cantilever: the right end face (x = +20) is clamped in three directions, the top face (z = +5) is loaded.
    let panel = await openPlastic(page);
    await clickWorldPoint(page, [20, 0, 0]); await panel.getByTestId('solid-plastic-fixed').click();
    await clickWorldPoint(page, [0, 0, 5]); await panel.getByTestId('solid-plastic-loaded').click();
    await expect(panel.getByTestId('solid-plastic-fixed')).toHaveText('選択面を固定 (1)');
    await expect(panel.getByTestId('solid-plastic-loaded')).toHaveText('選択面に荷重 (1)');
    await input(panel, 'ヤング率 E (MPa)').fill('200000');
    await input(panel, 'ポアソン比 ν').fill('0.3');
    await input(panel, '初期降伏応力 σ0 (MPa)').fill(ELASTIC_YIELD);
    await input(panel, '硬化係数 H (MPa)').fill('0');
    await input(panel, '基準の面荷重 Z (N/mm²)').fill('-1');
    await input(panel, '曲面の最大体積差 (mm³)').fill('1');
    await panel.getByTestId('solid-plastic-reference').fill(REFERENCE);
    await panel.getByTestId('solid-plastic-history').fill(HISTORY);
    await panel.getByTestId('solid-plastic-steps').fill('4');
    await expect(results(panel)).toHaveCount(0);

    // Cancel: the first real FEM asset stays unanswered until the cancelled worker has closed.
    const hold = app === undefined ? await holdFirstFemAsset(page) : await holdElectronFemAsset(app);
    try {
      await expect(alerts(panel)).toHaveCount(0);
      await panel.getByTestId('solid-plastic-run').click();
      await expect.poll(() => hold.held(), { timeout: KERNEL_TIMEOUT_MS }).toMatch(FEM_ASSET);
      await expect.poll(() => started, { timeout: KERNEL_TIMEOUT_MS }).toBe(1);
      expect(closed).toBe(0);
      const stop = panel.getByRole('button', { name: '計算を中止', exact: true });
      await expect(stop).toBeEnabled();
      await expect(panel.getByText(RUNNING, { exact: true })).toBeVisible();
      expect(await hold.holding()).toBe(true);
      await expect(results(panel)).toHaveCount(0);
      events.push('asset held before cancellation');
      await stop.click();
      await quiet();
      expect(started).toBe(1); expect(closed).toBe(1);
      expect(await hold.holding()).toBe(true);
      await expect(panel.getByText(CANCELLED, { exact: true })).toBeVisible();
      await expect(results(panel)).toHaveCount(0);
      events.push(`released after worker closed: ${await hold.release()}`);
      await expect(results(panel)).toHaveCount(0);
      await expect(panel.getByText(CANCELLED, { exact: true })).toBeVisible();
      expect(started).toBe(1);
    } finally { await hold.dispose(); }

    // Run A, elastic (σ0 far above the stresses): linear elasticity is the oracle inside one real run.
    const a = await run(panel);
    const [halfA, fullA, restA] = a.rows;
    expect(a.yielded).toBe(false);
    expect(fullA.displacement).toBeGreaterThan(0);
    expect(fullA.stress).toBeGreaterThan(0);
    expect(fullA.stress).toBeLessThan(Number(ELASTIC_YIELD));
    near(halfA.displacement, fullA.displacement / 2, fullA.displacement, NATIVE, 'A |u| at 0.5');
    near(halfA.stress, fullA.stress / 2, fullA.stress, NATIVE, 'A von Mises at 0.5');
    near(restA.displacement, 0, fullA.displacement, NATIVE, 'A |u| after unloading');
    near(restA.stress, 0, fullA.stress, NATIVE, 'A von Mises after unloading');
    for (const row of a.rows) expect(row.plastic).toBe(0);
    events.push(`A ${JSON.stringify(a)}`);

    // Condition change: σ0 below the elastic peak of A discards the result; same mesh, supports and load otherwise.
    // Test-input generation only (a σ0 at which B yields between factors 0.5 and 1), not an accuracy proof: the B
    // expectations below come from this typed 6-digit value and the perfectly plastic J2 cap.
    const yieldB = String(Number((0.85 * fullA.stress).toPrecision(6)));
    const yieldStress = Number(yieldB);
    expect(yieldStress > fullA.stress / 2 && yieldStress < fullA.stress).toBe(true);
    await input(panel, '初期降伏応力 σ0 (MPa)').fill(yieldB);
    await expect(results(panel)).toHaveCount(0);
    await quiet();
    await expect(panel.getByTestId('solid-plastic-fixed')).toHaveText('選択面を固定 (1)');
    await expect(panel.getByTestId('solid-plastic-loaded')).toHaveText('選択面に荷重 (1)');
    await panel.getByTestId('solid-plastic-save').click();
    await expect(alerts(panel)).toHaveCount(0);
    await expect(results(panel)).toHaveCount(0);
    await quiet();
    await panel.getByRole('button', { name: '戻る', exact: true }).click();
    await expect(panel).toHaveCount(0);
    const filename = 'plastic-persistence.pcad';
    const saved = savedPlastic(await saveFlowFile(page, info.outputPath(filename), app));
    expect(saved).toMatchObject({ youngMPa: 200000, poisson: 0.3, yieldStressMPa: yieldStress, hardeningModulusMPa: 0,
      materialReference: REFERENCE, tractionMPa: [0, 0, -1], loadFactor: [0, 0.5, 1, 0], stepsPerSegment: 4,
      linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 });
    expect(saved.bodyFeatureId).not.toBe('');
    expect(saved.fixedFaces).toHaveLength(1);
    expect(saved.loadedFaces).toHaveLength(1);

    // Existing helper reloads the editor and opens the saved bytes through the host's file gateway.
    await reopenPart(page, info, filename, app);
    panel = await openPlastic(page);
    await expect(results(panel)).toHaveCount(0);
    await expect(panel.getByTestId('solid-plastic-fixed')).toHaveText('選択面を固定 (1)');
    await expect(panel.getByTestId('solid-plastic-loaded')).toHaveText('選択面に荷重 (1)');
    for (const [label, value] of [['ヤング率 E (MPa)', '200000'], ['ポアソン比 ν', '0.3'], ['初期降伏応力 σ0 (MPa)', yieldB],
      ['硬化係数 H (MPa)', '0'], ['基準の面荷重 X (N/mm²)', '0'], ['基準の面荷重 Y (N/mm²)', '0'], ['基準の面荷重 Z (N/mm²)', '-1'],
      ['境界の距離公差 (mm)', '0.1'], ['境界の角度公差 (rad)', '0.3'], ['曲面の最大弦誤差 (mm)', '0.2'],
      ['曲面の最大体積差 (mm³)', '1']] as const) await expect(input(panel, label)).toHaveValue(value);
    await expect(panel.getByTestId('solid-plastic-reference')).toHaveValue(REFERENCE);
    await expect(panel.getByTestId('solid-plastic-history')).toHaveValue(HISTORY);
    await expect(panel.getByTestId('solid-plastic-steps')).toHaveValue('4');
    await quiet();

    // Run B: below first yield, linear similarity with A (σ0 does not enter the elastic response); past it the
    // perfectly plastic J2 cap holds σ_vM = σ0 as typed.
    const b = await run(panel);
    const [halfB, fullB, restB] = b.rows;
    expect(b.yielded).toBe(true);
    near(halfB.stress, fullA.stress / 2, fullA.stress / 2, CROSS_RUN, 'B von Mises at 0.5 (elastic)');
    near(halfB.displacement, fullA.displacement / 2, fullA.displacement / 2, CROSS_RUN, 'B |u| at 0.5 (elastic)');
    expect(halfB.plastic).toBe(0);
    near(fullB.stress, yieldStress, yieldStress, NATIVE, 'B von Mises at 1 (H = 0)');
    expect(fullB.plastic).toBeGreaterThan(0);
    expect(restB.stress).toBeLessThanOrEqual(yieldStress * (1 + NATIVE));
    expect(restB.plastic).toBeGreaterThan(0);
    events.push(`B ${JSON.stringify(b)}`);
    expect(errors).toEqual([]);
  } finally {
    await info.attach('plastic-persistence-workers', { contentType: 'application/json', body: JSON.stringify({ events, errors }) });
  }
}
