/// <reference lib="dom" />
import { spawn } from 'node:child_process';
import { createHash, randomFillSync, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { inspect } from 'node:util';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { isTemplateKind, readPcadFile, type ImportedMeshBytes } from '../../packages/io/src/index.js';
import { pcadEntries, zipPcadEntries } from '../../packages/io/src/pcad/pcadFile.js';
import { IO_LIMITS } from '../../packages/io/src/limits.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../packages/model/src/index.js';
import { processTreeMemoryTotals, linuxProcessMemoryReading, linuxProcessTreeDiscovery, type LinuxProcessStatReading } from '../../packages/test-utils/src/processMemorySamples.js';
import { observeSaveResponse, reportDuration } from '../../packages/test-utils/src/releasePerformance.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { windowsNativeSource } from './processResourceSampler.js';
import { fileAction } from './fileCaptureSupport.js';
import { beginRecompute, KERNEL_TIMEOUT_MS, waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';

interface SaveInputAudit { readonly latencies: number[]; readonly stages: string[]; readonly timeStamps: number[] }
/** 頁の中の時刻(performance.now)で、取消の Enter と「取り消しました」の表示を記録する。 */
interface CancelTiming { pressed: number; displayed: number }
interface SaveWriteTiming {
  createWritableStart: number | null; createWritableEnd: number | null;
  /** 最初の write の始まりと最後の write の終わり。書込みを分けた時も 1 つの区間として読む。 */
  writeStart: number | null; writeEnd: number | null; writeCount: number;
  closeStart: number | null; closeEnd: number | null;
}
interface SaveClockCalibration { readonly nodeBefore: number; readonly nodeAfter: number; readonly pageNow: number }
/** 状態欄の保存の段(data-save-stage)が替わった時刻(頁の performance.now)。 */
interface SaveStageChange { readonly stage: string; readonly at: number }
declare global {
  interface Window {
    pcadSaveInputAudit?: SaveInputAudit; pcadCancelTiming?: CancelTiming; pcadSaveWriteTiming?: SaveWriteTiming;
    pcadSaveStageTimeline?: SaveStageChange[];
  }
}

export async function openSaveFlowFile(page: Page, path: string, app?: ElectronApplication): Promise<void> {
  if (app !== undefined) await openTarget(app, path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : null;
  const recompute = await beginRecompute(page);
  await fileAction(page, '開く').click();
  if (chooser !== null) await (await chooser).setFiles(path);
  await waitForRecompute(page, recompute);
}

export async function saveFlowFile(page: Page, path: string, app?: ElectronApplication): Promise<Buffer> {
  if (app !== undefined) await saveTarget(app, path);
  const download = app === undefined ? page.waitForEvent('download', { timeout: KERNEL_TIMEOUT_MS }) : null;
  await fileAction(page, '保存').click({ modifiers: ['Shift'] });
  if (download !== null) await (await download).saveAs(path); else await diskFile(path);
  await expect(page.locator('[data-save-stage="complete"]')).toBeVisible();
  return readFile(path);
}

/** 全頂点を1回ずつ使うランダムな三角形群。生成・検証は測定開始より前に終える。 */
function referencedMeshFixture(mib: 32 | 128): ImportedMeshBytes {
  const triangles = Math.ceil(mib * 1024 * 1024 / 84), vertexCount = triangles * 3;
  const positions = new Float32Array(vertexCount * 3), normals = new Float32Array(positions.length);
  const indices = new Uint32Array(vertexCount), seeds = new Uint32Array(positions.buffer);
  randomFillSync(seeds);
  // 生のfloat bit列はNaN/Infinityを含むため、有限範囲の実座標へ変換する。
  for (let i = 0; i < positions.length; i++) positions[i] = (seeds[i] / 0xffff_ffff - 0.5) * 2048;
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  const random = new Uint32Array(16_384); let cursor = random.length;
  for (let i = indices.length - 1; i > 0; i--) {
    if (cursor === random.length) { randomFillSync(random); cursor = 0; }
    const other = random[cursor++] % (i + 1), index = indices[i]; indices[i] = indices[other]; indices[other] = index;
  }
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, length = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(length) || length <= 1e-6) throw new Error('Fixture contains a degenerate triangle');
    // All three vertices have the same face normal; preserve each division and Float32 rounding.
    const normalX = nx / length, normalY = ny / length, normalZ = nz / length;
    normals[a] = normalX; normals[a + 1] = normalY; normals[a + 2] = normalZ;
    normals[b] = normalX; normals[b + 1] = normalY; normals[b + 2] = normalZ;
    normals[c] = normalX; normals[c + 1] = normalY; normals[c + 2] = normalZ;
    if (Math.abs(Math.hypot(normals[a], normals[a + 1], normals[a + 2]) - 1) > 1e-6) throw new Error('Fixture normal is not unit length');
  }
  return { positions, normals, indices };
}

function meshHashes(mesh: ImportedMeshBytes) {
  const hash = (array: Float32Array | Uint32Array) => createHash('sha256')
    .update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).digest('hex');
  return { positions: hash(mesh.positions), normals: hash(mesh.normals), indices: hash(mesh.indices) };
}

function meshByteLength(mesh: ImportedMeshBytes): number {
  return mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength;
}

interface LargeSaveFixture {
  readonly bytes: Uint8Array;
  readonly triangleCount: number;
  readonly rawBytes: number;
  readonly originalHash: ReturnType<typeof meshHashes>;
  /** 保存したファイルに同じ原本(全バイト)と参照が1つだけ残っていることを確かめ、その原本を返す。 */
  readonly checkedMesh: (result: ReturnType<typeof readPcadFile>) => ImportedMeshBytes;
}

/** 同じ試験の処理(Playwright の worker)の中では、同じ大きさの原本を作り直さない。 */
const largeSaveFixtures = new Map<32 | 128, LargeSaveFixture>();

/** 箱1つと、抑制した大容量の読込み原本1つを持つ部品。抑制でも現在文書が原本を所有する。 */
export function largeSaveFixture(mib: 32 | 128): LargeSaveFixture {
  const cached = largeSaveFixtures.get(mib);
  if (cached !== undefined) return cached;
  const fixture = buildLargeSaveFixture(mib);
  largeSaveFixtures.set(mib, fixture);
  return fixture;
}

function buildLargeSaveFixture(mib: 32 | 128): LargeSaveFixture {
  const mesh = referencedMeshFixture(mib), originalHash = meshHashes(mesh), rawBytes = meshByteLength(mesh);
  const triangleCount = mesh.indices.length / 3;
  expect(rawBytes).toBeGreaterThanOrEqual(mib * 1024 * 1024);
  expect(rawBytes).toBeLessThan(IO_LIMITS.archiveEntryExpandedBytes);
  expect(rawBytes).toBeLessThan(IO_LIMITS.meshAllocationBytes);
  const empty = createEmptyPartDocument(), boxDocument = appendSolid(empty, { ...createPrimitiveFeature(empty, 'box'), name: '保存応答の箱' });
  // 抑制でも現在文書が所有する原本。GPU描画の負荷を保存の測定へ混ぜない。
  const partDocument = appendSolid(boxDocument, { kind: 'importedMesh', id: 'save-load-feature', name: '保存負荷の原本',
    suppressed: true, meshRef: 'save-load', triangleCount,
    source: { format: 'stl', fileName: 'save-load.stl', unit: 'mm', byteLength: rawBytes } });
  function checkedMesh(result: ReturnType<typeof readPcadFile>): ImportedMeshBytes {
    if (!result.ok) throw new Error(result.error.message);
    const feature = result.document.solids.find(feature => feature.id === 'save-load-feature');
    if (feature?.kind !== 'importedMesh') throw new Error('原本を参照するフィーチャーが失われました');
    const saved = result.attachments.meshes.get(feature.meshRef);
    if (saved === undefined) throw new Error('原本の添付が失われました');
    expect(feature.suppressed).toBe(true); expect(feature.triangleCount).toBe(triangleCount);
    expect(meshByteLength(saved)).toBe(rawBytes); expect(meshHashes(saved)).toEqual(originalHash);
    expect(result.attachments.meshes.size).toBe(1); return saved;
  }
  // 入力の原本は製品と同じ項目を無圧縮で書く(製品の読み手は無圧縮の項目も読む)。測るのは製品の保存の出力で、
  // 入力の準備(大きい乱数の deflate)に試験の時間を使わない。
  const entries = pcadEntries(partDocument, {
    savedAt: '2026-10-04T00:00:00.000Z', attachments: { shapes: new Map(), meshes: new Map([['save-load', mesh]]), canvases: new Map() },
  });
  const bytes = zipPcadEntries(new Map([...entries].map(([name, [data, options]]) => [name, [data, { ...options, level: 0 }] as const])));
  expect(bytes.byteLength).toBeLessThanOrEqual(IO_LIMITS.archiveCompressedBytes);
  checkedMesh(readPcadFile(bytes));
  return { bytes, triangleCount, rawBytes, originalHash, checkedMesh };
}

