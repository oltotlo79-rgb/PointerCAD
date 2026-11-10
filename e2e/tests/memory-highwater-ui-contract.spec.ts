import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type Page } from '@playwright/test';
import { viewportCollectedCoverage, expectMemoryEmptyDocument, memorySolidDimensionField, serialGpuReader, type GpuReading } from './memoryHighwaterFlow.js';
import { INTERVAL_MS, type RawFrame } from './processResourceSampler.js';

async function emptyFixture(page: Page, kind: 'solid' | 'assembly'): Promise<void> {
  const labels = ['部品', '合致', 'ジョイント', '分解ステップ'];
  const tree = kind === 'assembly' ? labels.map(label => `<button>${label} <span>0</span></button>`).join('')
    : '<p class="pcad-panel__empty-text">まだ何もありません。</p>';
  await page.setContent('<title>PointerCAD</title><div class="pcad-shell" data-document-kind="'
    + (kind === 'solid' ? 'part' : 'assembly') + '"><section class="pcad-panel--left">' + tree
    + '</section><span class="pcad-statusbar__file">名称未設定</span></div>');
  await page.evaluate(() => {
    // Only this isolated DOM fixture supplies observers. Production flow never writes them.
    window.pcadViewportFramedBodies = () => [];
    window.pcadAssemblyStats = () => ({ components: [], mateIds: [], jointIds: [], stepIds: [],
      diagnosis: null, jointValues: [], interferenceSelectedKey: null });
  });
}

test('primitive textbox uses the actual accessible label outside property-list and excludes other fields', async ({ page }) => {
  await page.setContent('<section class="pcad-panel--left"><input aria-label="X の長さ" value="99"></section>'
    + '<section class="pcad-panel--right"><div class="pcad-coordinate__fields">'
    + '<input aria-label="X の長さ" value="20"><input aria-label="Y の長さ" value="20">'
    + '<input aria-label="X" value="0"></div></section>');
  expect(await page.locator('.pcad-property-list input').count()).toBe(0);
  const field = memorySolidDimensionField(page);
  await expect(field).toHaveCount(1); await field.fill('21'); await expect(field).toHaveValue('21');
  await expect(page.locator('.pcad-panel--left input')).toHaveValue('99');
  await expect(page.getByRole('textbox', { name: 'Y の長さ', exact: true })).toHaveValue('20');
  await expect(page.getByRole('textbox', { name: 'X', exact: true })).toHaveValue('0');
});

test('a centre-X field or another dimension cannot substitute for the missing box-X field', async ({ page }) => {
  await page.setContent('<section class="pcad-panel--right"><input aria-label="X" value="20">'
    + '<input aria-label="Y の長さ" value="20"></section>');
  await expect(memorySolidDimensionField(page)).toHaveCount(0);
});

test('both actual document kinds require their actual empty UI and released viewport', async ({ page }) => {
  for (const kind of ['solid', 'assembly'] as const) {
    await emptyFixture(page, kind);
    await expectMemoryEmptyDocument(page, kind);
  }
});

test('empty-looking assembly UI cannot hide a retained component or relation in the existing observer', async ({ page }) => {
  for (const field of ['components', 'mateIds', 'jointIds', 'stepIds'] as const) {
    await emptyFixture(page, 'assembly');
    await page.evaluate(field => {
      const read = window.pcadAssemblyStats;
      if (read === undefined) throw new Error('Fixture observer absent');
      const state = read();
      Reflect.set(state, field, ['retained']);
      window.pcadAssemblyStats = () => state;
    }, field);
    await expect(expectMemoryEmptyDocument(page, 'assembly')).rejects.toThrow();
  }
});

test('empty document UI does not qualify retained viewport geometry as released', async ({ page }) => {
  test.setTimeout(45_000);
  await emptyFixture(page, 'solid');
  await page.evaluate(() => { window.pcadViewportFramedBodies = () => ['retained-body']; });
  await expect(expectMemoryEmptyDocument(page, 'solid')).rejects.toThrow();
});

const cpuFrame = (atEpochMs: number): RawFrame => ({ atEpochMs, readStartedAtEpochMs: atEpochMs, discoveredAtEpochMs: atEpochMs,
  processes: [], discoveryError: null });
const gpuReading = (startedAt: number, endedAt: number, actualBytes: number | null): GpuReading => ({
  sample: { atEpochMs: startedAt, phase: 'baseline', actualBytes, allocatedBytes: 8192, reservedBytes: null,
    provider: 'linux-drm-fdinfo', scope: 'client-1', evidence: 'gpu-fdinfo.json', unknown: [] },
  raw: [], readStartedAtEpochMs: startedAt, readEndedAtEpochMs: endedAt });

