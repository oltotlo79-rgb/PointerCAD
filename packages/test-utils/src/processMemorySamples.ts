/** 実プロセス原票の集計。CPU/GPU/予約は重複加算しない。欠損は0に変換しない。 */
export type MemoryPhase = 'baseline' | 'transfer' | 'build' | 'publish' | 'cancel' | 'released';

export interface ProcessMemorySample {
  readonly pid: number;
  /** Windows CreationDate / Linux /proc/stat starttime。PIDだけをidentityにしない。 */
  readonly created: string;
  readonly parentPid: number;
  readonly name: string;
  readonly priority?: string | null;
  readonly role?: string;
  readonly workingSetBytes: number | null;
  readonly privateBytes: number | null;
  readonly error: string | null;
}

export interface ProcessMemoryFrame {
  readonly atEpochMs: number;
  readonly discoveredAtEpochMs: number;
  readonly phase: MemoryPhase;
  readonly processes: readonly ProcessMemorySample[];
  readonly discoveryError: string | null;
  /** Actual root process creation identity, even when root heap is excluded. */
  readonly rootCreated?: string | null;
}

export interface MemoryTotals {
  readonly workingSetBytes: number | null;
  readonly privateBytes: number | null;
  readonly identities: readonly string[];
  readonly problems: readonly string[];
}

function measured(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/** 同じidentityの重複は一度だけ。矛盾/同じPIDの異なるidentityは集計を不明にする。 */
export function processMemoryTotals(frame: ProcessMemoryFrame): MemoryTotals {
  const problems: string[] = [];
  if (frame.discoveryError !== null) problems.push(frame.discoveryError);
  if (frame.processes.length === 0) problems.push('process tree is empty');
  const identities = new Map<string, ProcessMemorySample>();
  const pids = new Map<number, string>();
  let workingSetBytes = 0;
  let privateBytes = 0;
  let workingSetKnown = true;
  let privateKnown = true;
  for (const process of frame.processes) {
    const identity = `${process.pid}:${process.created}`;
    if (!Number.isInteger(process.pid) || process.pid <= 0 || process.created.length === 0) {
      problems.push(`invalid process identity ${identity}`);
    }
    const previous = identities.get(identity);
    if (previous !== undefined) {
      if (previous.parentPid !== process.parentPid || previous.name !== process.name ||
        previous.workingSetBytes !== process.workingSetBytes || previous.privateBytes !== process.privateBytes ||
        previous.error !== process.error || previous.priority !== process.priority || previous.role !== process.role) problems.push(`conflicting identity ${identity}`);
      continue;
    }
    const previousIdentity = pids.get(process.pid);
    if (previousIdentity !== undefined && previousIdentity !== identity) problems.push(`PID reused within frame ${process.pid}`);
    pids.set(process.pid, identity);
    identities.set(identity, process);
    if (process.error !== null) problems.push(`${identity}: ${process.error}`);
    if (measured(process.workingSetBytes)) workingSetBytes += process.workingSetBytes;
    else { workingSetKnown = false; problems.push(`${identity}: working set unknown`); }
    if (measured(process.privateBytes)) privateBytes += process.privateBytes;
    else { privateKnown = false; problems.push(`${identity}: private memory unknown`); }
  }
  const structurallyKnown = problems.length === 0;
  return {
    workingSetBytes: structurallyKnown && workingSetKnown ? workingSetBytes : null,
    privateBytes: structurallyKnown && privateKnown ? privateBytes : null,
    identities: [...identities.keys()], problems,
  };
}

export interface MemoryHighwater {
  readonly baseline: number | null;
  readonly peak: number | null;
  readonly released: number | null;
  readonly extraPeak: number | null;
  readonly extraAfterRelease: number | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? upper) + upper) / 2 : upper;
}