interface SaveWorkerEntry { readonly url: string; closed: boolean; closedAt: number | null }

/** 製品が作った保存Workerを全て記録し、終了したか・いつ終了したか(検査側の performance.now)を追う。 */
function trackSaveWorkers(page: Page): SaveWorkerEntry[] {
  const workers: SaveWorkerEntry[] = [];
  page.on('worker', worker => {
    if (!worker.url().includes('pcadSave.worker')) return;
    const entry: SaveWorkerEntry = { url: worker.url(), closed: false, closedAt: null }; workers.push(entry);
    worker.on('close', () => { entry.closed = true; entry.closedAt = performance.now(); });
  });
  return workers;
}

/** 端末の処理の木の使用メモリー(全PIDの合計)の1回分。時刻は検査側の performance.now。 */
interface ProcessTreeSample extends ReturnType<typeof processTreeMemoryTotals> { readonly at: number; readonly discovery?: ReturnType<typeof linuxProcessTreeDiscovery> }

interface ProcessTreeSampler {
  /** 指定の時刻より後の記録が指定の件数そろうまで待つ(処理の起動に時間がかかっても、前後の件数をそろえる)。 */
  readonly waitForSamples: (after: number, count: number) => Promise<void>;
  readonly stop: () => Promise<ProcessTreeSample[]>;
  readonly method: string;
}

const SAMPLE_INTERVAL_MS = 100;

/**
 * Windows: 検査の処理(Playwright の worker)の子孫の全プロセス(ブラウザー・描画・GPU・Electron の各処理)の
 * WorkingSet64 と PrivateMemorySize64 を 100ms ごとに合計する。木は2秒ごとに取り直す。止める時は印のファイルを置く。
 * 台本は試験の出力の場所へ書き、引数で渡す(文字列の引用や符号化した命令は使わない)。
 */
async function startWindowsSampler(root: number, stopFile: string, scriptFile: string,
  onSample: (sample: Omit<ProcessTreeSample, 'at'>) => void): Promise<{ readonly finished: Promise<number> }> {
  await writeFile(scriptFile, windowsSaveSamplerScript());
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile,
    String(root), stopFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text: string) => {
    pending += text;
    const lines = pending.split(/\r?\n/u); pending = lines.pop() ?? '';
    for (const line of lines) {
      let raw: unknown;
      try { raw = JSON.parse(line) as unknown; }
      catch { raw = { expectedPids: [], readings: [], discoveryError: `invalid sampler frame: ${line}` }; }
      onSample(processTreeMemoryTotals(raw));
    }
  });
  return { finished: new Promise(resolve => { child.on('close', code => { resolve(code ?? -1); }); }) };
}

/** The PowerShell file of the save responsiveness sampler (arguments: root PID, stop file). */
export function windowsSaveSamplerScript(): string {
  return [
    'param([int]$root, [string]$stop)',
    "$ErrorActionPreference = 'Stop'",
    // The same native process list as the main sampler (one definition in processResourceSampler.ts), without WMI.
    "Add-Type -TypeDefinition @'",
    windowsNativeSource,
    "'@",
    'function Get-Tree {',
    '  $script:discoveryError = $null',
    '  $kids = @{}',
    '  try {',
    '  foreach ($p in [SamplerNative]::Processes()) {',
    '    $parent = [int]$p.ParentProcessId',
    '    if (-not $kids.ContainsKey($parent)) { $kids[$parent] = New-Object System.Collections.Generic.List[int] }',
    '    $kids[$parent].Add([int]$p.ProcessId)',
    '  }',
    '  } catch { $script:discoveryError = $_.Exception.Message; return ,@() }',
    '  $seen = New-Object System.Collections.Generic.HashSet[int]',
    '  $queue = New-Object System.Collections.Generic.Queue[int]',
    '  $queue.Enqueue($root) | Out-Null',
    '  [void]$seen.Add($root)',
    '  $found = New-Object System.Collections.Generic.List[int]',
    '  while ($queue.Count -gt 0) {',
    '    $id = $queue.Dequeue()',
    '    if ($kids.ContainsKey($id)) {',
    '      foreach ($child in $kids[$id]) {',
    '        if ($child -ne $PID -and $seen.Add($child)) { $found.Add($child); $queue.Enqueue($child) | Out-Null }',
    '      }',
    '    }',
    '  }',
    '  return ,$found',
    '}',
    '$ids = Get-Tree',
    '$count = 0',
    'while (-not (Test-Path -LiteralPath $stop)) {',
    '  if ($count -gt 0 -and $count % 20 -eq 0) { $ids = Get-Tree }',
    '  $readings = @()',
    '  foreach ($id in $ids) {',
    '    try { $p = Get-Process -Id $id -ErrorAction Stop; $readings += @{ pid = [int]$id; workingSetBytes = $p.WorkingSet64; privateBytes = $p.PrivateMemorySize64; error = $null } }',
    '    catch { $readings += @{ pid = [int]$id; workingSetBytes = $null; privateBytes = $null; error = $_.Exception.Message } }',
    '  }',
    '  [Console]::Out.WriteLine((@{ expectedPids = @($ids); readings = @($readings); discoveryError = $script:discoveryError } | ConvertTo-Json -Depth 5 -Compress))',
    '  [Console]::Out.Flush()',
    '  $count += 1',
    `  Start-Sleep -Milliseconds ${String(SAMPLE_INTERVAL_MS)}`,
    '}',
  ].join('\r\n');
}