test('a 300ms Linux GPU read does not hold the CPU sample loop and never runs twice at once', async () => {
  const events: string[] = [];
  let reads = 0;
  const reader = serialGpuReader(async () => {
    reads += 1; events.push('read-start');
    await delay(300);
    events.push('read-end');
    return gpuReading(1_000, 1_300, 4096);
  }, () => 'build');
  // The CPU loop awaits observe for each frame; three frames fall inside the one 300ms read.
  for (let index = 0; index < 3; index += 1) {
    await reader.observe(cpuFrame(1_000 + index * INTERVAL_MS));
    events.push(`cpu-frame-${String(index)}`);
  }
  expect(events).toEqual(['read-start', 'cpu-frame-0', 'cpu-frame-1', 'cpu-frame-2']);
  expect(reads).toBe(1);
  expect(reader.pending()).toBe(1);
  await expect.poll(() => reader.pending()).toBe(0);
  await reader.observe(cpuFrame(1_400));
  expect(reads).toBe(2);
  await reader.stop();
  expect(events).toEqual(['read-start', 'cpu-frame-0', 'cpu-frame-1', 'cpu-frame-2', 'read-end', 'read-start', 'read-end']);
  expect(reader.readings.map(reading => reading.sample.actualBytes)).toEqual([4096, 4096]);
  expect(reader.failures).toEqual([]);
});

test('a GPU read across a phase boundary and an unknown GPU read stay null, never 0', async () => {
  const readOnce = async (output: GpuReading): Promise<GpuReading | undefined> => {
    const reader = serialGpuReader(() => Promise.resolve(output), atEpochMs => (atEpochMs < 2_000 ? 'build' : 'publish'));
    await reader.observe(cpuFrame(output.readStartedAtEpochMs));
    await reader.stop();
    expect(reader.failures).toEqual([]);
    return reader.readings[0];
  };
  const crossed = await readOnce(gpuReading(1_900, 2_050, 8192));
  expect(crossed?.sample).toMatchObject({ phase: 'build', actualBytes: null, allocatedBytes: 8192 });
  expect(crossed?.sample.unknown).toContain('GPU read crossed a phase boundary');
  const inside = await readOnce(gpuReading(2_100, 2_150, 8192));
  expect(inside?.sample).toMatchObject({ phase: 'publish', actualBytes: 8192, unknown: [] });
  const unknown = await readOnce(gpuReading(2_200, 2_250, null));
  expect(unknown?.sample.actualBytes).toBeNull();
});

test('stop waits for the GPU read in flight and leaves no read after it', async () => {
  let release: () => void = () => undefined;
  let reads = 0;
  const reader = serialGpuReader(async () => {
    reads += 1;
    await new Promise<void>(resolve => { release = resolve; });
    return gpuReading(1_000, 1_010, 1);
  }, () => 'released');
  await reader.observe(cpuFrame(1_000));
  let stopped = false;
  const stopping = reader.stop().then(() => { stopped = true; });
  await delay(20);
  expect(stopped).toBe(false);
  expect(reader.pending()).toBe(1);
  await reader.observe(cpuFrame(1_100));
  release();
  await stopping;
  expect(stopped).toBe(true);
  expect(reader.pending()).toBe(0);
  expect(reads).toBe(1);
  expect(reader.readings).toHaveLength(1);
  await reader.observe(cpuFrame(1_200));
  expect(reads).toBe(1);
  expect(reader.pending()).toBe(0);
});

test('a failed GPU read is kept as a failure, not dropped and not counted as 0', async () => {
  const reader = serialGpuReader(() => Promise.reject(new Error('fdinfo vanished')), () => 'build');
  await reader.observe(cpuFrame(1_000));
  await reader.stop();
  expect(reader.failures).toEqual(['GPU read failed: Error: fdinfo vanished']);
  expect(reader.readings).toEqual([]);
  expect(reader.pending()).toBe(0);
});

test('a drained viewport start remains valid after ring eviction, while real gaps and missing metadata fail', () => {
  const row = (sequence: number, kind: string) => ({ sequence, kind, operationId: 'operation-1',
    publicationId: 'publication-1', resourceOwnerId: 'resource-1', documentId: 'document-1', generation: 7, preview: false });
  const drained = [row(1, 'build-start'), row(2, 'publish-start'), row(3, 'publish-complete'), row(4, 'build-complete')];
  // A rolling snapshot now contains only terminal records; the earlier starts were drained.
  const rolling = drained.slice(2);
  expect(viewportCollectedCoverage(rolling).length).toBeGreaterThan(0);
  expect(viewportCollectedCoverage(drained)).toEqual([]);
  expect(viewportCollectedCoverage([drained[0], ...drained.slice(2)]).length).toBeGreaterThan(0);
  expect(viewportCollectedCoverage([...drained, row(5, 'publish-complete')])).toContain('Viewport collected duplicate terminal');
  expect(viewportCollectedCoverage(drained.map(record => record.sequence === 3 ? { ...record, documentId: null } : record)))
    .toContain('Viewport collected owner metadata missing');
  expect(viewportCollectedCoverage(drained.map(record => record.sequence === 3 ? { ...record, generation: 8 } : record)))
    .toContain('Viewport collected owner conflict');
});
