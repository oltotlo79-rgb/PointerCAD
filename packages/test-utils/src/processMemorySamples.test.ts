import { describe, expect, it } from 'vitest';
import { gpuPostTraceDelivery, gpuOwnedStopReceipt, gpuPostTraceWaitBudget, consumeGpuPostTrace, memoryWorkloadCapture, type MemoryWorkloadCapture, gpuMemoryIsMeasured, parseDrmClientMemory, processMemoryTotals, processMemoryWithinBudget, combinedSampledMemoryBound, summarizeProcessMemory, qualifyGpuResidentSample,
  type MemoryPhase, type ProcessMemoryFrame, type ProcessMemorySample } from './processMemorySamples.js';

const process: ProcessMemorySample = { pid: 12, parentPid: 1, created: '100', name: 'renderer',
  workingSetBytes: 100, privateBytes: 80, error: null };
function frame(atEpochMs: number, phase: MemoryPhase, processes = [process]): ProcessMemoryFrame {
  return { atEpochMs, discoveredAtEpochMs: atEpochMs, phase, processes, discoveryError: null };
}
const options = { intervalMs: 100, discoveryIntervalMs: 2_000,
  requiredPhases: ['baseline', 'build', 'released'] as const };

describe('全PIDの高水位原票', () => {
  it('同じidentityは一度だけ数え、PID再利用は別の時刻で扱う', () => {
    expect(processMemoryTotals(frame(0, 'baseline', [process, process])).workingSetBytes).toBe(100);
    const next = { ...process, created: '200', workingSetBytes: 300 };
    const summary = summarizeProcessMemory([frame(0, 'baseline'), frame(100, 'build', [next]), frame(200, 'released')], options);
    expect(summary.complete).toBe(true);
    expect(summary.workingSet).toEqual({ baseline: 100, peak: 300, released: 100, extraPeak: 200, extraAfterRelease: 0 });
  });
  it.each([null, -1, NaN, Infinity])('欠損/不正値%sを0にしない', workingSetBytes => {
    const result = processMemoryTotals(frame(0, 'baseline', [{ ...process, workingSetBytes }]));
    expect(result.workingSetBytes).toBeNull();
    expect(result.problems.length).toBeGreaterThan(0);
  });
  it('空木、exit失敗、identityの矛盾を未達にする', () => {
    expect(processMemoryTotals(frame(0, 'baseline', [])).workingSetBytes).toBeNull();
    expect(processMemoryTotals(frame(0, 'baseline', [{ ...process, error: 'exited during read' }])).privateBytes).toBeNull();
    expect(processMemoryTotals(frame(0, 'baseline', [process, { ...process, privateBytes: 90 }])).privateBytes).toBeNull();
    expect(processMemoryTotals(frame(0, 'baseline', [process, { ...process, created: '200' }])).workingSetBytes).toBeNull();
  });
  it('baselineとreleasedの中央値、phase別peak、負の解放差を保持する', () => {
    const rows = [frame(0, 'baseline'), frame(100, 'baseline', [{ ...process, workingSetBytes: 120 }]),
      frame(200, 'build', [{ ...process, workingSetBytes: 160 }]), frame(300, 'released', [{ ...process, workingSetBytes: 90 }])];
    const result = summarizeProcessMemory(rows, options);
    expect(result.workingSet).toEqual({ baseline: 110, peak: 160, released: 90, extraPeak: 50, extraAfterRelease: -20 });
    expect(result.phasePeaks.build?.workingSetBytes).toBe(160);
  });
  it('観測欠損を取り除いてpeakを小さくしない', () => {
    const rows = [frame(0, 'baseline'), frame(100, 'build'),
      frame(200, 'build', [{ ...process, privateBytes: null }]), frame(300, 'released')];
    const result = summarizeProcessMemory(rows, options);
    expect(result.complete).toBe(false);
    expect(result.privateMemory.peak).toBeNull();
    expect(result.privateMemory.extraPeak).toBeNull();
  });
  it('間隔境界、古いdiscovery、未観測phaseを判別する', () => {
    expect(summarizeProcessMemory([frame(0, 'baseline'), frame(200, 'build'), frame(400, 'released')], options).complete).toBe(true);
    expect(summarizeProcessMemory([frame(0, 'baseline'), frame(201, 'build'), frame(400, 'released')], options).complete).toBe(false);
    expect(summarizeProcessMemory([{ ...frame(3_000, 'baseline'), discoveredAtEpochMs: 0 }], options).problems)
      .toContain('stale process discovery at 3000');
    expect(summarizeProcessMemory([frame(0, 'baseline')], options).problems).toContain('phase unobserved: build');
  });
  it('GPU予約512MiB・属性長・CPU privateをactualの証拠にしない', () => {
    const gpu = { atEpochMs: 0, phase: 'build' as const, actualBytes: null, allocatedBytes: 128,
      reservedBytes: 512 * 1024 * 1024, provider: 'unknown' as const, scope: 'adapter', evidence: null, unknown: ['unmeasured'] };
    expect(gpuMemoryIsMeasured(gpu)).toBe(false);
    expect(gpuMemoryIsMeasured({ ...gpu, actualBytes: 0 })).toBe(false);
    expect(gpuMemoryIsMeasured({ ...gpu, actualBytes: 0, provider: 'windows-dxgkrnl-etw', evidence: 'trace.etl', unknown: [] })).toBe(true);
  });
  it('DRMの実residentと未実体化を含むallocatedを別に読む', () => {
    const raw = 'drm-driver: xe\ndrm-pdev: 0000:00:02.0\ndrm-client-id: 7\n' +
      'drm-resident-vram: 1 MiB\ndrm-resident-memory: 2 KiB\ndrm-total-vram: 2 MiB\ndrm-shared-vram: 0';
    expect(parseDrmClientMemory(raw)).toEqual({ identity: '0000:00:02.0:xe:7', residentBytes: 1_050_624,
      allocatedBytes: 2_097_152, sharedBytes: 0, problems: [] });
    expect(parseDrmClientMemory(raw.replace('drm-shared-vram: 0', 'drm-shared-vram: 1')).problems)
      .toContain('shared DRM buffers cannot be deduplicated between clients');
    expect(parseDrmClientMemory('drm-driver: xe').residentBytes).toBeNull();
    expect(parseDrmClientMemory(raw.replace('1 MiB', '1 MB')).residentBytes).toBeNull();
  });
  it.each([-1, 0, 1])('追加512MiBの境界%+dバイトを厳密に判定する', offset => {
    const limit = 512 * 1024 * 1024;
    const rows = [frame(0, 'baseline'), frame(100, 'build', [{ ...process,
      workingSetBytes: 100 + limit + offset, privateBytes: 80 + limit + offset }]),
    frame(200, 'released')];
    expect(processMemoryWithinBudget(summarizeProcessMemory(rows, options), limit)).toBe(offset < 0);
    expect(processMemoryWithinBudget(summarizeProcessMemory(rows.slice(0, 2), options), limit)).toBe(false);
  });
  it('途中の文書解放を最終解放の中央値へ混ぜない', () => {
    const rows = [frame(0, 'baseline'), frame(100, 'build'), frame(200, 'released', [{ ...process, workingSetBytes: 90 }]),
      frame(300, 'build'), frame(400, 'released', [{ ...process, workingSetBytes: 80 }]),
      frame(500, 'released', [{ ...process, workingSetBytes: 60 }])];
    expect(summarizeProcessMemory(rows, options).workingSet.released).toBe(70);
    expect(summarizeProcessMemory(rows.slice(0, 4), options).workingSet.released).toBeNull();
    expect(summarizeProcessMemory(rows.slice(0, 4), options).complete).toBe(false);
  });
});