/** Linux: /proc から子孫の全プロセスの VmRSS と RssAnon を 100ms ごとに合計する。 */
function startLinuxSampler(root: number, isStopped: () => boolean, onSample: (sample: Omit<ProcessTreeSample, 'at'>) => void): Promise<number> {
  const failure = (error: unknown): { readonly errorCode: string | null; readonly error: string } => ({
    errorCode: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null,
    error: error instanceof Error ? error.message : 'invalid-error status (expected Error)',
  });
  async function tree(): Promise<ReturnType<typeof linuxProcessTreeDiscovery>> {
    const readings: LinuxProcessStatReading[] = [];
    let names: string[];
    try { names = await readdir('/proc'); }
    catch (error) { const detail = failure(error); return linuxProcessTreeDiscovery(root, readings, `/proc: ${detail.errorCode ?? 'unknown errno'}: ${detail.error}`); }
    for (const name of names) {
      if (!/^\d+$/u.test(name)) continue;
      const pid = Number(name);
      try { readings.push({ pid, stat: await readFile(`/proc/${name}/stat`, 'utf8'), errorCode: null, error: null }); }
      catch (error) { readings.push({ pid, stat: null, ...failure(error) }); }
    }
    return linuxProcessTreeDiscovery(root, readings);
  }
  async function sample(discovery: ReturnType<typeof linuxProcessTreeDiscovery>): Promise<Omit<ProcessTreeSample, 'at'>> {
    const readings: ReturnType<typeof linuxProcessMemoryReading>[] = [];
    for (const id of discovery.expectedPids) {
      try { readings.push(linuxProcessMemoryReading(id, await readFile(`/proc/${String(id)}/status`, 'utf8'), null)); }
      catch (error) { readings.push(linuxProcessMemoryReading(id, null, failure(error).error)); }
    }
    return { ...processTreeMemoryTotals({ expectedPids: discovery.expectedPids, readings, discoveryError: discovery.discoveryError }), discovery };
  }
  return (async () => {
    let discovery = await tree(), count = 0;
    while (!isStopped()) {
      if (count > 0 && count % 20 === 0) discovery = await tree();
      onSample(await sample(discovery)); count += 1;
      await new Promise(resolve => { setTimeout(resolve, SAMPLE_INTERVAL_MS); });
    }
    return 0;
  })();
}

/**
 * 保存の前・最中・解放後の全PIDの使用メモリーを記録する(R06 の追加 peak<512MiB)。
 * 対象は Playwright の worker の子孫の全プロセス(ブラウザーの全処理・Electron の全処理。保存Workerは描画の処理の中)。
 * 100ms ごとの記録なので、それより短い山は記録の間に落ちることがある(測り方は final.md に書く)。
 */
async function startProcessTreeSampler(info: TestInfo): Promise<ProcessTreeSampler> {
  const samples: ProcessTreeSample[] = [], stopFile = info.outputPath(`memory-sampler-${randomUUID()}.stop`);
  let stopped = false;
  const onSample = (sample: Omit<ProcessTreeSample, 'at'>): void => { samples.push({ at: performance.now(), ...sample }); };
  let finished: Promise<number>, method: string;
  if (process.platform === 'win32') {
    ({ finished } = await startWindowsSampler(process.pid, stopFile, info.outputPath(`memory-sampler-${randomUUID()}.ps1`), onSample));
    method = 'Windows: NtQuerySystemInformation のプロセス一覧で worker の子孫の木を作り(2秒ごと)、Get-Process の WorkingSet64・PrivateMemorySize64 を100msごとに合計';
  } else if (process.platform === 'linux') {
    finished = startLinuxSampler(process.pid, () => stopped, onSample);
    method = 'Linux: /proc の stat で worker の子孫の木を作り(2秒ごと)、status の VmRSS・RssAnon を100msごとに合計';
  } else throw new Error(`この環境の処理の使用メモリーは測れません: ${process.platform}`);
  const waitForSamples = async (after: number, count: number): Promise<void> => {
    await expect.poll(() => samples.filter(sample => sample.at > after && sample.processes > 0).length,
      { message: '全PIDの使用メモリーの記録が届くこと', timeout: 30_000, intervals: [20] }).toBeGreaterThanOrEqual(count);
  };
  return {
    method, waitForSamples,
    stop: async () => {
      stopped = true; await writeFile(stopFile, 'stop');
      let code: number;
      try { code = await finished; }
      finally { await writeFile(info.outputPath('save-process-memory-samples.json'), JSON.stringify({ method, samples }, null, 2)); }
      if (code !== 0) throw new Error(`使用メモリーの記録が異常終了しました: ${String(code)}`);
      return samples;
    },
  };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 実測の区間の順番を取る(同じ実行の全 worker が共有する出力の場所に印のファイルを排他的に作る)。
 * 印の持ち主の処理が終わっていれば印を外して取り直す。待つのは最大2分(他の実測1回分より十分長い)。
 * 戻り値を呼ぶと順番を返す(2回呼んでも1回だけ返す)。
 */
async function acquireMeasurementTurn(info: TestInfo): Promise<() => Promise<void>> {
  const path = join(info.project.outputDir, 'save-measurement.lock'), deadline = Date.now() + 120_000;
  await mkdir(info.project.outputDir, { recursive: true });
  for (;;) {
    try {
      const handle = await open(path, 'wx');
      try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const owner = Number(await readFile(path, 'utf8').catch(() => ''));
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && !processAlive(owner)) {
        await rm(path, { force: true }); continue;
      }
      if (Date.now() > deadline) throw new Error(`保存の実測の順番を2分待っても取れません(持ち主 ${String(owner)})`, { cause: error });
      await new Promise(resolve => { setTimeout(resolve, 200); });
    }
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true; await rm(path, { force: true });
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.floor(sorted.length / 2)];
}

interface PeakPidReading {
  readonly pid: number; readonly workingSetBytes: number | null; readonly privateBytes: number | null;
  readonly extraWorkingSetBytes: number | null; readonly extraPrivateBytes: number | null;
}

/**
 * 山の1件(保存中で全PIDの WS 合計が最大の採取)の PID ごとの WS・private と、保存前の中央値との差。
 * 記憶量の要約のログ([記憶量記録])にだけ使い、判定には使わない。読めない値は null のまま出す。
 */
function peakByPid(before: readonly ProcessTreeSample[], during: readonly ProcessTreeSample[], clickedAt: number):
  { readonly atAfterClickMs: number; readonly processes: readonly PeakPidReading[] } | null {
  const readings = (sample: ProcessTreeSample) => sample.readings.flatMap(reading => typeof reading === 'object' && reading !== null
    && 'pid' in reading && typeof reading.pid === 'number' ? [{ pid: reading.pid,
      workingSetBytes: 'workingSetBytes' in reading && typeof reading.workingSetBytes === 'number' ? reading.workingSetBytes : null,
      privateBytes: 'privateBytes' in reading && typeof reading.privateBytes === 'number' ? reading.privateBytes : null }] : []);
  let peak: ProcessTreeSample | undefined;
  for (const sample of during) {
    if (sample.workingSetBytes === null) continue;
    if (peak === undefined || peak.workingSetBytes === null || sample.workingSetBytes > peak.workingSetBytes) peak = sample;
  }
  if (peak === undefined) return null;
  const baselineOf = (pid: number, key: 'workingSetBytes' | 'privateBytes'): number | null => {
    const values = before.flatMap(sample => readings(sample).filter(row => row.pid === pid).map(row => row[key]))
      .filter((value): value is number => value !== null);
    return values.length === 0 ? null : median(values);
  };
  const extra = (value: number | null, baseline: number | null): number | null => value === null || baseline === null ? null : value - baseline;
  return { atAfterClickMs: peak.at - clickedAt, processes: readings(peak).map(row => ({ ...row,
    extraWorkingSetBytes: extra(row.workingSetBytes, baselineOf(row.pid, 'workingSetBytes')),
    extraPrivateBytes: extra(row.privateBytes, baselineOf(row.pid, 'privateBytes')) })) };
}

/** 保存の段の時刻(押してからの検査側の時刻、ms)。記憶量の要約のログにだけ使い、判定には使わない。 */
interface SavePhaseSummary {
  /** 頁の時刻を検査側の時刻へ写した時の誤差の幅(片側、ms)。 */
  readonly clockUncertaintyMs: number;
  readonly stages: readonly { readonly stage: string; readonly afterClickMs: number }[];
  readonly opfs: {
    readonly createWritableStartMs: number | null; readonly writeStartMs: number | null; readonly writeEndMs: number | null;
    readonly writeCount: number; readonly closeStartMs: number | null; readonly closeEndMs: number | null;
  } | null;
}
interface MemoryPeakTime { readonly afterClickMs: number; readonly phase: string }