/** 欠損を除外した平均で合格にしない。phase欠損、間隔超過は原票付きで未達を返す。 */
export function summarizeProcessMemory(frames: readonly ProcessMemoryFrame[], options: {
  readonly intervalMs: number;
  readonly discoveryIntervalMs: number;
  readonly requiredPhases: readonly MemoryPhase[];
}): {
  readonly complete: boolean;
  readonly problems: readonly string[];
  readonly workingSet: MemoryHighwater;
  readonly privateMemory: MemoryHighwater;
  readonly phasePeaks: Readonly<Partial<Record<MemoryPhase, MemoryTotals>>>;
} {
  const problems: string[] = [];
  const rows = frames.map(frame => ({ frame, totals: processMemoryTotals(frame) }));
  for (const phase of options.requiredPhases) {
    if (!rows.some(row => row.frame.phase === phase)) problems.push(`phase unobserved: ${phase}`);
  }
  if (options.requiredPhases.includes('released') && rows.at(-1)?.frame.phase !== 'released') {
    problems.push('final released phase unobserved');
  }
  for (const [index, row] of rows.entries()) {
    if (!Number.isFinite(row.frame.atEpochMs) || !Number.isFinite(row.frame.discoveredAtEpochMs)) {
      problems.push('sample/discovery timestamp unknown');
    }
    problems.push(...row.totals.problems.map(problem => `${row.frame.atEpochMs}: ${problem}`));
    const previous = rows[index - 1];
    if (previous !== undefined && (row.frame.atEpochMs <= previous.frame.atEpochMs ||
      row.frame.atEpochMs - previous.frame.atEpochMs > options.intervalMs * 2)) problems.push(`sample gap at ${row.frame.atEpochMs}`);
    const discoveryAge = row.frame.atEpochMs - row.frame.discoveredAtEpochMs;
    if (discoveryAge < 0 || discoveryAge > options.discoveryIntervalMs) problems.push(`stale process discovery at ${row.frame.atEpochMs}`);
  }
  const highwater = (key: 'workingSetBytes' | 'privateBytes'): MemoryHighwater => {
    const phaseValues = (phase: MemoryPhase): number[] => rows.filter(row => row.frame.phase === phase)
      .flatMap(row => row.totals[key] === null ? [] : [row.totals[key]]);
    const baseline = median(phaseValues('baseline'));
    // 文書切替の途中の解放を最終解放へ混ぜると、最後に残ったメモリーを過少評価する。
    const finalReleased: number[] = [];
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (row === undefined || row.frame.phase !== 'released') break;
      const value = row.totals[key];
      if (value !== null) finalReleased.push(value);
    }
    const released = median(finalReleased);
    const active = rows.filter(row => row.frame.phase !== 'baseline' && row.frame.phase !== 'released');
    const knownActive = active.flatMap(row => row.totals[key] === null ? [] : [row.totals[key]]);
    const peak = active.length > 0 && knownActive.length === active.length ? Math.max(...knownActive) : null;
    return { baseline, peak, released, extraPeak: baseline === null || peak === null ? null : peak - baseline,
      extraAfterRelease: baseline === null || released === null ? null : released - baseline };
  };
  const phasePeaks: Partial<Record<MemoryPhase, MemoryTotals>> = {};
  for (const phase of options.requiredPhases) {
    const phaseRows = rows.filter(row => row.frame.phase === phase);
    const values = (key: 'workingSetBytes' | 'privateBytes'): number | null => {
      const known = phaseRows.flatMap(row => row.totals[key] === null ? [] : [row.totals[key]]);
      return known.length > 0 && known.length === phaseRows.length ? Math.max(...known) : null;
    };
    phasePeaks[phase] = { workingSetBytes: values('workingSetBytes'), privateBytes: values('privateBytes'),
      identities: [...new Set(phaseRows.flatMap(row => row.totals.identities))],
      problems: phaseRows.flatMap(row => row.totals.problems) };
  }
  return { complete: problems.length === 0 && rows.length > 0, problems,
    workingSet: highwater('workingSetBytes'), privateMemory: highwater('privateBytes'), phasePeaks };
}

export function processMemoryWithinBudget(summary: ReturnType<typeof summarizeProcessMemory>, limitBytes: number): boolean {
  return Number.isFinite(limitBytes) && limitBytes > 0 && summary.complete &&
    [summary.workingSet, summary.privateMemory].every(metric =>
      metric.extraPeak !== null && metric.extraAfterRelease !== null &&
      metric.extraPeak < limitBytes && metric.extraAfterRelease < limitBytes);
}

/**
 * CPU の標本増分と、文書化した GPU 使用の保守上限を足した合計の上限(task208、ARITHMETIC-ADDENDUM の式)。
 * CPU は宣言済みの「所有 PID のカウンターの和 − baseline 中央値」の増分。作業セットと private は重なるので
 * 最大を取って足さない。0 未満は 0 にし、CPU の減少で GPU を相殺しない。GPU の baseline は引かない。
 * 標本化した集計カウンターの上限であり、物理的な常駐量や観測していない連続最大ではない。
 * summary が完全で、全ての入力と合計が有限・GPU が 0 以上のときだけ有効。生の値はそのまま返す。
 */