describe('CPU標本増分とGPU保守上限の合計(標本化した集計カウンターの上限、task208)', () => {
  const MiB = 1024 * 1024, limit = 512 * MiB;
  /** baseline 200MiB の 1 PID。build と最終 released の作業セット・private の増分を MiB で決める。 */
  function cpuSummary(peakWs: number, peakPrivate: number, releasedWs = 0, releasedPrivate = 0) {
    const at = (ws: number, priv: number) => [{ ...process, workingSetBytes: 200 * MiB + ws, privateBytes: 200 * MiB + priv }];
    return summarizeProcessMemory([frame(0, 'baseline', at(0, 0)), frame(100, 'build', at(peakWs, peakPrivate)),
      frame(200, 'released', at(releasedWs, releasedPrivate))], options);
  }
  it('個別には512MiB未満のCPU400+GPU200を合計600MiBで断り、150+200は350MiBで通す', () => {
    const cpu400 = cpuSummary(400 * MiB, 100 * MiB);
    expect(processMemoryWithinBudget(cpu400, limit)).toBe(true); // 従来の個別判定だけなら通っていた
    expect(combinedSampledMemoryBound(cpu400, 200 * MiB, limit)).toEqual({ label: 'sampled aggregate counter bound',
      cpuExtraBytes: 400 * MiB, gpuPeakUpperBoundBytes: 200 * MiB, combinedUpperBoundBytes: 600 * MiB, valid: true, withinLimit: false });
    expect(combinedSampledMemoryBound(cpuSummary(150 * MiB, 150 * MiB), 200 * MiB, limit))
      .toMatchObject({ cpuExtraBytes: 150 * MiB, combinedUpperBoundBytes: 350 * MiB, valid: true, withinLimit: true });
  });
  it('重なる作業セットとprivateは足さずに最大を取る', () => {
    expect(combinedSampledMemoryBound(cpuSummary(300 * MiB, 250 * MiB), 200 * MiB, limit))
      .toMatchObject({ cpuExtraBytes: 300 * MiB, combinedUpperBoundBytes: 500 * MiB, withinLimit: true });
  });
  it('CPUの減少(負の増分)でGPUを相殺しない', () => {
    const shrunk = cpuSummary(-100 * MiB, -100 * MiB);
    expect(shrunk.workingSet.extraPeak).toBe(-100 * MiB);
    for (const gpu of [600 * MiB, 550 * MiB]) {
      expect(combinedSampledMemoryBound(shrunk, gpu, limit)).toMatchObject({ cpuExtraBytes: 0, combinedUpperBoundBytes: gpu, withinLimit: false });
    }
  });
  it('解放後に残ったCPU400+GPU200も断る', () => {
    expect(combinedSampledMemoryBound(cpuSummary(10 * MiB, 10 * MiB, 400 * MiB, 400 * MiB), 200 * MiB, limit))
      .toMatchObject({ cpuExtraBytes: 400 * MiB, combinedUpperBoundBytes: 600 * MiB, withinLimit: false });
  });
  it('ちょうど512MiBは断り、1バイト少なければ通す', () => {
    const cpu312 = cpuSummary(312 * MiB, 312 * MiB);
    expect(combinedSampledMemoryBound(cpu312, 200 * MiB, limit)).toMatchObject({ combinedUpperBoundBytes: limit, valid: true, withinLimit: false });
    expect(combinedSampledMemoryBound(cpu312, 200 * MiB - 1, limit)).toMatchObject({ combinedUpperBoundBytes: limit - 1, withinLimit: true });
  });
  it.each([null, Infinity, NaN, -1])('GPU上限%sは無効で断る', gpu => {
    expect(combinedSampledMemoryBound(cpuSummary(MiB, MiB), gpu, limit)).toMatchObject({ gpuPeakUpperBoundBytes: gpu,
      combinedUpperBoundBytes: null, valid: false, withinLimit: false });
  });
  it('CPU側の欠損・未完了も無効で断る', () => {
    const incomplete = summarizeProcessMemory([frame(0, 'baseline'), frame(100, 'build')], options);
    expect(incomplete.complete).toBe(false);
    expect(combinedSampledMemoryBound(incomplete, 0, limit)).toMatchObject({ cpuExtraBytes: null, valid: false, withinLimit: false });
  });
});