/** 頁の時刻(performance.now)の記録を、押した時刻からの検査側の時刻へ写す。読みの前後の検査側の時刻の中点を頁の時刻に合わせる。 */
function savePhaseSummary(read: { readonly timing: SaveWriteTiming | null; readonly timeline: readonly SaveStageChange[]; readonly pageNow: number },
  readStart: number, readEnd: number, clickedAt: number): SavePhaseSummary {
  const offset = (readStart + readEnd) / 2 - read.pageNow - clickedAt;
  const shift = (at: number | null): number | null => at === null ? null : Math.round(at + offset);
  const timing = read.timing;
  return {
    clockUncertaintyMs: Math.round((readEnd - readStart) / 2),
    stages: read.timeline.map(change => ({ stage: change.stage, afterClickMs: Math.round(change.at + offset) })),
    opfs: timing === null ? null : { createWritableStartMs: shift(timing.createWritableStart), writeStartMs: shift(timing.writeStart),
      writeEndMs: shift(timing.writeEnd), writeCount: timing.writeCount, closeStartMs: shift(timing.closeStart), closeEndMs: shift(timing.closeEnd) },
  };
}

/** 押してからの時刻が保存のどの段か。OPFS の write・close の区間は、その名前を優先する。 */
function phaseAt(summary: SavePhaseSummary, afterClickMs: number): string {
  const within = (start: number | null, end: number | null): boolean => start !== null && end !== null && afterClickMs >= start && afterClickMs <= end;
  if (summary.opfs !== null && within(summary.opfs.writeStartMs, summary.opfs.writeEndMs)) return 'opfs-write';
  if (summary.opfs !== null && within(summary.opfs.closeStartMs, summary.opfs.closeEndMs)) return 'opfs-close';
  let stage = 'none';
  for (const change of summary.stages) if (change.afterClickMs <= afterClickMs) stage = change.stage;
  return stage;
}

/** 保存中の WS と private の山の採取の時刻(押してから)と段。記録にだけ使い、判定には使わない。 */
function memoryPeakTimes(during: readonly ProcessTreeSample[], clickedAt: number, summary: SavePhaseSummary):
  { readonly workingSet: MemoryPeakTime | null; readonly private: MemoryPeakTime | null } {
  const peakOf = (key: 'workingSetBytes' | 'privateBytes'): MemoryPeakTime | null => {
    let best: ProcessTreeSample | undefined;
    for (const sample of during) {
      const value = sample[key], bestValue = best?.[key] ?? null;
      if (value !== null && (best === undefined || bestValue === null || value > bestValue)) best = sample;
    }
    if (best === undefined) return null;
    const afterClickMs = Math.round(best.at - clickedAt);
    return { afterClickMs, phase: phaseAt(summary, afterClickMs) };
  };
  return { workingSet: peakOf('workingSetBytes'), private: peakOf('privateBytes') };
}

/** 実OPFSのファイルを、製品の File System Access API の保存の口(showSaveFilePicker)へ渡す。 */
async function useOpfsSaveTarget(page: Page, fileName: string): Promise<SaveClockCalibration> {
  const nodeBefore = performance.now();
  const pageNow = await page.evaluate(async name => {
    const directory = await navigator.storage.getDirectory();
    const handle = await directory.getFileHandle(name, { create: true });
    const timing: SaveWriteTiming = { createWritableStart: null, createWritableEnd: null,
      writeStart: null, writeEnd: null, writeCount: 0, closeStart: null, closeEnd: null };
    window.pcadSaveWriteTiming = timing;
    const target = {
      name: handle.name,
      getFile: () => handle.getFile(),
      createWritable: async () => {
        timing.createWritableStart = performance.now();
        try {
          const writable = await handle.createWritable();
          return {
            write: async (data: Parameters<typeof writable.write>[0]) => {
              timing.writeStart ??= performance.now(); timing.writeCount += 1;
              try { return await writable.write(data); }
              finally { timing.writeEnd = performance.now(); }
            },
            close: async () => {
              timing.closeStart = performance.now();
              try { return await writable.close(); }
              finally { timing.closeEnd = performance.now(); }
            },
            abort: (reason?: unknown) => writable.abort(reason),
          };
        } finally { timing.createWritableEnd = performance.now(); }
      },
    };
    Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, value: () => Promise.resolve(target) });
    return performance.now();
  }, fileName);
  return { nodeBefore, nodeAfter: performance.now(), pageNow };
}

/** 製品が実OPFSへ書いたファイルを、照合のため検査側のディスクへ写す(読み出しは検査の操作)。 */
async function copyOpfsFile(page: Page, fileName: string, path: string): Promise<void> {
  const download = page.waitForEvent('download', { timeout: KERNEL_TIMEOUT_MS });
  await page.evaluate(async name => {
    const directory = await navigator.storage.getDirectory();
    const file = await (await directory.getFileHandle(name)).getFile();
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(file); anchor.download = name; anchor.click();
  }, fileName);
  await (await download).saveAs(path);
  await page.evaluate(async name => { await (await navigator.storage.getDirectory()).removeEntry(name); }, fileName);
}

export interface SaveMeasurementOptions {
  /** ブラウザーの保存先。'opfs' は実OPFSのファイルを File System Access API の口へ渡す。既定はダウンロード代替。 */
  readonly target?: 'download' | 'opfs';
}

/**
 * 大容量の原本を抱えた部品を製品の「開く」で読み、実Worker・実入力・実保存・再開を通す(R06 の実測)。
 * 保存中の100入力の p95<100ms(全体と保存中だけの両方)を参考値として記録し、同じ2つの p95 に元の100msの5倍の実用上限
 * (500ms超は失敗)を共通の判定で適用し、全PIDの追加 peak<512MiB(保存中と解放後)を確かめ、
 * 測定値を `save-<MiB>-<回>.json` に残す。
 */
