import { describe, expect, it } from 'vitest';
import { sampledMemoryCaseAcceptance, summarizeSampledProcessMemory, memoryCaseAcceptance, type MemoryCaseConditions, summarizeProcessMemory, type ProcessMemoryFrame } from './processMemorySamples.js';

const budgetBytes = 512 * 1024 * 1024;
function conditions(extraBytes = 1): MemoryCaseConditions {
  const frame = (atEpochMs: number, phase: ProcessMemoryFrame['phase'], extra: number): ProcessMemoryFrame => ({
    atEpochMs, discoveredAtEpochMs: atEpochMs, phase, discoveryError: null,
    processes: [{ pid: 12, parentPid: 1, created: 'birth', name: 'renderer',
      workingSetBytes: 100 + extra, privateBytes: 80 + extra, error: null }],
  });
  return { summary: summarizeProcessMemory([frame(0, 'baseline', 0), frame(100, 'build', extraBytes), frame(200, 'released', 0)],
    { intervalMs: 100, discoveryIntervalMs: 100, requiredPhases: ['baseline', 'build', 'released'] }),
  budgetBytes, scenarioError: null, updates: 100, failureRecovered: true, samplerFailures: [],
  operationEnvelopesComplete: true, sourceStable: true };
}

describe('memory-highwater case-scoped acceptance', () => {
  it('derives success from real summarized CPU samples and complete case conditions', () => {
    expect(memoryCaseAcceptance(conditions())).toBe(true);
  });
  it.each([
    ['scenario error', { scenarioError: 'UI failed' }],
    ['99 updates', { updates: 99 }],
    ['101 updates', { updates: 101 }],
    ['recovery incomplete', { failureRecovered: false }],
    ['sampler failure', { samplerFailures: ['read failed'] }],
    ['missing runtime phase', { operationEnvelopesComplete: false }],
    ['source changed', { sourceStable: false }],
  ] satisfies readonly (readonly [string, Partial<MemoryCaseConditions>])[])(
    'rejects %s independently', (_name, delta) => {
      expect(memoryCaseAcceptance({ ...conditions(), ...delta })).toBe(false);
    });
  it('preserves strict 512MiB boundary', () => {
    expect(memoryCaseAcceptance(conditions(budgetBytes - 1))).toBe(true);
    expect(memoryCaseAcceptance(conditions(budgetBytes))).toBe(false);
  });
  it.each(['workingSet', 'privateMemory'] as const)('rejects unknown %s instead of zero', metric => {
    const value = conditions();
    expect(memoryCaseAcceptance({ ...value, summary: { ...value.summary,
      [metric]: { ...value.summary[metric], extraPeak: null } } })).toBe(false);
    expect(memoryCaseAcceptance({ ...value, summary: { ...value.summary,
      [metric]: { ...value.summary[metric], extraAfterRelease: null } } })).toBe(false);
  });
  it('rejects incomplete sampling even when known counters are small', () => {
    const value = conditions();
    expect(memoryCaseAcceptance({ ...value, summary: { ...value.summary, complete: false,
      problems: ['missing discovery'] } })).toBe(false);
  });
  it('opts into valid degraded observations without changing strict case acceptance', () => {
    const value = conditions();
    const frames = [1_000, 1_500, 1_700].map<ProcessMemoryFrame & { readonly readStartedAtEpochMs: number }>((atEpochMs, index) => ({ atEpochMs,
      readStartedAtEpochMs: atEpochMs - 10, discoveredAtEpochMs: atEpochMs - 10,
      phase: (index === 0 ? 'baseline' : index === 1 ? 'build' : 'released'),
      rootCreated: '100', discoveryError: null, processes: [{ pid: 12, parentPid: 1, created: '100', name: 'renderer',
        workingSetBytes: 100 + (index === 1 ? 1 : 0), privateBytes: 80, error: null }] }));
    const observation = summarizeSampledProcessMemory(frames, { intervalMs: 100, discoveryIntervalMs: 2_000,
      rootPid: 12, includeRoot: true, requiredPhases: ['baseline', 'build', 'released'], windows: frames.map(frame => ({
        phase: frame.phase, startedAtEpochMs: frame.readStartedAtEpochMs, endedAtEpochMs: frame.atEpochMs })) });
    expect(observation.cadence.status).toBe('degraded');
    expect(memoryCaseAcceptance({ ...value, summary: observation.strict })).toBe(false);
    expect(sampledMemoryCaseAcceptance({ ...value, observation })).toBe(true);
    expect(sampledMemoryCaseAcceptance({ ...value, observation, operationEnvelopesComplete: false })).toBe(false);
    expect(sampledMemoryCaseAcceptance({ ...value, observation, samplerFailures: ['read failed'] })).toBe(false);
    expect(sampledMemoryCaseAcceptance({ ...value, observation, sourceStable: false })).toBe(false);
  });
  it('does not infer a physical GPU or R07 lifetime result from a successful CPU case', () => {
    const diagnostics = { actualBytes: null, allocatedBytes: null, unknown: ['unobserved'], r07MeasuredInThisCase: false };
    const before = JSON.stringify(diagnostics);
    const input = { ...conditions(), gpuDiagnostics: diagnostics };
    expect(memoryCaseAcceptance(input)).toBe(true);
    expect(JSON.stringify(diagnostics)).toBe(before);
    expect(diagnostics.actualBytes).toBeNull();
    expect(diagnostics.r07MeasuredInThisCase).toBe(false);
  });
});


