import { writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { analysisResourcesAssemblyFile, RESOURCE_MEMBER_COUNT } from './analysisResourcesFixture.js';
import { analysisResultBindingFlow } from './analysisResultBindingFlow.js';
import { readAssemblyStats } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { holdElectronFemAsset } from './electronFemAssetHold.js';
import { linuxSampler, windowsSampler, type RawFrame } from './processResourceSampler.js';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';
import { readViewportRenderStats } from './viewportRenderStats.js';

interface StageObservation { readonly atEpochMs: number; readonly stage: string | null; readonly result: boolean }

/** Only complete physical samples qualify; missing measurements never become zero. */
function isCompleteResourceFrame(frame: RawFrame): boolean {
  return frame.discoveryError === null && frame.processes.length > 0
    && frame.processes.every(process => process.error === null && process.workingSetBytes !== null);
}

function resourceIntervalPeak(frames: readonly RawFrame[], start: number | undefined, end: number | undefined): number | null {
  if (start === undefined || end === undefined) return null;
  const values = frames.filter(frame => frame.atEpochMs >= start && frame.atEpochMs <= end && isCompleteResourceFrame(frame))
    .map(frame => frame.processes.reduce((total, process) => total + (process.workingSetBytes ?? 0), 0));
  return values.length === 0 ? null : Math.max(...values);
}

/** Separate scenarios: 1000 CAD parts, then a new document with one real solid FEM analysis. */
export async function analysisResourcesFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.addInitScript(() => {
    const host = window as Window & { pcadW70Stages?: StageObservation[] };
    const rows: StageObservation[] = [];
    host.pcadW70Stages = rows;
    let last = '';
    new MutationObserver(() => {
      const stage = document.querySelector('[data-testid="solid-analysis-progress"]')?.getAttribute('data-stage') ?? null;
      const result = document.querySelector('[data-testid="solid-results"]') !== null;
      const key = JSON.stringify([stage, result]);
      if (key !== last) { last = key; rows.push({ atEpochMs: performance.timeOrigin + performance.now(), stage, result }); }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-stage'] });
  });
  const rootPid = app?.process().pid ?? process.pid;
  if (rootPid === undefined) throw new Error('Process memory root PID is unavailable');
  const includeRoot = app !== undefined;
  const sampler = platform() === 'win32' ? windowsSampler(rootPid, includeRoot)
    : platform() === 'linux' ? linuxSampler(rootPid, includeRoot, async () => undefined) : null;
  if (sampler === null) throw new Error(`Unsupported sampler OS: ${platform()}`);
  const events: { stage: string; atEpochMs: number }[] = [];
  let stopElapsedMs: number | null = null;
  let stages: StageObservation[] = [];
  let dof: { nodes: number; nodeLimit: number; total: number; fixed: number; free: number } | null = null;
  const mark = (stage: string): void => { events.push({ stage, atEpochMs: Date.now() }); };
  try {
    if (app === undefined) { await disableFilePickers(page); await page.goto('/'); }
    await page.waitForFunction(() => typeof window.pcadViewportRenderStats === 'function');
    const file = info.outputPath('analysis-resources-1000.pcada');
    mark('cad-fixture-start');
    await writeFile(file, await analysisResourcesAssemblyFile());
    const rendersBefore = (await readViewportRenderStats(page)).completedRenders;
    // Native sampler initialization can outlast this short CAD scenario. Start its
    // measurement only after a fresh complete OS frame from the current browser tree.
    const samplingReadyAfter = Date.now();
    await expect.poll(() => sampler.frames.some(frame => frame.atEpochMs >= samplingReadyAfter && isCompleteResourceFrame(frame)))
      .toBe(true);
    mark('cad-open-start');
    await openSaveFlowFile(page, file, app);
    await expect.poll(async () => (await readAssemblyStats(page)).components.filter(row => row.resolved !== null && row.displayed !== null).length,
      { timeout: 600_000 }).toBe(RESOURCE_MEMBER_COUNT);
    const actual = await readAssemblyStats(page);
    expect(actual.components).toHaveLength(RESOURCE_MEMBER_COUNT);
    expect(new Set(actual.components.map(row => row.id))).toEqual(new Set(
      Array.from({ length: RESOURCE_MEMBER_COUNT }, (_, i) => `resource-beam-${String(i)}`)));
    expect(actual.components.every(row => row.resolved !== null && row.displayed !== null)).toBe(true);
    await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders,
      { timeout: 600_000 }).toBeGreaterThan(rendersBefore);
    mark('cad-published');
    // Start a separate new document: the 1000 CAD bars are not represented as FEM inputs.
    await page.reload();
    mark('single-solid-analysis-start');
    await analysisResultBindingFlow(page, info, app !== undefined,
      app === undefined ? undefined : () => holdElectronFemAsset(app), elapsed => { stopElapsedMs = elapsed; },
      counts => { dof = counts; });
    stages = await page.evaluate(() => (window as Window & { pcadW70Stages?: StageObservation[] }).pcadW70Stages ?? []);
    // Require one contiguous run, rather than stitching the cancelled and successful runs together.
    let current: string[] = [];
    let completeRun = false;
    let awaitingResult = false;
    for (const item of stages) {
      if (item.stage === null) {
        if (current.length > 0) { awaitingResult = current.join(',') === 'preparing,meshing,solving'; current = []; }
        if (awaitingResult && item.result) completeRun = true;
      } else {
        if (current.length === 0) awaitingResult = false;
        if (current.at(-1) !== item.stage) current.push(item.stage);
      }
    }
    expect(completeRun).toBe(true);
    mark('single-solid-analysis-complete');
  } finally {
    await sampler.stop();
    const intervalPeak = (startName: string, endName: string): number | null => {
      const start = events.find(row => row.stage === startName)?.atEpochMs;
      const end = events.find(row => row.stage === endName)?.atEpochMs;
      return resourceIntervalPeak(sampler.frames, start, end);
    };
    const sampledWorkingSet = { cad: intervalPeak('cad-open-start', 'cad-published'),
      singleSolid: intervalPeak('single-solid-analysis-start', 'single-solid-analysis-complete') };
    const observationPath = info.outputPath('analysis-resources-observation.json');
    await writeFile(observationPath, JSON.stringify({
      cadComponents: RESOURCE_MEMBER_COUNT, femComponents: 1, rootPid, includeRoot,
      scope: 'separate documents; 1000 CAD parts were not solved as FEM',
      stopElapsedMs, stages, dof: { counts: dof, basis: 'input-derived, native numbering bijection checked before success' },
      unobserved: ['GPU peak'],
      physicalMemory: 'raw OS process frames, not allocation reservations; sampled values are not exact peaks',
      events, frames: sampler.frames, sampledWorkingSet, samplerFailures: sampler.failures,
    }), { encoding: 'utf8', flag: 'wx' });
    await info.attach('analysis-resources-observation.json', { contentType: 'application/json', path: observationPath });
    if (events.some(event => event.stage === 'single-solid-analysis-complete')) {
      expect(sampler.failures).toEqual([]);
      expect(sampledWorkingSet.cad).not.toBeNull();
      expect(sampledWorkingSet.singleSolid).not.toBeNull();
    }
  }
}