export async function saveResponsivenessFlow(page: Page, info: TestInfo,
  mib: 32 | 128, repeat: number, app?: ElectronApplication, options: SaveMeasurementOptions = {}): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  const fixture = largeSaveFixture(mib), fixturePath = info.outputPath(`input-${mib}-${repeat}.pcad`);
  const { triangleCount, rawBytes, originalHash, checkedMesh } = fixture, fixtureBytes = fixture.bytes;
  await info.attach(`fixture-${mib}-${repeat}`, { contentType: 'application/json',
    body: JSON.stringify({ mib, triangleCount, rawBytes, zippedBytes: fixtureBytes.byteLength, originalHash }) });
  await writeFile(fixturePath, fixtureBytes);
  await openSaveFlowFile(page, fixturePath, app);
  const target = app !== undefined ? 'disk' : options.target ?? 'download';
  const opfsName = `save-performance-${String(mib)}-${String(repeat)}-${randomUUID()}.pcad`;
  const saveClockBefore = target === 'opfs' ? await useOpfsSaveTarget(page, opfsName) : null;
  const workers = trackSaveWorkers(page);
  await page.evaluate(() => {
    const audit: SaveInputAudit = { latencies: [], stages: [], timeStamps: [] }; window.pcadSaveInputAudit = audit;
    // 保存の段(準備・圧縮・書込み・後始末・完了)が替わった時刻。記憶量の山がどの段かを記録に残すためだけに使う。
    const timeline: SaveStageChange[] = []; window.pcadSaveStageTimeline = timeline;
    const noteStage = (): void => {
      const stage = document.querySelector('[data-save-stage]')?.getAttribute('data-save-stage') ?? 'none';
      if (timeline.at(-1)?.stage !== stage) timeline.push({ stage, at: performance.now() });
    };
    noteStage();
    new MutationObserver(noteStage).observe(document.body,
      { subtree: true, childList: true, attributes: true, attributeFilter: ['data-save-stage'] });
    document.addEventListener('input', event => {
      if (!event.isTrusted || !(event.target instanceof HTMLInputElement) || event.target.id !== 'pcad-command-line-input') return;
      const stage = document.querySelector('[data-save-stage]')?.getAttribute('data-save-stage') ?? 'none';
      audit.stages.push(stage); audit.timeStamps.push(event.timeStamp);
      requestAnimationFrame(() => { audit.latencies.push(performance.now() - event.timeStamp); });
    });
  });
  const readMemory = () => page.evaluate(() => {
    // Chromiumのrenderer JS heapの補助値。全PIDの合計は ProcessTreeSampler で測る。
    if (!('memory' in performance) || typeof performance.memory !== 'object' || performance.memory === null ||
      !('usedJSHeapSize' in performance.memory) || typeof performance.memory.usedJSHeapSize !== 'number') return null;
    return performance.memory.usedJSHeapSize;
  });
  // 保存前の記録から解放後の記録までは、同じ実行の他の worker の実測と重ねない(検査どうしの CPU の取り合いを測らない)。
  const releaseMeasurement = await acquireMeasurementTurn(info);
  const sampler = await startProcessTreeSampler(info);
  let memorySamples: ProcessTreeSample[] = [];
  try {
    // 保存前の記録を5件以上そろえる(記録の処理の起動を待つ)。
    await sampler.waitForSamples(-Infinity, 5);
    const memoryBefore = await readMemory(), savedPath = info.outputPath(`saved-${mib}-${repeat}.pcad`);
    if (app !== undefined) await saveTarget(app, savedPath);
    // 保存の完了までの待ちは、同じ flow の Electron 側(diskFile)と同じ上限にそろえる。
    const download = target === 'download' ? page.waitForEvent('download', { timeout: KERNEL_TIMEOUT_MS }) : null;
    const clickedAt = performance.now();
    await fileAction(page, '保存').click({ modifiers: ['Shift'] });
    await expect(page.locator('[data-save-stage="preparing"], [data-save-stage="compressing"]')).toBeVisible();
    const selection = page.locator('.pcad-tree__select').filter({ hasText: '保存応答の箱' });
    await selection.click(); await expect(selection).toHaveAttribute('aria-pressed', 'true');
    const viewport = page.locator('canvas.pcad-viewport__canvas');
    const rendered = await page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0);
    await viewport.hover(); await page.mouse.wheel(0, 40);
    await expect.poll(() => page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders ?? 0)).toBeGreaterThan(rendered);
    const command = page.locator('#pcad-command-line-input'); await command.focus();
    const roundTrips: number[] = [], inputStarts: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now(); inputStarts.push(start - clickedAt);
      await page.keyboard.press('a'); roundTrips.push(performance.now() - start);
    }
    const memoryDuring = await readMemory();
    await expect(command).toHaveValue('a'.repeat(100));
    await command.press('Escape');
    if (download !== null) await (await download).saveAs(savedPath);
    else if (app !== undefined) await diskFile(savedPath);
    const complete = page.locator('[data-save-stage="complete"]');
    await expect(complete).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
    const completedAt = performance.now();
    await expect.poll(() => workers.length).toBe(1);
    await expect.poll(() => workers.every(worker => worker.closed)).toBe(true);
    const releasedAt = Math.max(completedAt, ...workers.map(worker => worker.closedAt ?? completedAt));
    // 解放後の記録を5件以上そろえる。
    await sampler.waitForSamples(releasedAt, 5);
    memorySamples = await sampler.stop();
    await releaseMeasurement();
    const memoryAfter = await readMemory();
    const phaseReadStart = performance.now();
    const pageClockRead = await page.evaluate(() => ({
      timing: window.pcadSaveWriteTiming ?? null, timeline: window.pcadSaveStageTimeline ?? [], pageNow: performance.now(),
    }));
    const phaseReadEnd = performance.now();
    const savePhaseRead = target === 'opfs' ? { timing: pageClockRead.timing, pageNow: pageClockRead.pageNow } : null;
    const phaseSummary = savePhaseSummary(pageClockRead, phaseReadStart, phaseReadEnd, clickedAt);
    const savePhases = savePhaseRead === null || saveClockBefore === null ? null : {
      // Page timestamps need these calibration bounds; Node sample times are stdout receipt times.
      pageTiming: savePhaseRead.timing,
      before: { nodeBefore: saveClockBefore.nodeBefore - clickedAt,
        nodeAfter: saveClockBefore.nodeAfter - clickedAt, pageNow: saveClockBefore.pageNow },
      after: { nodeBefore: phaseReadStart - clickedAt, nodeAfter: phaseReadEnd - clickedAt, pageNow: savePhaseRead.pageNow },
    };
    if (target === 'opfs') await copyOpfsFile(page, opfsName, savedPath);
    const audit = await page.evaluate(() => window.pcadSaveInputAudit);
    // 計算前の原票も保存する。inspectはNaN/Infinity/undefined/配列の穴をnullへ変換しない。
    await writeFile(info.outputPath(`save-input-${String(mib)}-${String(repeat)}-raw.txt`),
      inspect({ audit, roundTrips, inputStarts }, { depth: null, maxArrayLength: null }));
    if (audit === undefined) throw new Error('入力記録がありません');
    const responseObservation = observeSaveResponse({ pageLatencyMs: audit.latencies, roundTripMs: roundTrips, stages: audit.stages },
      `保存${String(mib)}MiB ${String(repeat + 1)}/3`);
    const { samples, activeSamples, p95, activeP95 } = responseObservation;
    const result = readPcadFile(await readFile(savedPath));
    const savedAttachment = checkedMesh(result);
    for (const worker of workers) {
      const url = new URL(worker.url), appUrl = new URL(page.url());
      expect(`${url.protocol}//${url.host}`).toBe(`${appUrl.protocol}//${appUrl.host}`);
      expect(url.pathname).toMatch(/\/assets\/pcadSave\.worker-[\w-]+\.js$/u);
    }
    const before = memorySamples.filter(sample => sample.at < clickedAt && sample.processes > 0);
    const during = memorySamples.filter(sample => sample.at >= clickedAt && sample.at <= releasedAt && sample.processes > 0);
    const after = memorySamples.filter(sample => sample.at > releasedAt && sample.processes > 0);
    const metric = (rows: readonly ProcessTreeSample[], key: 'workingSetBytes' | 'privateBytes', peak = false): number | null => {
      const values: number[] = [];
      for (const row of rows) { const value = row[key]; if (value === null) return null; values.push(value); }
      return values.length === 0 ? null : peak ? Math.max(...values) : median(values);
    };
    const difference = (value: number | null, baseline: number | null): number | null => value === null || baseline === null ? null : value - baseline;
    const baseline = { workingSetBytes: metric(before, 'workingSetBytes'), privateBytes: metric(before, 'privateBytes') };
    const peak = { workingSetBytes: metric(during, 'workingSetBytes', true), privateBytes: metric(during, 'privateBytes', true) };
    const released = { workingSetBytes: metric(after, 'workingSetBytes'), privateBytes: metric(after, 'privateBytes') };
    const extraMemoryBudgetBytes = 512 * 1024 * 1024;
    const record = {
      environment: app !== undefined ? 'electron' : page.context().browser()?.browserType().name() ?? 'unknown', target,
      mib, repeat, rawBytes, triangleCount, savedBytes: (await readFile(savedPath)).byteLength,
      inputs: samples.length, p95, activeP95, activeInputs: activeSamples.length, samples, activeSamples, responseObservation,
      // Per input in input order: page stage, event time (page clock), page latency and Node key round trip.
      // Each sample above is the larger of the two; no criterion reads these fields, they only separate the sources.
      inputTimeline: audit.latencies.map((pageLatencyMs, i) => ({ stage: audit.stages[i], eventTimeStamp: audit.timeStamps[i] ?? null,
        pageLatencyMs, nodeStartAfterClickMs: inputStarts[i] ?? null, roundTripMs: roundTrips[i] ?? null })),
      saveMs: completedAt - clickedAt, releaseMs: releasedAt - clickedAt,
      workers: workers.map(worker => ({ ...worker, closedAfterClickMs: worker.closedAt === null ? null : worker.closedAt - clickedAt })),
      savePhases, phaseSummary, originalHash, savedHash: meshHashes(savedAttachment),
      memory: { method: sampler.method, intervalMs: SAMPLE_INTERVAL_MS, complete: memorySamples.every(sample => sample.complete), baseline, peak, released,
        extraPeak: { workingSetBytes: difference(peak.workingSetBytes, baseline.workingSetBytes), privateBytes: difference(peak.privateBytes, baseline.privateBytes) },
        extraAfterRelease: { workingSetBytes: difference(released.workingSetBytes, baseline.workingSetBytes), privateBytes: difference(released.privateBytes, baseline.privateBytes) },
        counts: { before: before.length, during: during.length, after: after.length }, extraMemoryBudgetBytes,
        rendererJsHeap: { before: memoryBefore, during: memoryDuring, after: memoryAfter },
        samples: memorySamples.map(sample => ({ ...sample, at: sample.at - clickedAt })) },
    };
    await writeFile(info.outputPath(`save-${String(mib)}-${String(repeat)}.json`), JSON.stringify(record, null, 2));
    await info.attach(`save-${mib}-${repeat}`, { contentType: 'application/json', body: JSON.stringify(record, null, 2) });
    // 判定の前に記憶量の要約を1行で出す(成功の回も外部検査のログで版どうしを比べ、判定で落ちた回も値を残すため)。
    // 上限・判定の式・判定の順は変えない。出力の形は [性能記録](releasePerformance.ts)と同じ「印 + JSON」。
    // 段の時刻(saveMs・releaseMs・保存の段・OPFS の書込み)と、WS と private の山の時刻・段も出す(山がどの段かをログだけで決める)。
    console.log('[記憶量記録]', JSON.stringify({ label: responseObservation.label, environment: record.environment, target,
      budgetBytes: extraMemoryBudgetBytes, complete: record.memory.complete, baseline, peak, released,
      extraPeak: record.memory.extraPeak, extraAfterRelease: record.memory.extraAfterRelease, counts: record.memory.counts,
      saveMs: Math.round(record.saveMs), releaseMs: Math.round(record.releaseMs), phases: phaseSummary,
      peakTimes: memoryPeakTimes(during, clickedAt, phaseSummary), peakByPid: peakByPid(before, during, clickedAt) }));
    expect(record.memory.complete, 'process-memory collection incomplete; inspect expected/observed PIDs and readings (not a product memory-budget exceedance)').toBe(true);
    // 100msは参考値(docs/requirements.md §5.2)。必要以上の遅さは共通の判定で失敗にする(元の100msの5倍、500ms超)。記録の書出しの後に判定する。
    reportDuration(p95, responseObservation.referenceTargetMs, `${responseObservation.label} p95`);
    reportDuration(activeP95, responseObservation.referenceTargetMs, `${responseObservation.label} 保存中p95`);
    expect(before.length).toBeGreaterThanOrEqual(3); expect(during.length).toBeGreaterThanOrEqual(3); expect(after.length).toBeGreaterThanOrEqual(3);
    expect(record.memory.extraPeak.workingSetBytes).toBeLessThan(extraMemoryBudgetBytes);
    expect(record.memory.extraPeak.privateBytes).toBeLessThan(extraMemoryBudgetBytes);
    expect(record.memory.extraAfterRelease.workingSetBytes).toBeLessThan(extraMemoryBudgetBytes);
    expect(record.memory.extraAfterRelease.privateBytes).toBeLessThan(extraMemoryBudgetBytes);
  } finally {
    if (memorySamples.length === 0) await sampler.stop().catch(() => []);
    await releaseMeasurement();
  }
  // 入力した未確定のコマンド文字は文書には入らない。保存した実ファイルを製品で再開する。
  await openSaveFlowFile(page, info.outputPath(`saved-${mib}-${repeat}.pcad`), app);
  await expect(page.locator('.pcad-statusbar__file')).not.toContainText('*');
  // 圧縮中の取消(≦1秒・Worker 終了・ファイル0・再保存)は saveCancelFlow で3環境とも毎回確かめる。
}