// Exact event projections from RUN20261109-231549-root-scope-electron-sampler-e2e.
// Generated from immutable raw artifact bytes, retaining owner/stream/generation,
// sequence, clocks and known-zero viewport counters. No scratchpad dependency.
const cancellationRawReplays = [
  {
    "kind": "assembly",
    "sourceSha256": "70a9dd5e92188ad3059191ba9557649e820e6b074f97e163c59f7d5682949eaa",
    "pressedAtEpochMs": 1794233915503,
    "requestedGeneration": 110,
    "events": [
      {
        "stream": "main",
        "sequence": 13,
        "atEpochMs": 1794233915141,
        "kind": "dispatch",
        "owner": "1:mesh-1-1-4",
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "main",
        "sequence": 14,
        "atEpochMs": 1794233915508,
        "kind": "geometry-cancel-request",
        "owner": "1:mesh-1-1-4",
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "main",
        "sequence": 15,
        "atEpochMs": 1794233915511,
        "kind": "raw-received",
        "owner": "1:mesh-1-1-4",
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "main",
        "sequence": 16,
        "atEpochMs": 1794233915511,
        "kind": "adopted",
        "owner": "1:mesh-1-1-4",
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "main",
        "sequence": 17,
        "atEpochMs": 1794233915515,
        "kind": "receiver-acknowledged",
        "owner": "1:mesh-1-1-4",
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "worker:1",
        "sequence": 28,
        "atEpochMs": 1794233915508,
        "kind": "geometry-cancel-request",
        "owner": "1:mesh-1-1-4",
        "generation": 110,
        "documentId": null
      },
      {
        "stream": "worker:1",
        "sequence": 29,
        "atEpochMs": 1794233915508,
        "kind": "native-build-cancelled",
        "owner": "1:mesh-1-1-4",
        "generation": 110,
        "documentId": null
      },
      {
        "stream": "worker:1",
        "sequence": 30,
        "atEpochMs": 1794233915509,
        "kind": "reply-preclone",
        "owner": "1:mesh-1-1-4",
        "generation": 110,
        "documentId": null
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5938,
        "atEpochMs": 1794233915129.78,
        "kind": "publish-complete",
        "owner": "solid-operation-1188",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5943,
        "atEpochMs": 1794233915130.26,
        "kind": "publish-complete",
        "owner": "solid-operation-1189",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5948,
        "atEpochMs": 1794233915130.2751,
        "kind": "publish-complete",
        "owner": "solid-operation-1190",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5953,
        "atEpochMs": 1794233915130.29,
        "kind": "publish-complete",
        "owner": "solid-operation-1191",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5958,
        "atEpochMs": 1794233915130.3052,
        "kind": "publish-complete",
        "owner": "solid-operation-1192",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5963,
        "atEpochMs": 1794233915503.2751,
        "kind": "publish-complete",
        "owner": "solid-operation-1193",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5968,
        "atEpochMs": 1794233915515.7651,
        "kind": "publish-complete",
        "owner": "solid-operation-1194",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5973,
        "atEpochMs": 1794233915516.1501,
        "kind": "publish-complete",
        "owner": "solid-operation-1195",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5978,
        "atEpochMs": 1794233916091.27,
        "kind": "publish-complete",
        "owner": "solid-operation-1196",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5983,
        "atEpochMs": 1794233916091.28,
        "kind": "publish-complete",
        "owner": "solid-operation-1197",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5988,
        "atEpochMs": 1794233916097.2952,
        "kind": "publish-complete",
        "owner": "solid-operation-1198",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 5993,
        "atEpochMs": 1794233916097.3152,
        "kind": "publish-complete",
        "owner": "solid-operation-1199",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "2e52e396-3e67-4f8c-a7b6-00e6790cb729"
      }
    ]
  },
  {
    "kind": "solid",
    "sourceSha256": "0ee7f3d41050e2d274c6aaf15317b51255ba977c81987a3db09c5a1c8dfa0429",
    "pressedAtEpochMs": 1794233824824,
    "requestedGeneration": 110,
    "events": [
      {
        "stream": "main",
        "sequence": 417,
        "atEpochMs": 1794233824437,
        "kind": "dispatch",
        "owner": "1:mesh-1-1-105",
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "main",
        "sequence": 418,
        "atEpochMs": 1794233824831,
        "kind": "geometry-cancel-request",
        "owner": "1:mesh-1-1-105",
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "main",
        "sequence": 419,
        "atEpochMs": 1794233824833,
        "kind": "raw-received",
        "owner": "1:mesh-1-1-105",
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "main",
        "sequence": 420,
        "atEpochMs": 1794233824833,
        "kind": "adopted",
        "owner": "1:mesh-1-1-105",
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "main",
        "sequence": 421,
        "atEpochMs": 1794233824834,
        "kind": "receiver-acknowledged",
        "owner": "1:mesh-1-1-105",
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "worker:1",
        "sequence": 434,
        "atEpochMs": 1794233824831,
        "kind": "geometry-cancel-request",
        "owner": "1:mesh-1-1-105",
        "generation": 110,
        "documentId": null
      },
      {
        "stream": "worker:1",
        "sequence": 435,
        "atEpochMs": 1794233824831,
        "kind": "native-build-cancelled",
        "owner": "1:mesh-1-1-105",
        "generation": 110,
        "documentId": null
      },
      {
        "stream": "worker:1",
        "sequence": 436,
        "atEpochMs": 1794233824832,
        "kind": "reply-preclone",
        "owner": "1:mesh-1-1-105",
        "generation": 110,
        "documentId": null
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 933,
        "atEpochMs": 1794233824425.775,
        "kind": "publish-complete",
        "owner": "solid-operation-187",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 938,
        "atEpochMs": 1794233824426.145,
        "kind": "publish-complete",
        "owner": "solid-operation-188",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 943,
        "atEpochMs": 1794233824426.165,
        "kind": "publish-complete",
        "owner": "solid-operation-189",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 948,
        "atEpochMs": 1794233824426.175,
        "kind": "publish-complete",
        "owner": "solid-operation-190",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 953,
        "atEpochMs": 1794233824426.19,
        "kind": "publish-complete",
        "owner": "solid-operation-191",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 958,
        "atEpochMs": 1794233824824.41,
        "kind": "publish-complete",
        "owner": "solid-operation-192",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 963,
        "atEpochMs": 1794233824833.8,
        "kind": "publish-complete",
        "owner": "solid-operation-193",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 968,
        "atEpochMs": 1794233824834.34,
        "kind": "publish-complete",
        "owner": "solid-operation-194",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 973,
        "atEpochMs": 1794233825110.665,
        "kind": "publish-complete",
        "owner": "solid-operation-195",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 978,
        "atEpochMs": 1794233825110.675,
        "kind": "publish-complete",
        "owner": "solid-operation-196",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 983,
        "atEpochMs": 1794233825117.04,
        "kind": "publish-complete",
        "owner": "solid-operation-197",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      },
      {
        "stream": "viewport:viewport-1",
        "sequence": 988,
        "atEpochMs": 1794233825117.055,
        "kind": "publish-complete",
        "owner": "solid-operation-198",
        "hostDisplayCopyBytes": 0,
        "hostGpuAttributeBytes": 0,
        "generation": 110,
        "documentId": "8e8fa63f-4d95-4c90-8939-14a4681dee2d"
      }
    ]
  }
] as const;