describe('GPU resident certificate structural fixtures (not actual OS evidence)', () => {
  function certificate() {
    return { schema: 'pcad-gpu-resident-v1', origin: 'os-driver',
      providerGuid: '802ec45a-1e99-4b83-9920-87c98277ba9d', physicalResidentMeaning: 'confirmed',
      traceSha256: 'a'.repeat(64), schemaSha256: 'b'.repeat(64), decoderSha256: 'c'.repeat(64),
      target: { rootPid: 1, rootCreated: 'root-0', includeRoot: false,
        processes: [{ pid: 12, created: '100', parentPid: 1 }] },
      window: { startedAtEpochMs: 90, endedAtEpochMs: 110, phase: 'build', qpcMappingVerified: true,
        qpcFrequency: 1000, qpcStart: 90, qpcEnd: 110, qpcAnchor: 0, epochAnchorMs: 0 },
      capture: { startedAtEpochMs: 0, endedAtEpochMs: 200, ownedStopCompleted: true,
        initialStateComplete: true, eventsLost: 0, buffersLost: 0, undecodedEvents: 0 },
      allocations: [{ adapterLuid: '0000000000000001', physicalAdapterIndex: 0, segmentId: 1,
        segmentGroup: 'local', allocationId: 'physical-1', generation: 1, residentBytes: 64,
        physicalResidencyComplete: true, owners: [{ pid: 12, created: '100', parentPid: 1 }] }], actualBytes: 64 };
  }
  const expected = { rootPid: 1, includeRoot: false, phase: 'build' as const,
    frame: { ...frame(100, 'build'), rootCreated: 'root-0' }, evidenceSha256: 'd'.repeat(64) };
  it('accepts only a complete internally consistent structural fixture; no runtime provenance claimed', () => {
    const result = qualifyGpuResidentSample(certificate(), expected);
    expect(result.actualBytes).toBe(64); expect(result.unknown).toEqual([]);
    expect(result.allocatedBytes).toBeNull(); expect(result.reservedBytes).toBeNull();
  });
  const negatives: readonly { label: string; change: (value: ReturnType<typeof certificate>) => unknown; reason: string }[] = [
    { label: 'synthetic origin', change: value => ({ ...value, origin: 'synthetic' }), reason: 'Synthetic or unknown GPU origin is not actual evidence' },
    { label: 'global segment origin', change: value => ({ ...value, physicalResidentMeaning: 'adapter-global' }), reason: 'Physical resident semantics unresolved' },
    { label: 'unconfirmed semantics', change: value => ({ ...value, physicalResidentMeaning: 'unknown' }), reason: 'Physical resident semantics unresolved' },
    { label: 'root PID reuse', change: value => ({ ...value, target: { ...value.target, rootCreated: 'root-reused' } }), reason: 'GPU target root/tree binding missing' },
    { label: 'owner PID reuse', change: value => ({ ...value, target: { ...value.target, processes: [{ pid: 12, created: 'reused', parentPid: 1 }] } }), reason: 'GPU process tree differs from actual workload frame' },
    { label: 'foreign allocation owner', change: value => ({ ...value, allocations: [{ ...value.allocations[0], owners: [{ pid: 99, created: 'foreign', parentPid: 0 }] }] }), reason: 'GPU foreign/stale/duplicate allocation owner' },
    { label: 'duplicate shared allocation', change: value => ({ ...value, allocations: [...value.allocations, ...value.allocations], actualBytes: 128 }), reason: 'Physical allocation identity duplicated; shared union not certified' },
    { label: 'missing initial state', change: value => ({ ...value, capture: { ...value.capture, initialStateComplete: false } }), reason: 'GPU capture/rundown/final loss coverage unknown' },
    { label: 'final event loss', change: value => ({ ...value, capture: { ...value.capture, eventsLost: 1 } }), reason: 'GPU capture/rundown/final loss coverage unknown' },
    { label: 'final buffer loss', change: value => ({ ...value, capture: { ...value.capture, buffersLost: 1 } }), reason: 'GPU capture/rundown/final loss coverage unknown' },
    { label: 'undecoded event', change: value => ({ ...value, capture: { ...value.capture, undecodedEvents: 1 } }), reason: 'GPU capture/rundown/final loss coverage unknown' },
    { label: 'uncompleted owned stop', change: value => ({ ...value, capture: { ...value.capture, ownedStopCompleted: false } }), reason: 'GPU capture/rundown/final loss coverage unknown' },
    { label: 'wrong phase', change: value => ({ ...value, window: { ...value.window, phase: 'baseline' } }), reason: 'GPU clock/window/phase coverage unknown' },
    { label: 'wrong epoch anchor', change: value => ({ ...value, window: { ...value.window, epochAnchorMs: 20 } }), reason: 'GPU QPC/epoch anchor differs' },
    { label: 'wrong total', change: value => ({ ...value, actualBytes: 65 }), reason: 'GPU actual bytes differ from physical identity union' },
    { label: 'partial residency unresolved', change: value => ({ ...value, allocations: [{ ...value.allocations[0], physicalResidencyComplete: false }] }), reason: 'GPU allocation/adapter/segment/physical residency invalid' },
    { label: 'no physical observations', change: value => ({ ...value, allocations: [], actualBytes: 0 }), reason: 'No actual physical allocation observations' },
    { label: 'missing raw digest', change: value => ({ ...value, traceSha256: '' }), reason: 'GPU traceSha256 missing' },
  ];
  it.each(negatives)('rejects $label without turning missing coverage into zero', ({ change, reason }) => {
    const result = qualifyGpuResidentSample(change(certificate()), expected);
    expect(result.actualBytes).toBeNull(); expect(result.unknown).toContain(reason);
  });
  it('counts one physical backing shared by two current owned processes once', () => {
    const other = { ...process, pid: 13, created: '200' };
    const value = certificate();
    const otherOwner = { pid: other.pid, created: other.created, parentPid: other.parentPid };
    value.target.processes.push(otherOwner); value.allocations[0]?.owners.push(otherOwner);
    const result = qualifyGpuResidentSample(value, { ...expected, frame: { ...expected.frame, processes: [process, other] } });
    expect(result.actualBytes).toBe(64); expect(result.unknown).toEqual([]);
  });
  it('requires actual root identity and Root-admitted evidence digest in addition to scalar success', () => {
    expect(qualifyGpuResidentSample(certificate(), { ...expected, frame: frame(100, 'build') }).actualBytes).toBeNull();
    expect(qualifyGpuResidentSample(certificate(), { ...expected, evidenceSha256: '' }).unknown).toContain('Root evidence digest missing');
  });
  function postTraceFixture() {
    const phases: readonly MemoryPhase[] = ['baseline', 'transfer', 'build', 'publish', 'cancel', 'released'];
    const runNonce = 'root-issued-nonce-0001';
    const sourceSha = { 'e2e/tests/memoryHighwaterFlow.ts': 'e'.repeat(64) };
    const frames = phases.map((phase, index) => ({ ...frame(100 + index * 40, phase), rootCreated: 'root-0' }));
    const workload: MemoryWorkloadCapture = { schema: 'pcad-memory-workload-v1', runNonce, rootIssuedNonce: true,
      kind: 'solid', rootPid: 1, rootCreated: 'root-0', includeRoot: false, sourceSha,
      phaseSha256: 'f'.repeat(64), boundaries: phases.map((phase, index) => ({ atEpochMs: 90 + index * 40, phase, observation: 'synthetic phase' })),
      frames, intervalMs: 100, discoveryIntervalMs: 2000, budgetBytes: 512 * 1024 * 1024, acceptanceComplete: false,
      sourceStable: true, samplerFailures: [], scenarioError: null, updates: 100, failureRecovered: true };
    const binding = { runNonce, workloadSha256: '1'.repeat(64), phaseSha256: workload.phaseSha256,
      kind: workload.kind, rootPid: 1, rootCreated: 'root-0', includeRoot: false, sourceSha };
    const samples = phases.map((phase, index) => {
      const sample = certificate(); const start = 90 + index * 40, end = 110 + index * 40;
      return { ...sample, decodedSha256: '2'.repeat(64), window: { ...sample.window, phase, startedAtEpochMs: start,
        endedAtEpochMs: end, qpcStart: start, qpcEnd: end }, capture: { ...sample.capture, endedAtEpochMs: 400 } };
    });
    const bundle = { schema: 'pcad-gpu-posttrace-v1', rootPhysicalMeaningVerified: true, binding,
      traceOwnership: { runNonce, sessionName: 'owned-test-session', rootPid: 1, rootCreated: 'root-0', ownedStopCompleted: true, traceSha256: 'a'.repeat(64), decodedSha256: '2'.repeat(64) }, samples };
    const expectation = { runNonce, workloadSha256: binding.workloadSha256, bundleSha256: '3'.repeat(64), phaseSha256: workload.phaseSha256,
      verifiedArtifactRoles: [`trace:${'a'.repeat(64)}`, `schema:${'b'.repeat(64)}`, `decoder:${'c'.repeat(64)}`, `decoded:${'2'.repeat(64)}`] };
    return { workload, bundle, expectation };
  }
  it('joins a consistent stopped structural fixture after collection without claiming full PG4 PASS or actual OS provenance', () => {
    const fixture = postTraceFixture();
    expect(memoryWorkloadCapture(fixture.workload)).toBe(true);
    const result = consumeGpuPostTrace(fixture.workload, fixture.bundle, fixture.expectation);
    expect(result.status).toBe('known'); expect(result.problems).toEqual([]);
    expect(result.gpu).toHaveLength(6); expect(result.acceptanceComplete).toBe(false);
    expect(result.verificationScope).toBe('post-trace-structure-only'); expect(result.canOverrideOriginalRun).toBe(false);
  });
  const postNegatives: readonly { label: string; change: (fixture: ReturnType<typeof postTraceFixture>) => unknown }[] = [
    { label: 'old run nonce', change: fixture => ({ ...fixture.bundle, binding: { ...fixture.bundle.binding, runNonce: 'old-run-nonce-0001' } }) },
    { label: 'changed workload bytes', change: fixture => ({ ...fixture.bundle, binding: { ...fixture.bundle.binding, workloadSha256: '4'.repeat(64) } }) },
    { label: 'changed whole phase digest', change: fixture => ({ ...fixture.bundle, binding: { ...fixture.bundle.binding, phaseSha256: '4'.repeat(64) } }) },
    { label: 'PID reused', change: fixture => ({ ...fixture.bundle, binding: { ...fixture.bundle.binding, rootCreated: 'reused' } }) },
    { label: 'foreign source', change: fixture => ({ ...fixture.bundle, binding: { ...fixture.bundle.binding, sourceSha: {} } }) },
    { label: 'unowned stop', change: fixture => ({ ...fixture.bundle, traceOwnership: { ...fixture.bundle.traceOwnership, ownedStopCompleted: false } }) },
    { label: 'foreign trace nonce', change: fixture => ({ ...fixture.bundle, traceOwnership: { ...fixture.bundle.traceOwnership, runNonce: 'foreign-nonce-0001' } }) },
    { label: 'Root physical semantics unresolved', change: fixture => ({ ...fixture.bundle, rootPhysicalMeaningVerified: false }) },
    { label: 'missing phase', change: fixture => ({ ...fixture.bundle, samples: fixture.bundle.samples.slice(1) }) },
    { label: 'eight undecoded events', change: fixture => ({ ...fixture.bundle, samples: fixture.bundle.samples.map(sample => ({ ...sample, capture: { ...sample.capture, undecodedEvents: 8 } })) }) },
  ];
  it.each(postNegatives)('keeps $label unknown after post-trace joining', ({ change }) => {
    const fixture = postTraceFixture(); const result = consumeGpuPostTrace(fixture.workload, change(fixture), fixture.expectation);
    expect(result.status).toBe('unknown'); expect(result.problems.length).toBeGreaterThan(0);
    expect(result.gpu.every(sample => sample.actualBytes === null)).toBe(true);
    expect(result.canOverrideOriginalRun).toBe(false); expect(result.verificationScope).toBe('post-trace-structure-only');
    expect(result.acceptanceComplete).toBe(false);
  });
  it('rejects substituted decoded bytes or missing verified raw roles and collect-only provenance', () => {
    const fixture = postTraceFixture();
    expect(consumeGpuPostTrace(fixture.workload, fixture.bundle, { ...fixture.expectation, verifiedArtifactRoles: [] }).status).toBe('unknown');
    expect(memoryWorkloadCapture({ ...fixture.workload, rootIssuedNonce: false })).toBe(false);
    expect(memoryWorkloadCapture({ ...fixture.workload, sourceStable: false })).toBe(false);
    expect(memoryWorkloadCapture({ ...fixture.workload, scenarioError: 'real failure' })).toBe(false);
    expect(memoryWorkloadCapture({ ...fixture.workload, samplerFailures: ['discovery failed'] })).toBe(false);
    expect(memoryWorkloadCapture({ ...fixture.workload, updates: 99 })).toBe(false);
    expect(consumeGpuPostTrace(fixture.workload, { ...fixture.bundle, traceOwnership: { ...fixture.bundle.traceOwnership, traceSha256: '5'.repeat(64) } }, fixture.expectation).status).toBe('unknown');
    expect(consumeGpuPostTrace(fixture.workload, {}, fixture.expectation).status).toBe('unknown');
  });
});