/**
 * 実Workerが32MiBの部品を圧縮している最中の取消(R06)。キーボードだけで押し、取消の表示と
 * 保存Workerの終了がそろうまでを1秒未満で終え、ダウンロード/ファイルを作らず、未保存の印と
 * 変更を残す。続けて保存し直すと、取消前の変更と原本の全バイトがファイルに入り、開き直せる。
 */
export async function saveCancelFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  const fixture = largeSaveFixture(32), fixturePath = info.outputPath('cancel-input.pcad');
  await writeFile(fixturePath, fixture.bytes);
  await openSaveFlowFile(page, fixturePath, app);
  await expect(page.locator('.pcad-statusbar__file')).not.toContainText('*');
  const workers = trackSaveWorkers(page);
  await renameTreeItem(page, '保存応答の箱', '取消後も残す箱');
  const cancelledPath = info.outputPath('must-not-exist.pcad');
  if (app !== undefined) await saveTarget(app, cancelledPath);
  let cancelledDownloads = 0;
  const downloaded = (): void => { cancelledDownloads += 1; };
  page.on('download', downloaded);
  try {
    await fileAction(page, '保存').click({ modifiers: ['Shift'] });
    await expect(page.locator('[data-save-stage="compressing"]')).toBeVisible();
    await page.evaluate(() => {
      const timing: CancelTiming = { pressed: 0, displayed: 0 };
      window.pcadCancelTiming = timing;
      document.addEventListener('keydown', event => {
        if (event.isTrusted && event.key === 'Enter' && timing.pressed === 0) timing.pressed = event.timeStamp;
      }, true);
      const observer = new MutationObserver(() => {
        if (timing.displayed === 0 && document.querySelector('[data-save-stage="cancelled"]') !== null) {
          timing.displayed = performance.now(); observer.disconnect();
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-save-stage'] });
    });
    const cancel = page.getByRole('button', { name: '保存を中止', exact: true });
    await cancel.focus(); const started = performance.now(); await page.keyboard.press('Enter');
    const cancelled = page.locator('[data-save-stage="cancelled"]');
    await expect(cancelled).toBeVisible();
    const displayedMs = performance.now() - started;
    // 判定に使う時刻へ待ちの間隔を足さないよう、細かく見る(閾値は変えない)。
    await expect.poll(() => workers.length === 1 && workers.every(worker => worker.closed), { intervals: [10] }).toBe(true);
    const cancelMs = Math.max(displayedMs, ...workers.map(worker => (worker.closedAt ?? Infinity) - started));
    const timing = await page.evaluate(() => window.pcadCancelTiming);
    if (timing === undefined) throw new Error('取消の時刻の記録がありません');
    const pageDisplayMs = timing.displayed - timing.pressed;
    const record = { cancelMs, displayedMs, pageDisplayMs, cancelledDownloads, workers };
    await writeFile(info.outputPath('cancel-worker.json'), JSON.stringify(record, null, 2));
    await info.attach('cancel-worker', { body: JSON.stringify(record), contentType: 'application/json' });
    expect(timing.pressed).toBeGreaterThan(0); expect(timing.displayed).toBeGreaterThan(0);
    expect(pageDisplayMs).toBeLessThan(1000);
    expect(cancelMs).toBeLessThan(1000); expect(cancelledDownloads).toBe(0);
    // 帯の文字は短い印だけ(UI の点検の指摘 1)。全文は読み上げ(role=status)とツールチップに入る。
    await expect(cancelled.locator('.pcad-statusbar__mark-text')).toHaveText('中止しました');
    await expect(cancelled.getByRole('status')).toHaveText('保存を中止しました。変更と復元用の控えは残っています。');
    await expect(cancelled).toHaveAttribute('title', '保存を中止しました。変更と復元用の控えは残っています。');
    if (app !== undefined) await expect(readFile(cancelledPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(page.locator('.pcad-statusbar__file')).toContainText('*');
  } finally { page.off('download', downloaded); }
  const retryPath = info.outputPath('after-cancel.pcad'), retry = readPcadFile(await saveFlowFile(page, retryPath, app));
  if (!retry.ok) throw new Error(retry.error.message);
  expect(retry.document.solids.some(solid => solid.name === '取消後も残す箱')).toBe(true);
  fixture.checkedMesh(retry); await openSaveFlowFile(page, retryPath, app);
  await expect(page.locator('.pcad-statusbar__file')).not.toContainText('*');
}

/** 部品ツリーの右クリックから名前を変え、再計算の完了まで待つ(取消の検査と同じ操作)。 */
async function renameTreeItem(page: Page, from: string, to: string): Promise<void> {
  await page.locator('.pcad-tree__select').filter({ hasText: from }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '名前を変える', exact: true }).click();
  const rename = page.getByRole('textbox', { name: '新しい名前', exact: true });
  await rename.fill(to);
  const changed = await beginRecompute(page); await rename.press('Enter'); await waitForRecompute(page, changed);
}

/**
 * スケッチの点を座標の入力で1つ置き、再計算の完了まで待つ(abortの検査と同じ操作)。点の道具は押すたびに
 * 入切するので、2つ目以降も同じ窓を開けるよう選択の道具へ戻してから押す(coordinateToolDefaultsFlow と同じ)。
 */
async function addSketchPoint(page: Page, values: readonly [string, string, string]): Promise<void> {
  const sketch = page.getByRole('group', { name: 'スケッチ', exact: true });
  await sketch.getByRole('button', { name: '選択', exact: true }).click();
  await sketch.getByRole('button', { name: '点', exact: true }).click();
  await expect(page.locator('.pcad-popover__title')).toHaveText('点を作る');
  const fields = page.locator('.pcad-popover input.pcad-field__input');
  for (const [index, value] of values.entries()) await fields.nth(index).fill(value);
  const recompute = await beginRecompute(page); await fields.first().press('Enter'); await page.keyboard.press('Escape');
  await waitForRecompute(page, recompute);
}

/** 保存していない事を伝えるツールチップ(file.unsavedChanges の実文)。 */
const UNSAVED_CHANGES = '保存していない変更があります。';

/**
 * 保存していない事は、ファイル名の後ろの * とツールチップで伝え、帯の文字には出さない
 * (案内の 1 文を押し出さない。UI の点検の指摘 1)。
 */
async function expectUnsavedNotice(page: Page, unsaved: boolean): Promise<void> {
  const file = page.locator('.pcad-statusbar__file');
  if (unsaved) await expect(file).toHaveAttribute('title', UNSAVED_CHANGES);
  else await expect(file).not.toHaveAttribute('title', UNSAVED_CHANGES);
  await expect(page.locator('.pcad-statusbar').getByText(UNSAVED_CHANGES, { exact: true })).toHaveCount(0);
}

/**
 * 復元用の保存の状態の印。帯には図柄(失敗だけ短い語)を出し、段階の全文はツールチップと
 * 読み上げ(role=status)へ渡す(UI の点検の指摘 1)。
 */
async function expectRecoveryMark(page: Page, stage: string, text: string): Promise<void> {
  const mark = page.locator(`.pcad-statusbar [data-recovery-stage="${stage}"]`);
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('title', text);
  await expect(mark.getByRole('status')).toHaveText(text);
}

/** 保存していない変更を確認の窓で捨てて「新規」へ切り替える。 */
async function switchToNewDocument(page: Page): Promise<void> {
  await fileAction(page, '新規').click();
  const confirm = page.getByRole('alertdialog', { name: '保存していない変更があります' });
  await confirm.getByRole('button', { name: '保存せずに続ける', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('.pcad-panel--left')).toContainText('まだ何もありません。');
}

/** 実Electronの保存の窓を、呼ばれた回数を数える置換えにする。2回目以降の呼出しは保存先だけを変える。 */
async function countedSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    Reflect.set(globalThis, 'pcadSaveDialogPath', filePath);
    if (Reflect.get(globalThis, 'pcadSaveDialogCalls') !== undefined) return;
    Reflect.set(globalThis, 'pcadSaveDialogCalls', 0);
    dialog.showSaveDialog = () => {
      Reflect.set(globalThis, 'pcadSaveDialogCalls', Number(Reflect.get(globalThis, 'pcadSaveDialogCalls')) + 1);
      return Promise.resolve({ canceled: false, filePath: String(Reflect.get(globalThis, 'pcadSaveDialogPath')) });
    };
  }, path);
}

function saveDialogCalls(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => Number(Reflect.get(globalThis, 'pcadSaveDialogCalls')));
}