describe('stress measurement scope and exact cancellation', () => {
  const event = (stream: string, kind: string, atEpochMs: number, owner = '1:request-1') => ({
    stream, kind, atEpochMs, owner, generation: 7, documentId: stream === 'worker:1' ? null : 'document-1',
  });
  function stress() {
    const frames = [1_000, 1_500, 1_700].map<ProcessMemoryFrame & { readonly readStartedAtEpochMs: number }>((atEpochMs, index) => ({ atEpochMs,
      readStartedAtEpochMs: atEpochMs - 10, discoveredAtEpochMs: atEpochMs - 10,
      phase: (index === 0 ? 'baseline' : index === 1 ? 'build' : 'released'),
      rootCreated: '100', discoveryError: null, processes: [{ pid: 12, parentPid: 1, created: '100', name: 'renderer',
        workingSetBytes: 100 + (index === 1 ? 640_987_136 : 0), privateBytes: 80, error: null }] }));
    const settings = { intervalMs: 100, discoveryIntervalMs: 2_000, rootPid: 12, includeRoot: true,
      scope: 'stress-observation' as const, requiredPhases: ['baseline', 'build', 'released'] as const,
      windows: frames.map(frame => ({ phase: frame.phase, startedAtEpochMs: frame.readStartedAtEpochMs, endedAtEpochMs: frame.atEpochMs })) };
    const observation = summarizeSampledProcessMemory(frames, settings);
    const events = [event('main', 'dispatch', 100), event('main', 'geometry-cancel-request', 120),
      event('worker:1', 'native-build-cancelled', 121), event('worker:1', 'reply-preclone', 122),
      event('main', 'raw-received', 123), event('main', 'adopted', 124)];
    return { ...conditions(), observation, cancellationEvidence: { pressedAtEpochMs: 119, requestedGeneration: 7, events } };
  }
  it('retains high bytes and strict rejection while applying the declared stress scope', () => {
    const value = stress();
    expect(value.observation.workingSet.extraPeak).toBe(640_987_136);
    expect(value.observation.strict.complete).toBe(false);
    expect(sampledMemoryCaseAcceptance(value)).toBe(true);
    expect(sampledMemoryCaseAcceptance({ ...value, observation: { ...value.observation, scope: 'save-budget' } })).toBe(false);
    expect(sampledMemoryCaseAcceptance({ ...value, observation: { ...value.observation, observationValid: false } })).toBe(false);
  });
  it('allows known empty viewport re-admission and another dispatch reply, but rejects actual or unknown geometry', () => {
    const value = stress();
    const empty = { ...event('viewport:viewport-1', 'publish-complete', 122, 'solid-operation-2'),
      hostDisplayCopyBytes: 0, hostGpuAttributeBytes: 0 };
    const apply = (extra: typeof empty | ReturnType<typeof event>) => sampledMemoryCaseAcceptance({ ...value,
      cancellationEvidence: { ...value.cancellationEvidence, events: [...value.cancellationEvidence.events, extra] } });
    expect(apply(empty)).toBe(true);
    expect(apply(event('main', 'raw-received', 122, '2:request-1'))).toBe(true);
    expect(apply(event('main', 'raw-received', 122))).toBe(false);
    expect(apply({ ...empty, hostGpuAttributeBytes: 1 })).toBe(false);
    expect(apply(event('viewport:viewport-1', 'publish-complete', 122))).toBe(false);
  });
  it.each(cancellationRawReplays)('replays actual $kind cancellation result replies without confusing them with geometry publication', replay => {
    const value = { ...stress(), cancellationEvidence: replay };
    expect(replay.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(sampledMemoryCaseAcceptance(value)).toBe(true);
    const cancelled = replay.events.find(event => event.kind === 'native-build-cancelled');
    if (cancelled === undefined) throw new Error('Actual cancellation event absent');
    const apply = (events: Parameters<typeof sampledMemoryCaseAcceptance>[0]['cancellationEvidence']) =>
      sampledMemoryCaseAcceptance({ ...value, cancellationEvidence: events });
    expect(apply({ ...replay, events: replay.events.filter(event => event.kind !== 'reply-preclone') })).toBe(false);
    expect(apply({ ...replay, events: replay.events.map(event => event.kind === 'raw-received'
      ? { ...event, atEpochMs: cancelled.atEpochMs - 1 } : event) })).toBe(false);
    expect(apply({ ...replay, events: [...replay.events, { ...cancelled, kind: 'native-build-return' }] })).toBe(false);
    expect(apply({ ...replay, events: replay.events.map(event => event.kind === 'publish-complete'
      ? { ...event, hostGpuAttributeBytes: 1 } : event) })).toBe(false);
    expect(apply({ ...replay, events: replay.events.map(event => event.kind === 'native-build-cancelled'
      ? { ...event, owner: '2:other-dispatch', stream: 'worker:2' } : event) })).toBe(false);
  });
  it('rejects terminal-only, wrong worker epoch, wrong generation and missing dispatch evidence', () => {
    const value = stress();
    const events = value.cancellationEvidence.events;
    for (const invalid of [[], events.slice(1), events.filter(event => event.kind !== 'native-build-cancelled'),
      events.map(event => event.kind === 'native-build-cancelled' ? { ...event, stream: 'worker:2' } : event),
      events.map(event => event.kind === 'native-build-cancelled' ? { ...event, generation: 8 } : event)]) {
      expect(sampledMemoryCaseAcceptance({ ...value, cancellationEvidence: { ...value.cancellationEvidence, events: invalid } })).toBe(false);
    }
  });
});