describe('same-RUN posttrace delivery boundary (synthetic structure, no OS qualification)', () => {
  const context = { runNonce: 'root-issued-nonce-0001', workloadSha256: '1'.repeat(64), phaseSha256: '2'.repeat(64),
    rootPid: 1, rootCreated: 'birth-1', sessionName: 'PCAD-Owned-Nonce-0001' };
  function delivery() {
    return { schema: 'pcad-gpu-posttrace-delivery-v1', ...context, ownedStopCompleted: true,
      bundlePath: 'bundle.json', bundleSha256: '3'.repeat(64), stopReceiptPath: 'stop.json', stopReceiptSha256: '4'.repeat(64) };
  }
  function stopped() {
    return { owned_name: context.sessionName, actual_admin_token: true, start_exit: 0,
      commands: [
        { label: 'owned-create', exit: 0, arguments: ['logman.exe', 'create', 'trace', context.sessionName, '-p', '{802ec45a-1e99-4b83-9920-87c98277ba9d}', '-ets'] },
        { label: 'owned-query', exit: 0, arguments: ['logman.exe', 'query', context.sessionName, '-ets'] },
        { label: 'owned-stop', exit: 0, arguments: ['logman.exe', 'stop', context.sessionName, '-ets'] },
      ], files: { 'run.etl': { sha256: 'a'.repeat(64), bytes: 100 } } };
  }
  it('admits matching final hashes after owned stop without requiring a future hash at workload start', () => {
    expect(gpuPostTraceDelivery(delivery(), context)).toEqual({ bundlePath: 'bundle.json', bundleSha256: '3'.repeat(64),
      stopReceiptPath: 'stop.json', stopReceiptSha256: '4'.repeat(64) });
    expect(gpuOwnedStopReceipt(stopped(), context.sessionName, 'a'.repeat(64))).toBe(true);
  });
  it.each(['runNonce', 'workloadSha256', 'phaseSha256', 'rootCreated', 'sessionName'] as const)('rejects old/foreign %s before resident consumption', key => {
    expect(gpuPostTraceDelivery({ ...delivery(), [key]: 'foreign' }, context)).toBeNull();
  });
  it('rejects premature stop, reused PID, missing final hashes and missing raw receipt', () => {
    expect(gpuPostTraceDelivery({ ...delivery(), ownedStopCompleted: false }, context)).toBeNull();
    expect(gpuPostTraceDelivery({ ...delivery(), rootPid: 2 }, context)).toBeNull();
    expect(gpuPostTraceDelivery({ ...delivery(), bundleSha256: '' }, context)).toBeNull();
    expect(gpuPostTraceDelivery({ ...delivery(), stopReceiptSha256: '' }, context)).toBeNull();
  });
  it('rejects stop failure/foreign session/duplicate command/raw ETL digest mismatch', () => {
    const receipt = stopped();
    expect(gpuOwnedStopReceipt({ ...receipt, commands: receipt.commands.map(command => command.label === 'owned-stop' ? { ...command, exit: 1 } : command) }, context.sessionName, 'a'.repeat(64))).toBe(false);
    expect(gpuOwnedStopReceipt(receipt, 'foreign-session', 'a'.repeat(64))).toBe(false);
    expect(gpuOwnedStopReceipt({ ...receipt, commands: [...receipt.commands, ...receipt.commands] }, context.sessionName, 'a'.repeat(64))).toBe(false);
    expect(gpuOwnedStopReceipt(receipt, context.sessionName, 'b'.repeat(64))).toBe(false);
  });
  it('bounds waiting by the original case deadline without extending zero/expired/late budgets', () => {
    expect(gpuPostTraceWaitBudget(100, 0, 180, 150)).toBe(50);
    expect(gpuPostTraceWaitBudget(100, 0, 180, 180)).toBe(80);
    expect(gpuPostTraceWaitBudget(100, 0, 180, 181)).toBeNull();
    expect(gpuPostTraceWaitBudget(180, 0, 180, 180)).toBeNull();
    expect(gpuPostTraceWaitBudget(100, 0, 0, 180)).toBeNull();
    expect(gpuPostTraceWaitBudget(100, 0, 180, Number.NaN)).toBeNull();
  });
});