/** 実ブラウザーのIndexedDBにある復元用の控えの件数(アプリが保管庫を作った後に呼ぶ)。 */
function recoveryCopyCount(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('pointercad');
    request.onerror = () => reject(new Error('控えの保管庫を開けません'));
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('autosave')) { database.close(); resolve(0); return; }
      const counting = database.transaction('autosave', 'readonly').objectStore('autosave').count();
      counting.onsuccess = () => { database.close(); resolve(counting.result); };
      counting.onerror = () => { database.close(); reject(new Error('控えを数えられません')); };
    };
  }));
}

/** 保存の窓(Electron)またはダウンロード(ブラウザー)で1回保存し、実際に書かれた名前を返す。 */
async function saveOnce(page: Page, path: string, app?: ElectronApplication): Promise<string> {
  if (app !== undefined) await countedSaveDialog(app, path);
  const download = app === undefined ? page.waitForEvent('download') : null;
  await fileAction(page, '保存').click({ modifiers: ['Shift'] });
  if (download === null) { await diskFile(path); return basename(path); }
  const saved = await download; await saved.saveAs(path); return saved.suggestedFilename();
}

/**
 * 32MiBの部品の圧縮中に保存を連打し、続けて「新規」へ切り替える(R06 文書切替・連打)。
 * 切替で実Workerの保存は止まり、待機中の2回目も実行されず、ダウンロード・ファイル・保存の窓は0。
 * 切替後の文書には古い保存の段階・完了・未保存・復元の表示を出さない。続けて新しい文書を
 * 保存すると、その内容だけが1回だけ書かれる。
 */
