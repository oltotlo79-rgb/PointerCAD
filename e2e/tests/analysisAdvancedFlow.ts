import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { disableFilePickers } from './filePickers.js';
import { holdFirstFemAsset } from './analysisResultBindingFlow.js';
import { holdElectronFemAsset } from './electronFemAssetHold.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { reopenPart } from './reopenPart.js';
import { saveFlowFile } from './saveResponsivenessFlow.js';
import { clickWorldPoint, commitPopover, fillFields, popover, popoverTitle, selectionKindLabel, sketchTool } from './solidCaptureSupport.js';

type Mode = 'modal' | 'buckling';
const FEM_WORKER = /\/fem\/worker\.js$/u;
const FEM_ASSET = /\/fem\/assets\/[^/]+$/u;
const BOUND = 1e-8; // Native and decoder acceptance in solidModal.py / solidBucklingResults.ts.

function input(panel: Locator, name: string): Locator { return panel.getByRole('textbox', { name, exact: true }); }
async function panelOf(page: Page): Promise<Locator> {
  await openToolMenu(page, '解析');
  await toolMenuPanel(page, '解析').getByRole('button', { name: '現在の立体を解析', exact: true }).click();
  const panel = page.getByTestId('solid-analysis-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function createBox(page: Page): Promise<Locator> {
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('箱を置く');
  await fillFields(page, ['40', '30', '10']);
  const token = await beginRecompute(page);
  await commitPopover(page); await expect(popover(page)).toHaveCount(0); await waitForRecompute(page, token);
  await sketchTool(page, '選択').click(); await page.keyboard.press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  const panel = await panelOf(page);
  await clickWorldPoint(page, [20, 0, 0]); await panel.getByTestId('solid-fixed').click();
  await clickWorldPoint(page, [0, 0, 5]); await panel.getByTestId('solid-loaded').click();
  await expect(panel.getByTestId('solid-fixed')).toHaveText('選択面を固定 (1)');
  await expect(panel.getByTestId('solid-loaded')).toHaveText('選択面に荷重 (1)');
  await input(panel, '面荷重 Z (N/mm²)').fill('-0.001');
  await input(panel, 'ヤング率 E (MPa)').fill('210000');
  await input(panel, 'ポアソン比 ν').fill('0.3');
  await input(panel, '曲面の最大体積差 (mm³)').fill('1');
  return panel;
}

function savedInput(bytes: Uint8Array, mode: Mode) {
  const read = readPcadFile(bytes);
  if (!read.ok) throw new Error(read.error.message);
  const kind = mode === 'modal' ? 'solid-modal-cad' : 'solid-buckling-cad';
  const found = read.document.beamAnalysisInputs?.analyses.find(row => row.kind === kind);
  if (found === undefined) throw new Error(`Missing saved ${kind} input`);
  return found;
}

async function values(panel: Locator, mode: Mode): Promise<number[]> {
  if (mode === 'modal') {
    const result = panel.getByTestId('solid-modal-results');
    await expect(result).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    const labels = await result.locator('label:has(input[name="solid-modal-mode"])').allTextContents();
    const values = labels.map((label, index) => {
      const match = /モード\s+(\d+):\s*([+\-\d.eE]+)\s*Hz/u.exec(label);
      if (match === null) throw new Error(`Invalid frequency label: ${label}`);
      expect(Number(match[1])).toBe(index + 1);
      return Number(match[2]);
    });
    expect(values).toHaveLength(2);
    expect(values.every((value, index) => Number.isFinite(value) && value > 0 && (index === 0 || value >= values[index - 1]))).toBe(true);
    return values;
  }
  const result = panel.getByTestId('solid-buckling-results');
  await expect(result).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  const rows = result.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  const factors: number[] = [];
  for (let index = 0; index < 2; index += 1) {
    const cells = await rows.nth(index).locator('td').allTextContents();
    expect(cells).toHaveLength(3);
    expect(cells.every(cell => cell.trim() !== '')).toBe(true);
    expect(Number(cells[0])).toBe(index + 1);
    const factor = Number(cells[1]), residual = Number(cells[2]);
    expect(Number.isFinite(factor) && factor > 0 && (index === 0 || factor >= factors[index - 1])).toBe(true);
    expect(Number.isFinite(residual) && residual >= 0 && residual <= BOUND).toBe(true);
    factors.push(factor);
  }
  for (const label of ['参照状態の相対つり合い残差', '初期応力剛性の照合誤差 (要素の最大相対差)']) {
    const text = await result.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]').innerText();
    expect(text.trim()).not.toBe('');
    const residual = Number(text);
    expect(Number.isFinite(residual) && residual >= 0 && residual <= BOUND).toBe(true);
  }
  return factors;
}

