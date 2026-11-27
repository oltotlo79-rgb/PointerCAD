/// <reference lib="dom" />
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { log } from 'node:console';
import { env } from 'node:process';
import { observeMathWorkers } from './mathWorkerDiagnostics.js';
import { functionPlotMessage } from './functionMessages.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { savePart } from './scriptsFlow.js';
import { openTarget } from './electronAppFlow.js';
import type { FunctionPlotCommitArm } from '@pointercad/ui/testing/function-plot-commit';
import { functionClosedSurfaceFlow } from './functionClosedSurfaceFlow.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute, type RecomputeToken } from './recompute.js';

const label = 'function-sphere-initial-commit';
type ReadObservation = Parameters<FunctionPlotCommitArm['accept']>[0];
type Observation = ReturnType<ReadObservation>;
type FailureStage = 'before-confirmation' | 'arm-renderer' | 'not-armed' | 'commit' | 'read-renderer' | 'incomplete';
type Report =
  | (Observation & { end: 'completed'; featureId: string; generation: number })
  | { end: 'observation-failed'; stage: FailureStage; points: Observation['points']; observedEnd?: Observation['end']; error?: string };

export async function functionSphereCommitFlow(page: Page, info: TestInfo, app: ElectronApplication): Promise<void> {
  if (env.PCAD_MANUAL_CAPTURE !== undefined) {
    await functionClosedSurfaceFlow(page, info, app);
    return;
  }
  let report: Report | undefined;
  const attachMath = await observeMathWorkers(page);
  try {
    await runObservedSphere(page, info, app, result => { report = result; });
  } finally {
    const body = JSON.stringify(report ?? { end: 'observation-failed', stage: 'before-confirmation', points: [] });
    log(`[${label}] ${body}`);
    await info.attach(label, { body, contentType: 'application/json' }).catch(() => undefined);
    await attachMath(info);
  }
}

const text = functionPlotMessage;

async function waitForSpherePreview(page: Page): Promise<void> {
  await page.evaluate(async () => { await document.fonts.ready; });
  const state = await waitForSettledRecompute(page);
  expect(state).toMatchObject({ isComputing: false, lastOutcome: 'success', pendingWaiters: 0 });
  expect(state.completedGeneration).toBe(state.requestedGeneration);
}

// This variant records the first confirmation on the live renderer. Manual
// capture uses the unmodified, registered source in functionClosedSurfaceFlow.
async function runObservedSphere(
  page: Page, info: TestInfo, app: ElectronApplication, record: (report: Report) => void,
): Promise<void> {
  const fileName = 'function-sphere.pcad';
  await chooseToolMenuItem(page, '作図', text('menuTitle'));
  const dialog = page.locator('.pcad-function-dialog');
  await dialog.getByRole('combobox', { name: text('geometry'), exact: true }).selectOption('surface');
  await dialog.getByRole('combobox', { name: text('presets'), exact: true }).selectOption('sphere');
  for (const axis of ['X', 'Y', 'Z']) {
    for (const endpoint of ['minimum', 'maximum'] as const) {
      const input = dialog.getByRole('textbox', { name: `${axis} ${text(endpoint)}`, exact: true });
      await expect(input).toHaveValue('');
      await input.fill(endpoint === 'minimum' ? '-2' : '2');
    }
  }
  await expect(dialog.getByRole('textbox', { name: `U ${text('maximum')}`, exact: true })).toHaveValue('360');
  await expect(dialog.getByRole('textbox', { name: `V ${text('maximum')}`, exact: true })).toHaveValue('180');
  await dialog.getByRole('textbox', { name: text('surfaceTolerance'), exact: true }).fill('0.5');
  const confirm = dialog.getByRole('button', { name: text('surfaceApply'), exact: true });
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  await expect(confirm).toBeEnabled({ timeout: 90_000 });
  await expect(dialog.getByText(text('closedSurface'), { exact: false })).toBeInViewport();
  await expect(dialog.locator('canvas')).toBeInViewport({ ratio: 1 });
  await waitForSpherePreview(page);
  const first = await beginRecompute(page);
  const observedId = await observeInitialCommit(confirm, first, async () => {
    await confirm.click();
    await waitForRecompute(page, first);
  }, record);
  const saved = await savePart(page, info, fileName, app);
  const feature = saved.solids.find(item => item.kind === 'functionSurface');
  if (feature?.kind !== 'functionSurface') throw new Error('Sphere source not saved');
  expect(feature.id, 'saved sphere is the confirmed feature').toBe(observedId);
  expect(feature.definition.formula).toMatchObject({
    kind: 'parametric-surface', U: { max: { source: '360' } }, V: { max: { source: '180' } },
    outputs: { X: { angleUnit: 'degree' }, Y: { angleUnit: 'degree' }, Z: { angleUnit: 'degree' } },
  });

  await page.reload();
  await openTarget(app, info.outputPath(fileName));
  await page.getByRole('group', { name: 'ファイル', exact: true }).getByRole('button', { name: '開く', exact: true }).click();
  await waitForRecompute(page);
  await page.getByText(feature.name, { exact: true }).click();
  await page.getByRole('button', { name: text('edit'), exact: true }).click();
  await dialog.getByRole('textbox', { name: `Z ${text('minimum')}`, exact: true }).fill('0');
  await dialog.getByRole('button', { name: text('preview'), exact: true }).click();
  await expect(confirm).toBeEnabled({ timeout: 90_000 });
  await expect(dialog.getByText(text('openSurface'), { exact: false })).toBeInViewport();
  await expect(dialog.getByText(`${text('volume')}:`, { exact: false })).toHaveCount(0);
  await waitForSpherePreview(page);
  const changed = await beginRecompute(page);
  await confirm.click();
  await waitForRecompute(page, changed);
  const cut = await savePart(page, info, 'function-cut-sphere.pcad', app);
  expect(cut.solids.find(item => item.id === feature.id)).toMatchObject({
    definition: { bounds: { Z: { min: { source: '0', value: 0 } } }, formula: feature.definition.formula },
  });
}