export async function saveDocumentSwitchFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  const fixture = largeSaveFixture(32), fixturePath = info.outputPath('switch-input.pcad');
  await writeFile(fixturePath, fixture.bytes);
  await openSaveFlowFile(page, fixturePath, app);
  const file = page.locator('.pcad-statusbar__file'), bar = page.locator('.pcad-statusbar');
  await expect(file).toHaveText('switch-input.pcad');
  const workers = trackSaveWorkers(page);
  await renameTreeItem(page, '保存応答の箱', '切替前の箱');
  await expect(file).toHaveText('switch-input.pcad*');
  await expectUnsavedNotice(page, true);
  await expectRecoveryMark(page, 'pending', '復元用の保存を待っています。');
  const abandonedPath = info.outputPath('switch-must-not-exist.pcad');
  if (app !== undefined) await countedSaveDialog(app, abandonedPath);
  let downloads = 0;
  const downloaded = (): void => { downloads += 1; };
  page.on('download', downloaded);
  try {
    await fileAction(page, '保存').click({ modifiers: ['Shift'] });
    const compressing = page.locator('[data-save-stage="compressing"]');
    await expect(compressing).toBeVisible();
    // 帯の文字は「保存中…」の短い印だけ。段階の全文は読み上げとツールチップへ(UI の点検の指摘 1)。
    await expect(compressing.locator('.pcad-statusbar__mark-text')).toHaveText('保存中…');
    await expect(compressing.getByRole('status')).toHaveText('保存する内容を圧縮しています。編集を続けられます。');
    await expectUnsavedNotice(page, true);
    // 圧縮中に押した2回目は1回目の後ろで待つ。どちらも切替後に書いてはいけない。
    await fileAction(page, '保存').click({ modifiers: ['Shift'] });
    await expect(compressing).toBeVisible();
    await switchToNewDocument(page);
    await expect(file).toHaveText('名称未設定');
    await expect.poll(() => workers.length > 0 && workers.every(worker => worker.closed)).toBe(true);
    expect(workers).toHaveLength(1);
    await expect(page.locator('[data-save-stage]')).toHaveCount(0);
    await expect(bar.getByText(/^復元用の/u)).toHaveCount(0);
    await expect(bar.locator('[data-recovery-stage]')).toHaveCount(0);
    await expectUnsavedNotice(page, false);
    await expect(page.locator('.pcad-statusbar__text')).not.toContainText('保存しました');
    await info.attach('switch-cancelled', { contentType: 'application/json',
      body: JSON.stringify({ workers, downloads, dialogs: app === undefined ? null : await saveDialogCalls(app) }) });

    // 新しい文書の保存は、その文書の内容だけを1回書く。古い保存の遅い結果は混ざらない。
    await addSketchPoint(page, ['5', '5', '0']);
    await expect(file).toHaveText('名称未設定*');
    const savedPath = info.outputPath('switch-new.pcad'), savedName = await saveOnce(page, savedPath, app);
    expect(savedName).toBe(app === undefined ? '名称未設定.pcad' : 'switch-new.pcad');
    await expect(page.locator('[data-save-stage="complete"]')).toHaveText(`「${savedName}」を保存しました。`);
    await expect(file).toHaveText(savedName);
    await expectUnsavedNotice(page, false);
    if (app === undefined) expect(downloads).toBe(1);
    else {
      expect(await saveDialogCalls(app)).toBe(1);
      await expect(readFile(abandonedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const saved = readPcadFile(await readFile(savedPath));
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.document.solids).toHaveLength(0);
    expect(saved.attachments.meshes.size).toBe(0);
    expect(saved.document.sketches.flatMap(sketch => sketch.features).filter(feature => feature.kind === 'point')).toHaveLength(1);
    await openSaveFlowFile(page, savedPath, app);
    await expect(file).toHaveText(basename(savedPath));
  } finally { page.off('download', downloaded); }
}

/**
 * 状態欄の4表示(保存の段階と完了したファイル名・未保存・復元用の控えの状態)を、実際の編集・
 * 自動の控え・保存・ひな形の書出し・文書切替で確かめる(R06)。表示は今の文書の分だけで、
 * 切替後は前の文書の表示を残さない。ブラウザーではダウンロード代替(Firefoxの既定の経路)で
 * 部品とひな形の両方の保存口を通す(R10)。呼出し側で `page.clock.install()` を済ませておく。
 * 4表示は案内の 1 文を押し出さないよう、帯には図柄と短い印・ファイル名の * だけを出し、全文は
 * ツールチップと読み上げで確かめる(UI の点検の指摘 1)。
 */
export async function saveStatusDisplayFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  const file = page.locator('.pcad-statusbar__file'), bar = page.locator('.pcad-statusbar');
  const recoveryPending = (): Promise<void> => expectRecoveryMark(page, 'pending', '復元用の保存を待っています。');
  await expect(file).toHaveText('名称未設定');
  await expectUnsavedNotice(page, false);
  await addSketchPoint(page, ['1', '2', '3']);
  await expect(file).toHaveText('名称未設定*');
  await expectUnsavedNotice(page, true);
  await recoveryPending();
  // 既定5分の自動の控えを実際の保存経路で書かせる。
  await page.clock.fastForward(300_000);
  await expectRecoveryMark(page, 'saved', '復元用の控えを保存しました。');
  expect(await recoveryCopyCount(page)).toBe(1);

  const savedPath = info.outputPath('status-saved.pcad'), savedName = await saveOnce(page, savedPath, app);
  expect(savedName).toBe(app === undefined ? '名称未設定.pcad' : 'status-saved.pcad');
  const complete = page.locator('[data-save-stage="complete"]');
  await expect(complete).toHaveText(`「${savedName}」を保存しました。`);
  await expect(complete).toHaveAttribute('title', `「${savedName}」を保存しました。`);
  await expect(file).toHaveText(savedName);
  await expectUnsavedNotice(page, false);
  await expect(bar.getByText(/^復元用の/u)).toHaveCount(0);
  await expect.poll(() => recoveryCopyCount(page)).toBe(0);
  const saved = readPcadFile(await readFile(savedPath));
  if (!saved.ok) throw new Error(saved.error.message);
  expect(saved.document.sketches.flatMap(sketch => sketch.features).filter(feature => feature.kind === 'point')).toHaveLength(1);

  // 次の編集では完了の印を残したまま未保存を * とツールチップで示し、復元の表示は待機へ戻る。
  await addSketchPoint(page, ['4', '5', '6']);
  await expect(file).toHaveText(`${savedName}*`);
  await expect(complete).toHaveText(`「${savedName}」を保存しました。`);
  await expectUnsavedNotice(page, true);
  await recoveryPending();
  if (app === undefined) {
    // ひな形の書出し口(saveFileAsInBrowser)もピッカーの無い環境ではダウンロードで成功する。
    const templateDownload = page.waitForEvent('download');
    await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/u }).first().click();
    await page.getByRole('button', { name: 'ひな形として保存', exact: true }).click();
    const template = await templateDownload, templatePath = info.outputPath('status-template.pcadt');
    expect(template.suggestedFilename()).toBe('名称未設定.pcadt');
    await template.saveAs(templatePath);
    await expect(page.locator('.pcad-statusbar__text')).toContainText('ひな形として保存しました');
    const read = readPcadFile(await readFile(templatePath));
    if (!read.ok) throw new Error(read.error.message);
    expect(isTemplateKind(read.kind)).toBe(true);
    // ひな形は名前を今のファイル名から取り、作図の履歴は持ち越さない(templateFromDocument、§2.10)。
    expect(read.document.name).toBe('名称未設定');
    expect(read.document.sketches.flatMap(sketch => sketch.features)).toHaveLength(0);
  }

  // 文書を切り替えたら、前の文書の段階・完了・未保存・復元の表示を出さない。
  await switchToNewDocument(page);
  await expect(file).toHaveText('名称未設定');
  await expect(page.locator('[data-save-stage]')).toHaveCount(0);
  await expect(bar.getByText(/^復元用の/u)).toHaveCount(0);
  await expect(bar.locator('[data-recovery-stage]')).toHaveCount(0);
  await expectUnsavedNotice(page, false);
}