export function combinedSampledMemoryBound(summary: ReturnType<typeof summarizeProcessMemory>,
  gpuPeakUpperBoundBytes: number | null, limitBytes: number): {
  readonly label: 'sampled aggregate counter bound';
  readonly cpuExtraBytes: number | null;
  readonly gpuPeakUpperBoundBytes: number | null;
  readonly combinedUpperBoundBytes: number | null;
  readonly valid: boolean;
  readonly withinLimit: boolean;
} {
  const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);
  const cpuInputs = [summary.workingSet.extraPeak, summary.privateMemory.extraPeak,
    summary.workingSet.extraAfterRelease, summary.privateMemory.extraAfterRelease];
  const cpuExtraBytes = cpuInputs.every(finite) ? Math.max(0, ...cpuInputs.filter(finite)) : null;
  const gpu = finite(gpuPeakUpperBoundBytes) && gpuPeakUpperBoundBytes >= 0 ? gpuPeakUpperBoundBytes : null;
  const combinedUpperBoundBytes = cpuExtraBytes !== null && gpu !== null ? cpuExtraBytes + gpu : null;
  const valid = summary.complete && Number.isFinite(limitBytes) && limitBytes > 0
    && combinedUpperBoundBytes !== null && Number.isFinite(combinedUpperBoundBytes);
  return { label: 'sampled aggregate counter bound', cpuExtraBytes, gpuPeakUpperBoundBytes, combinedUpperBoundBytes, valid,
    withinLimit: valid && combinedUpperBoundBytes !== null && combinedUpperBoundBytes < limitBytes };
}

/** GPU実利用はOS/driver測定証跡だけ。製品予約、属性長、CPU privateはactualでない。 */
export interface GpuMemorySample {
  readonly atEpochMs: number;
  readonly phase: MemoryPhase;
  readonly actualBytes: number | null;
  readonly allocatedBytes: number | null;
  readonly reservedBytes: number | null;
  readonly provider: 'windows-dxgkrnl-etw' | 'linux-drm-fdinfo' | 'unknown';
  readonly scope: string;
  readonly evidence: string | null;
  readonly unknown: readonly string[];
}

export function gpuMemoryIsMeasured(sample: GpuMemorySample): boolean {
  return measured(sample.actualBytes) && sample.provider !== 'unknown' &&
    sample.evidence !== null && sample.evidence.length > 0 && sample.scope.length > 0 && sample.unknown.length === 0;
}

export interface DrmClientMemory {
  readonly identity: string | null;
  readonly residentBytes: number | null;
  readonly allocatedBytes: number | null;
  readonly sharedBytes: number | null;
  readonly problems: readonly string[];
}