/** Do not spend the whole test budget waiting when the real run already reported an error. */
async function waitForResult(panel: Locator, mode: Mode): Promise<void> {
  const prefix = mode === 'modal' ? 'solid-modal' : 'solid-buckling';
  let reason = '';
  await expect.poll(async () => {
    if (await panel.getByTestId(`${prefix}-results`).isVisible()) return 'result';
    for (const suffix of ['error', 'failed']) {
      const issue = panel.getByTestId(`${prefix}-${suffix}`);
      if (await issue.isVisible()) {
        reason = (await issue.innerText()) || `${prefix}-${suffix}`;
        return 'failed';
      }
    }
    return 'running';
  }, { timeout: KERNEL_TIMEOUT_MS, message: `${prefix} must finish or report its real failure` }).not.toBe('running');
  if (reason !== '') throw new Error(`${prefix} failed: ${reason}`);
}

export async function analysisAdvancedFlow(page: Page, info: TestInfo, mode: Mode, app?: ElectronApplication): Promise<void> {
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
  try {
    if (app === undefined) { await disableFilePickers(page); await page.goto('/'); }
    let panel = await createBox(page);
    if (mode === 'modal') {
      await panel.getByTestId('solid-modal-density').fill('7850');
      await panel.getByTestId('solid-modal-count').fill('2');
    } else await panel.getByTestId('solid-buckling-count').fill('2');
    const resultId = mode === 'modal' ? 'solid-modal-results' : 'solid-buckling-results';
    const prefix = mode === 'modal' ? 'solid-modal' : 'solid-buckling';
    await expect(panel.getByTestId(resultId)).toHaveCount(0);
    const hold = app === undefined ? await holdFirstFemAsset(page) : await holdElectronFemAsset(app);
    try {
      await panel.getByTestId(`${prefix}-run`).click();
      await expect.poll(() => hold.held(), { timeout: KERNEL_TIMEOUT_MS }).toMatch(FEM_ASSET);
      await expect.poll(() => started, { timeout: KERNEL_TIMEOUT_MS }).toBe(1);
      expect(closed).toBe(0);
      await expect(panel.getByTestId(`${prefix}-cancel`)).toBeEnabled();
      expect(await hold.holding()).toBe(true);
      await expect(panel.getByTestId(resultId)).toHaveCount(0);
      events.push('asset held before cancellation');
      await panel.getByTestId(`${prefix}-cancel`).click();
      await quiet();
      expect(started).toBe(1); expect(closed).toBe(1);
      expect(await hold.holding()).toBe(true);
      await expect(panel.getByTestId(resultId)).toHaveCount(0);
      events.push(`released after worker closed: ${await hold.release()}`);
      await expect(panel.getByTestId(resultId)).toHaveCount(0);
      expect(started).toBe(1);
    } finally { await hold.dispose(); }

    const run = async (): Promise<number[]> => {
      const previous = started;
      await panel.getByTestId(`${prefix}-run`).click();
      await waitForResult(panel, mode);
      const result = await values(panel, mode);
      expect(started).toBeGreaterThan(previous);
      await quiet();
      return result;
    };
    const original = await run();
    await panel.getByTestId(`${prefix}-save`).click();
    await panel.getByRole('button', { name: '戻る', exact: true }).click();
    const filename = `advanced-${mode}.pcad`;
    const initial = savedInput(await saveFlowFile(page, info.outputPath(filename), app), mode);
    if (mode === 'modal') {
      if (initial.kind !== 'solid-modal-cad') throw new Error('Incorrect modal saved input');
      expect(initial.definition.densityKgM3).toBe(7850);
      expect(initial.definition.modeCount).toBe(2);
      expect(initial.definition.youngMPa).toBe(210000);
      expect(initial.definition.fixedFaces).toHaveLength(1);
    } else {
      if (initial.kind !== 'solid-buckling-cad') throw new Error('Incorrect buckling saved input');
      expect(initial.definition.modeCount).toBe(2);
      expect(initial.definition.reference.fixedFaces).toHaveLength(1);
      expect(initial.definition.reference.loadedFaces).toHaveLength(1);
      expect(initial.definition.reference.youngMPa).toBe(210000);
      expect(initial.definition.reference.tractionMPa).toEqual([0, 0, -0.001]);
    }
    await reopenPart(page, info, filename, app);
    panel = await panelOf(page);
    await expect(panel.getByTestId(resultId)).toHaveCount(0);
    await expect(panel.getByTestId('solid-fixed')).toHaveText('選択面を固定 (1)');
    await expect(input(panel, 'ヤング率 E (MPa)')).toHaveValue('210000');
    await expect(input(panel, 'ポアソン比 ν')).toHaveValue('0.3');
    const shared = initial.kind === 'solid-modal-cad' ? initial.definition
      : initial.kind === 'solid-buckling-cad' ? initial.definition.reference : null;
    if (shared === null) throw new Error('Unexpected saved analysis kind');
    for (const [label, value] of [['境界の距離公差 (mm)', shared.linearDeflectionMm],
      ['境界の角度公差 (rad)', shared.angularDeflectionRad], ['曲面の最大弦誤差 (mm)', shared.maximumChordDeviationMm],
      ['曲面の最大体積差 (mm³)', shared.maximumVolumeDeviationMm3]] as const) {
      await expect(input(panel, label)).toHaveValue(String(value));
    }
    if (mode === 'modal') {
      await expect(panel.getByTestId('solid-modal-density')).toHaveValue('7850');
      await expect(panel.getByTestId('solid-modal-count')).toHaveValue('2');
    } else {
      await expect(panel.getByTestId('solid-buckling-count')).toHaveValue('2');
      await expect(panel.getByTestId('solid-loaded')).toHaveText('選択面に荷重 (1)');
      await expect(input(panel, '面荷重 X (N/mm²)')).toHaveValue('0');
      await expect(input(panel, '面荷重 Y (N/mm²)')).toHaveValue('0');
      await expect(input(panel, '面荷重 Z (N/mm²)')).toHaveValue('-0.001');
    }
    await panel.getByTestId(`${prefix}-save`).click();
    await panel.getByRole('button', { name: '戻る', exact: true }).click();
    const roundtrip = savedInput(await saveFlowFile(page, info.outputPath(`advanced-${mode}-roundtrip.pcad`), app), mode);
    expect(roundtrip).toEqual(initial);
    panel = await panelOf(page);
    await expect(panel.getByTestId(resultId)).toHaveCount(0);

    if (mode === 'modal') await input(panel, 'ヤング率 E (MPa)').fill('840000');
    else await input(panel, '面荷重 Z (N/mm²)').fill('-0.002');
    await expect(panel.getByTestId('solid-fixed')).toHaveText('選択面を固定 (1)');
    await expect(input(panel, 'ポアソン比 ν')).toHaveValue('0.3');
    await expect(input(panel, '曲面の最大体積差 (mm³)')).toHaveValue('1');
    if (mode === 'modal') await expect(panel.getByTestId('solid-modal-density')).toHaveValue('7850');
    else {
      await expect(panel.getByTestId('solid-loaded')).toHaveText('選択面に荷重 (1)');
      await expect(input(panel, 'ヤング率 E (MPa)')).toHaveValue('210000');
    }
    await expect(panel.getByTestId(resultId)).toHaveCount(0);
    const changed = await run();
    // Same mesh and support: stiffness scales with E, and reference stress scales with traction.
    const expectedRatio = mode === 'modal' ? 2 : 0.5;
    changed.forEach((value, index) => expect(Math.abs(value / original[index] - expectedRatio) / expectedRatio).toBeLessThanOrEqual(1e-3));
    await quiet();
    expect(errors).toEqual([]);
  } finally {
    await info.attach(`advanced-${mode}-workers`, { contentType: 'application/json', body: JSON.stringify({ events, errors }) });
  }
}