async function observeInitialCommit(
  confirm: Locator, token: RecomputeToken, commit: () => Promise<void>, record: (report: Report) => void,
): Promise<string> {
  let stage: FailureStage = 'arm-renderer';
  let latest: Observation | null = null;
  const observation = await confirm.evaluateHandle(node => {
    const view = node.ownerDocument.defaultView;
    if (view === null || !(node instanceof view.HTMLButtonElement)) return () => null;
    let read: ReadObservation | undefined;
    node.closest('dialog')?.dispatchEvent(new view.CustomEvent<FunctionPlotCommitArm>('pcad:test-surface-commit', {
      detail: { button: node, accept: collect => { read = collect; } },
    }));
    return (finish: boolean) => read?.(finish) ?? null;
  }).catch((error: unknown) => {
    record({ end: 'observation-failed', stage, points: [], error: describeError(error) });
    throw error;
  });
  try {
    latest = await observation.evaluate(read => read(false));
    stage = 'not-armed';
    expect(latest?.points[0], 'sphere confirmation observation').toMatchObject({ phase: 'armed' });
    stage = 'commit';
    await commit();
    stage = 'read-renderer';
    const settled = await observation.evaluate(read => read(false));
    if (settled === null) throw new Error('Sphere confirmation observation disappeared');
    latest = settled;
    stage = 'incomplete';
    const result = completeObservation(latest, token.requestedGeneration);
    // Keep a value in the test process before the flow saves and reloads the renderer.
    record(result);
    return result.featureId;
  } catch (error) {
    const trace = await observation.evaluate(read => read(false)).catch(() => null) ?? latest;
    record({ end: 'observation-failed', stage, points: trace?.points ?? [],
      ...(trace === null ? {} : { observedEnd: trace.end }), error: describeError(error) });
    throw error;
  } finally {
    await observation.evaluate(read => read(true)).catch(() => null);
    await observation.dispose().catch(() => undefined);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function completeObservation(trace: Observation, priorGeneration: number): Extract<Report, { end: 'completed' }> {
  const required = ['armed', 'click', 'target', 'published', 'requested', 'completed'] as const;
  const recorded = trace.points.filter(point => required.some(phase => phase === point.phase));
  expect(recorded.map(point => point.phase), 'actual sphere confirmation order').toEqual(required);
  expect(trace.end, 'sphere observation reached completion').toBe('completed');
  const [, click, target, published, requested, completed] = recorded;
  const featureId = target?.featureId;
  if (featureId === undefined || featureId === '' || requested === undefined) throw new Error('Sphere target or generation missing');
  expect(click, 'trusted confirmation reached the button').toMatchObject({ onButton: true });
  expect(published, 'the same feature was published as one edit').toMatchObject({ featureId, undoDepth: 1 });
  expect(requested.requested, 'confirmation requested a new generation').toBeGreaterThan(priorGeneration);
  expect(completed, 'that same generation completed successfully').toMatchObject({
    completed: requested.requested, outcome: 'success',
  });
  return { ...trace, end: 'completed', featureId, generation: requested.requested };
}