/** Linux DRM fdinfoの標準キー。totalはbacking未実体化も含むためresidentと分ける。 */
export function parseDrmClientMemory(text: string): DrmClientMemory {
  const fields = new Map(text.split('\n').flatMap(line => {
    const colon = line.indexOf(':');
    return colon < 0 ? [] : [[line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as const];
  }));
  const driver = fields.get('drm-driver');
  const client = fields.get('drm-client-id');
  const device = fields.get('drm-pdev');
  const problems: string[] = [];
  // client-idの一意性がdevice内だけの場合もあるので、device省略時は合格にしない。
  const identity = driver !== undefined && client !== undefined && device !== undefined ? `${device}:${driver}:${client}` : null;
  if (identity === null) problems.push('DRM device/client identity missing');
  const sum = (prefix: string): number | null => {
    const matching = [...fields].filter(([key]) => key.startsWith(prefix));
    if (matching.length === 0) { problems.push(`${prefix} unreported`); return null; }
    let total = 0;
    for (const [key, raw] of matching) {
      const match = /^(\d+)\s*(KiB|MiB)?$/.exec(raw);
      if (match === null) { problems.push(`${key} invalid unit/value`); return null; }
      const bytes = Number(match[1]) * (match[2] === 'KiB' ? 1024 : match[2] === 'MiB' ? 1024 * 1024 : 1);
      if (!Number.isSafeInteger(bytes)) { problems.push(`${key} unsafe byte count`); return null; }
      total += bytes;
    }
    return Number.isSafeInteger(total) ? total : null;
  };
  const residentBytes = sum('drm-resident-');
  const allocatedBytes = sum('drm-total-');
  const sharedBytes = sum('drm-shared-');
  if (sharedBytes !== null && sharedBytes > 0) problems.push('shared DRM buffers cannot be deduplicated between clients');
  return { identity, residentBytes, allocatedBytes, sharedBytes, problems };
}


/** Structural qualification is not proof of OS origin. Only the Root-verified
 * immutable artifact ingress may use this result for actual acceptance. */
export interface GpuResidentExpectation {
  readonly rootPid: number;
  readonly includeRoot: boolean;
  readonly phase: MemoryPhase;
  readonly frame: ProcessMemoryFrame;
  readonly evidenceSha256: string;
}

function gpuRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function gpuNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function gpuEvidenceSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
export function gpuEvidenceRecord(value: unknown): value is Record<string, unknown> {
  return gpuRecord(value);
}

export function qualifyGpuResidentSample(value: unknown, expected: GpuResidentExpectation): GpuMemorySample {
  const problems: string[] = [];
  const reject = (reason: string): void => { problems.push(reason); };
  let actualBytes: number | null = null;
  let started = expected.frame.atEpochMs;
  if (!gpuRecord(value)) reject('GPU certificate must be an object');
  else {
    if (value['schema'] !== 'pcad-gpu-resident-v1') reject('GPU certificate schema unsupported');
    if (value['origin'] !== 'os-driver') reject('Synthetic or unknown GPU origin is not actual evidence');
    if (value['providerGuid'] !== '802ec45a-1e99-4b83-9920-87c98277ba9d') reject('GPU provider GUID unsupported');
    if (value['physicalResidentMeaning'] !== 'confirmed') reject('Physical resident semantics unresolved');
    for (const key of ['traceSha256', 'schemaSha256', 'decoderSha256']) {
      if (!gpuEvidenceSha256(value[key])) reject(`GPU ${key} missing`);
    }
    const target = value['target'];
    const identities = new Set<string>();
    const expectedIdentities = new Set(expected.frame.processes.map(process => `${process.pid}:${process.created}:${process.parentPid}`));
    if (expected.frame.phase !== expected.phase || new Set(expected.frame.processes.map(process => process.pid)).size !== expected.frame.processes.length) {
      reject('Workload phase or process identity coverage ambiguous');
    }
    if (!gpuRecord(target) || target['rootPid'] !== expected.rootPid || target['includeRoot'] !== expected.includeRoot ||
      typeof expected.frame.rootCreated !== 'string' || expected.frame.rootCreated.length === 0 || target['rootCreated'] !== expected.frame.rootCreated ||
      !Array.isArray(target['processes'])) reject('GPU target root/tree binding missing');
    else {
      for (const process of target['processes']) {
        if (!gpuRecord(process) || !gpuNumber(process['pid']) || process['pid'] === 0 ||
          !gpuNumber(process['parentPid']) || typeof process['created'] !== 'string' || process['created'].length === 0) {
          reject('GPU process creation identity invalid'); continue;
        }
        const identity = `${process['pid']}:${process['created']}:${process['parentPid']}`;
        if (identities.has(identity)) reject('GPU target process identity duplicated');
        identities.add(identity);
      }
      if (identities.size !== expectedIdentities.size || [...identities].some(identity => !expectedIdentities.has(identity))) {
        reject('GPU process tree differs from actual workload frame');
      }
    }
    if (expected.frame.discoveryError !== null || expected.frame.processes.length === 0 ||
      expected.frame.processes.some(process => process.error !== null || process.created.length === 0)) reject('Workload process identity coverage unknown');
    const window = value['window'];
    let ended = started;
    if (!gpuRecord(window) || !gpuNumber(window['startedAtEpochMs']) || !gpuNumber(window['endedAtEpochMs']) ||
      window['endedAtEpochMs'] < window['startedAtEpochMs'] || window['phase'] !== expected.phase ||
      window['qpcMappingVerified'] !== true || !gpuNumber(window['qpcFrequency']) || window['qpcFrequency'] === 0 ||
      !gpuNumber(window['qpcStart']) || !gpuNumber(window['qpcEnd']) || window['qpcEnd'] < window['qpcStart'] ||
      !gpuNumber(window['qpcAnchor']) || !gpuNumber(window['epochAnchorMs'])) reject('GPU clock/window/phase coverage unknown');
    else {
      started = window['startedAtEpochMs']; ended = window['endedAtEpochMs'];
      if (expected.frame.atEpochMs < started || expected.frame.atEpochMs > ended) reject('GPU window does not contain its workload frame');
      if (Math.abs((window['qpcEnd'] - window['qpcStart']) * 1000 / window['qpcFrequency'] - (ended - started)) > 1) {
        reject('GPU QPC/epoch duration differs');
      }
      if (Math.abs(window['epochAnchorMs'] + (window['qpcStart'] - window['qpcAnchor']) * 1000 / window['qpcFrequency'] - started) > 1 ||
        Math.abs(window['epochAnchorMs'] + (window['qpcEnd'] - window['qpcAnchor']) * 1000 / window['qpcFrequency'] - ended) > 1) reject('GPU QPC/epoch anchor differs');
    }
    const capture = value['capture'];
    if (!gpuRecord(capture) || !gpuNumber(capture['startedAtEpochMs']) || !gpuNumber(capture['endedAtEpochMs']) ||
      capture['startedAtEpochMs'] > started || capture['endedAtEpochMs'] < ended || capture['ownedStopCompleted'] !== true ||
      capture['initialStateComplete'] !== true || capture['eventsLost'] !== 0 || capture['buffersLost'] !== 0 ||
      capture['undecodedEvents'] !== 0) reject('GPU capture/rundown/final loss coverage unknown');
    const allocations = value['allocations'];
    const physicalIdentities = new Set<string>();
    let union = 0;
    if (!Array.isArray(allocations) || allocations.length === 0) reject('No actual physical allocation observations');
    else for (const allocation of allocations) {
      if (!gpuRecord(allocation) || typeof allocation['adapterLuid'] !== 'string' || !/^[0-9a-f]{16}$/u.test(allocation['adapterLuid']) ||
        !gpuNumber(allocation['physicalAdapterIndex']) || !gpuNumber(allocation['segmentId']) ||
        (allocation['segmentGroup'] !== 'local' && allocation['segmentGroup'] !== 'nonlocal') ||
        typeof allocation['allocationId'] !== 'string' || allocation['allocationId'].length === 0 ||
        !gpuNumber(allocation['generation']) || !gpuNumber(allocation['residentBytes']) ||
        allocation['physicalResidencyComplete'] !== true || !Array.isArray(allocation['owners']) || allocation['owners'].length === 0) {
        reject('GPU allocation/adapter/segment/physical residency invalid'); continue;
      }
      const identity = `${allocation['adapterLuid']}:${allocation['physicalAdapterIndex']}:${allocation['segmentId']}:${allocation['allocationId']}:${allocation['generation']}`;
      if (physicalIdentities.has(identity)) reject('Physical allocation identity duplicated; shared union not certified');
      physicalIdentities.add(identity);
      const ownerIdentities = new Set<string>();
      for (const owner of allocation['owners']) {
        if (!gpuRecord(owner) || !gpuNumber(owner['pid']) || typeof owner['created'] !== 'string' || !gpuNumber(owner['parentPid'])) {
          reject('GPU allocation owner identity invalid'); continue;
        }
        const identity = `${owner['pid']}:${owner['created']}:${owner['parentPid']}`;
        if (!identities.has(identity) || ownerIdentities.has(identity)) reject('GPU foreign/stale/duplicate allocation owner');
        ownerIdentities.add(identity);
      }
      union += allocation['residentBytes'];
      if (!Number.isSafeInteger(union)) reject('GPU physical union unsafe');
    }
    if (!gpuNumber(value['actualBytes']) || value['actualBytes'] !== union) reject('GPU actual bytes differ from physical identity union');
    else actualBytes = value['actualBytes'];
  }
  if (!gpuEvidenceSha256(expected.evidenceSha256)) reject('Root evidence digest missing');
  return { atEpochMs: started, phase: expected.phase, actualBytes: problems.length === 0 ? actualBytes : null,
    allocatedBytes: null, reservedBytes: null, provider: 'windows-dxgkrnl-etw',
    scope: `root=${expected.rootPid};identities=${expected.frame.processes.map(process => `${process.pid}:${process.created}`).join(',')}`,
    evidence: gpuEvidenceSha256(expected.evidenceSha256) ? expected.evidenceSha256 : null, unknown: problems };
}

export interface MemoryWorkloadCapture {
  readonly schema: 'pcad-memory-workload-v1';
  readonly runNonce: string;
  readonly rootIssuedNonce: true;
  readonly kind: 'solid' | 'assembly';
  readonly rootPid: number;
  readonly rootCreated: string;
  readonly includeRoot: boolean;
  readonly sourceSha: Readonly<Record<string, string>>;
  readonly phaseSha256: string;
  readonly boundaries: readonly { readonly atEpochMs: number; readonly phase: MemoryPhase; readonly observation: string }[];
  readonly frames: readonly ProcessMemoryFrame[];
  readonly intervalMs: number;
  readonly discoveryIntervalMs: number;
  readonly budgetBytes: number;
  readonly acceptanceComplete: false;
  readonly sourceStable: true;
  readonly samplerFailures: readonly [];
  readonly scenarioError: null;
  readonly updates: 100;
  readonly failureRecovered: true;
}

function memoryPhase(value: unknown): value is MemoryPhase {
  return value === 'baseline' || value === 'transfer' || value === 'build' || value === 'publish' || value === 'cancel' || value === 'released';
}
function memoryProcess(value: unknown): value is ProcessMemorySample {
  return gpuRecord(value) && gpuNumber(value['pid']) && value['pid'] > 0 && gpuNumber(value['parentPid']) &&
    typeof value['created'] === 'string' && value['created'].length > 0 && typeof value['name'] === 'string' &&
    (value['workingSetBytes'] === null || gpuNumber(value['workingSetBytes'])) &&
    (value['privateBytes'] === null || gpuNumber(value['privateBytes'])) &&
    (value['error'] === null || typeof value['error'] === 'string') &&
    (value['priority'] === undefined || value['priority'] === null || typeof value['priority'] === 'string') &&
    (value['role'] === undefined || typeof value['role'] === 'string');
}
function memoryFrame(value: unknown): value is ProcessMemoryFrame {
  return gpuRecord(value) && gpuNumber(value['atEpochMs']) && gpuNumber(value['discoveredAtEpochMs']) &&
    memoryPhase(value['phase']) && typeof value['rootCreated'] === 'string' && value['rootCreated'].length > 0 &&
    (value['discoveryError'] === null || typeof value['discoveryError'] === 'string') &&
    Array.isArray(value['processes']) && value['processes'].every(memoryProcess);
}
export function memoryWorkloadCapture(value: unknown): value is MemoryWorkloadCapture {
  if (!gpuRecord(value) || value['schema'] !== 'pcad-memory-workload-v1' ||
    typeof value['runNonce'] !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/u.test(value['runNonce']) ||
    value['rootIssuedNonce'] !== true || (value['kind'] !== 'solid' && value['kind'] !== 'assembly') || !gpuNumber(value['rootPid']) || value['rootPid'] === 0 ||
    typeof value['rootCreated'] !== 'string' || value['rootCreated'].length === 0 || typeof value['includeRoot'] !== 'boolean' ||
    !gpuRecord(value['sourceSha']) || Object.values(value['sourceSha']).length === 0 || !Object.values(value['sourceSha']).every(gpuEvidenceSha256) ||
    !gpuEvidenceSha256(value['phaseSha256']) || value['sourceStable'] !== true || value['scenarioError'] !== null || value['updates'] !== 100 || value['failureRecovered'] !== true ||
    !Array.isArray(value['samplerFailures']) || value['samplerFailures'].length !== 0 || value['acceptanceComplete'] !== false || value['budgetBytes'] !== 512 * 1024 * 1024 ||
    !gpuNumber(value['intervalMs']) || value['intervalMs'] === 0 || !gpuNumber(value['discoveryIntervalMs']) || value['discoveryIntervalMs'] === 0 ||
    !Array.isArray(value['boundaries']) || value['boundaries'].length === 0 || !Array.isArray(value['frames']) || value['frames'].length === 0) return false;
  return value['boundaries'].every(boundary => gpuRecord(boundary) && gpuNumber(boundary['atEpochMs']) && memoryPhase(boundary['phase']) &&
    typeof boundary['observation'] === 'string') && value['frames'].every(memoryFrame);
}

export interface GpuPostTraceExpectation {
  readonly runNonce: string;
  readonly workloadSha256: string;
  readonly bundleSha256: string;
  readonly phaseSha256: string;
  /** Filled only after reading and hashing the real immutable artifact bytes. */
  readonly verifiedArtifactRoles: readonly string[];
}

/** Post-stop structure check. Root must independently qualify resident semantics;
 * a matching JSON/hash or this synthetic-testable function is not OS proof. */
export function consumeGpuPostTrace(workload: MemoryWorkloadCapture, value: unknown, expected: GpuPostTraceExpectation): {
  readonly status: 'known' | 'unknown'; readonly gpu: readonly GpuMemorySample[];
  readonly problems: readonly string[]; readonly cpuWithinBudget: boolean;
  readonly verificationScope: 'post-trace-structure-only';
  readonly canOverrideOriginalRun: false;
  readonly acceptanceComplete: false;
} {
  const problems: string[] = [];
  const gpu: GpuMemorySample[] = [];
  const reject = (reason: string): void => { problems.push(reason); };
  if (!memoryWorkloadCapture(workload)) reject('Actual workload collection incomplete or source changed');
  for (const digest of [expected.workloadSha256, expected.bundleSha256, expected.phaseSha256]) {
    if (!gpuEvidenceSha256(digest)) reject('Post-trace immutable digest missing');
  }
  if (workload.runNonce !== expected.runNonce || workload.phaseSha256 !== expected.phaseSha256) reject('Workload nonce or phase digest differs');
  if (!gpuRecord(value) || value['schema'] !== 'pcad-gpu-posttrace-v1') reject('Post-trace bundle schema missing');
  else {
    const binding = value['binding'];
    if (!gpuRecord(binding) || binding['runNonce'] !== expected.runNonce || binding['workloadSha256'] !== expected.workloadSha256 ||
      binding['phaseSha256'] !== workload.phaseSha256 || binding['kind'] !== workload.kind || binding['rootPid'] !== workload.rootPid ||
      binding['rootCreated'] !== workload.rootCreated || binding['includeRoot'] !== workload.includeRoot || !gpuRecord(binding['sourceSha']) ||
      Object.keys(binding['sourceSha']).length !== Object.keys(workload.sourceSha).length ||
      Object.entries(workload.sourceSha).some(([path, digest]) => !gpuRecord(binding['sourceSha']) || binding['sourceSha'][path] !== digest)) {
      reject('Post-trace exact workload/source/PID creation binding differs');
    }
    const ownership = value['traceOwnership'];
    if (!gpuRecord(ownership) || ownership['runNonce'] !== workload.runNonce || ownership['rootPid'] !== workload.rootPid ||
      ownership['rootCreated'] !== workload.rootCreated || typeof ownership['sessionName'] !== 'string' || ownership['sessionName'].length === 0 ||
      ownership['ownedStopCompleted'] !== true || !gpuEvidenceSha256(ownership['traceSha256']) || !gpuEvidenceSha256(ownership['decodedSha256']) ||
      value['rootPhysicalMeaningVerified'] !== true) reject('Owned stopped Root-qualified trace missing');
    if (!Array.isArray(value['samples']) || value['samples'].length === 0) reject('Post-trace physical observations missing');
    else for (const sample of value['samples']) {
      if (!gpuRecord(sample)) { reject('Post-trace sample invalid'); continue; }
      const rolePairs: readonly (readonly [string, string])[] = [['traceSha256', 'trace'], ['schemaSha256', 'schema'], ['decoderSha256', 'decoder'], ['decodedSha256', 'decoded']];
      for (const [key, role] of rolePairs) {
        const digest = sample[key];
        if (!gpuEvidenceSha256(digest) || !expected.verifiedArtifactRoles.includes(`${role}:${digest}`)) reject('Post-trace raw role/digest unverified');
      }
      if (!gpuRecord(ownership) || sample['traceSha256'] !== ownership['traceSha256'] || sample['decodedSha256'] !== ownership['decodedSha256']) {
        reject('Sample differs from owned final trace/decoded bytes');
      }
      const window = sample['window'];
      if (!gpuRecord(window) || !gpuNumber(window['startedAtEpochMs']) || !gpuNumber(window['endedAtEpochMs'])) {
        reject('Post-trace sample window missing'); continue;
      }
      const start = window['startedAtEpochMs'], end = window['endedAtEpochMs'];
      const phaseAt = (at: number): MemoryPhase | undefined => [...workload.boundaries].reverse().find(boundary => boundary.atEpochMs <= at)?.phase;
      const frame = workload.frames.find(frame => frame.atEpochMs >= start && frame.atEpochMs <= end);
      if (frame === undefined || frame.rootCreated !== workload.rootCreated || phaseAt(start) !== frame.phase || phaseAt(end) !== frame.phase) {
        reject('Post-trace same-phase current process frame missing'); continue;
      }
      const reading = qualifyGpuResidentSample(sample, { rootPid: workload.rootPid, includeRoot: workload.includeRoot,
        phase: frame.phase, frame, evidenceSha256: expected.bundleSha256 });
      gpu.push(reading); problems.push(...reading.unknown);
    }
  }
  const requiredPhases: readonly MemoryPhase[] = ['baseline', 'transfer', 'build', 'publish', 'cancel', 'released'];
  for (const phase of requiredPhases) if (!gpu.some(sample => sample.phase === phase)) reject(`Post-trace phase missing: ${phase}`);
  const summary = summarizeProcessMemory(workload.frames, { intervalMs: workload.intervalMs,
    discoveryIntervalMs: workload.discoveryIntervalMs, requiredPhases });
  // CPU512 and unobserved internal phase/continuous highwater stay separate gates.
  const boundGpu = problems.length === 0 ? gpu : gpu.map(sample => ({ ...sample, actualBytes: null,
    unknown: [...sample.unknown, ...problems] }));
  return { status: problems.length === 0 ? 'known' : 'unknown', gpu: boundGpu, problems,
    cpuWithinBudget: processMemoryWithinBudget(summary, workload.budgetBytes),
    verificationScope: 'post-trace-structure-only', canOverrideOriginalRun: false, acceptanceComplete: false };
}

export interface GpuPostTraceDeliveryContext {
  readonly runNonce: string; readonly workloadSha256: string; readonly phaseSha256: string;
  readonly rootPid: number; readonly rootCreated: string; readonly sessionName: string;
}
export interface GpuPostTraceDelivery {
  readonly bundlePath: string; readonly bundleSha256: string;
  readonly stopReceiptPath: string; readonly stopReceiptSha256: string;
}
/** Root atomically publishes only after owned stop; no future ETL digest is
 * needed to configure the delivery filename before this same workload. */
export function gpuPostTraceDelivery(value: unknown, expected: GpuPostTraceDeliveryContext): GpuPostTraceDelivery | null {
  if (!gpuRecord(value) || value['schema'] !== 'pcad-gpu-posttrace-delivery-v1' ||
    value['runNonce'] !== expected.runNonce || value['workloadSha256'] !== expected.workloadSha256 ||
    value['phaseSha256'] !== expected.phaseSha256 || value['rootPid'] !== expected.rootPid ||
    value['rootCreated'] !== expected.rootCreated || value['sessionName'] !== expected.sessionName ||
    value['ownedStopCompleted'] !== true || typeof value['bundlePath'] !== 'string' || value['bundlePath'].length === 0 ||
    !gpuEvidenceSha256(value['bundleSha256']) || typeof value['stopReceiptPath'] !== 'string' || value['stopReceiptPath'].length === 0 ||
    !gpuEvidenceSha256(value['stopReceiptSha256'])) return null;
  return { bundlePath: value['bundlePath'], bundleSha256: value['bundleSha256'],
    stopReceiptPath: value['stopReceiptPath'], stopReceiptSha256: value['stopReceiptSha256'] };
}

/** Exact owned logman command raw shape, independently hash-read by the caller.
 * Structural command receipts remain subject to Root actual OS review. */
function gpuUnknownValues(value: unknown): value is readonly unknown[] { return Array.isArray(value); }

export function gpuOwnedStopReceipt(value: unknown, sessionName: string, traceSha256: string): boolean {
  if (!gpuRecord(value) || value['owned_name'] !== sessionName || value['actual_admin_token'] !== true || value['start_exit'] !== 0 ||
    !gpuUnknownValues(value['commands']) || !gpuRecord(value['files'])) return false;
  const commands = value['commands'];
  const owned = (label: string, verb: string): boolean => {
    const matches = commands.filter(command => gpuRecord(command) && command['label'] === label);
    const command: unknown = matches[0];
    if (matches.length !== 1 || !gpuRecord(command) || command['exit'] !== 0 || !gpuUnknownValues(command['arguments'])) return false;
    const args = command['arguments'];
    return args.every(arg => typeof arg === 'string') && args[0] === 'logman.exe' && args[1] === verb &&
      args[2] === sessionName && args[3] === '-ets' && args.length === 4;
  };
  // create argv is logman create trace <name>, so validate that shape separately.
  const starts = commands.filter(command => gpuRecord(command) && command['label'] === 'owned-create');
  const start: unknown = starts[0];
  const started = starts.length === 1 && gpuRecord(start) && start['exit'] === 0 && gpuUnknownValues(start['arguments']) &&
    start['arguments'][0] === 'logman.exe' && start['arguments'][1] === 'create' && start['arguments'][2] === 'trace' &&
    start['arguments'][3] === sessionName && start['arguments'].includes('-ets') &&
    start['arguments'].includes('{802ec45a-1e99-4b83-9920-87c98277ba9d}');
  const traces = Object.entries(value['files']).filter(([path, file]) => path.endsWith('.etl') && gpuRecord(file) &&
    file['sha256'] === traceSha256 && gpuNumber(file['bytes']) && file['bytes'] > 0);
  return started && owned('owned-query', 'query') && owned('owned-stop', 'stop') && traces.length === 1;
}

/** No setTimeout/test timeout increase. Root supplies a case deadline before
 * workload; the Playwright case budget independently remains unchanged. */
export function gpuPostTraceWaitBudget(now: number, flowStarted: number, caseTimeout: number, rootDeadline: number): number | null {
  if (![now, flowStarted, caseTimeout, rootDeadline].every(gpuNumber) || caseTimeout === 0 || now < flowStarted ||
    rootDeadline > flowStarted + caseTimeout) return null;
  const remaining = Math.min(rootDeadline - now, caseTimeout - (now - flowStarted));
  return remaining > 0 ? remaining : null;
}
