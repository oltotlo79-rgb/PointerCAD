/** Sampled conservative bound, never an exact resident/allocated/reserved conversion.
 * Census and rows must come from the SAME Root-owned run. The native producer must
 * establish the census before this consumer can qualify it; absent data is unknown.
 */
export interface UsageIdentity { readonly pid: number; readonly birth: string }
export interface UsageRow extends UsageIdentity {
  readonly luid: string; readonly node: number; readonly group: 0 | 1;
  readonly currentUsage: number | null; readonly reservation: number | null;
  readonly budget: number | null; readonly valid: boolean;
}
export interface UsageAdapter {
  readonly luid: string; readonly nodes: number; readonly segmentCount: number;
  readonly segments: readonly {
    readonly id: number; readonly group: 0 | 1 | 2; readonly flags: number;
    readonly size: number; readonly commitLimit: string;
  }[];
}
export interface UsageWindow {
  readonly nonce: string; readonly runSha256: string; readonly sequence: number;
  readonly startedAtEpochMs: number; readonly endedAtEpochMs: number;
  readonly owners: readonly UsageIdentity[]; readonly rows: readonly UsageRow[];
  readonly ownershipErrors: readonly string[]; readonly queryErrors: readonly string[];
}
export interface UsageCensus {
  readonly nonce: string; readonly runSha256: string;
  readonly sourceSha256: string; readonly adapters: readonly UsageAdapter[];
  readonly enumerationSha256: string; readonly rundownSha256: string;
  readonly errors: readonly string[];
}
export interface UsageBoundary { readonly atEpochMs: number; readonly phase: string }
const integer = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const digest = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value);
const identity = (value: UsageIdentity): string => `${value.pid}:${value.birth}`;
const validIdentity = (value: UsageIdentity): boolean => integer(value.pid) && value.pid > 0
  && /^[1-9][0-9]*$/u.test(value.birth);
const key = (row: UsageRow): string => `${identity(row)}:${row.luid}:${row.node}:${row.group}`;
const phases = ['baseline', 'transfer', 'build', 'publish', 'cancel', 'released'] as const;

export function qualifyDocumentedGpuUsage(input: {
  readonly nonce: string; readonly runSha256: string; readonly sourceSha256: string;
  readonly census: UsageCensus | null; readonly windows: readonly UsageWindow[];
  readonly boundaries: readonly UsageBoundary[]; readonly endedAtEpochMs: number;
}) {
  const problems: string[] = [];
  const census = input.census;
  let uncoveredCapacity = 0;
  const adapters = new Map<string, UsageAdapter>();
  if (!digest(input.runSha256) || !digest(input.sourceSha256) || !input.nonce) problems.push('Invalid run binding');
  if (census === null || census.nonce !== input.nonce || census.runSha256 !== input.runSha256
      || census.sourceSha256 !== input.sourceSha256 || !digest(census.enumerationSha256)
      || !digest(census.rundownSha256) || census.errors.length > 0 || census.adapters.length === 0) {
    problems.push('Same-run complete adapter/segment census unavailable');
  } else {
    for (const adapter of census.adapters) {
      if (!/^[a-f0-9]{16}$/u.test(adapter.luid) || adapters.has(adapter.luid)
          || !integer(adapter.nodes) || adapter.nodes < 1 || adapter.nodes > 16 || !integer(adapter.segmentCount)
          || adapter.segmentCount < 1 || adapter.segmentCount > 4096 || adapter.segments.length !== adapter.segmentCount) {
        problems.push('Adapter enumeration incomplete or duplicated'); continue;
      }
      adapters.set(adapter.luid, adapter);
      const segmentIds = new Set<number>();
      for (const segment of adapter.segments) {
        if (!integer(segment.id) || segment.id < 1 || segment.id > adapter.segmentCount
            || segmentIds.has(segment.id) || !integer(segment.flags) || segment.flags > 0xffffffff || !integer(segment.size)
            || !/^[0-9]+$/u.test(segment.commitLimit) || ![0, 1, 2].includes(segment.group)) {
          problems.push('Segment census invalid or duplicated'); continue;
        }
        segmentIds.add(segment.id);
        const budgetFlags = segment.flags & 0x180000;
        if ((segment.group === 0 && budgetFlags !== 0x80000)
            || (segment.group === 1 && budgetFlags !== 0x100000)
            || (segment.group === 2 && budgetFlags !== 0)) {
          problems.push('Segment group disagrees with actual budget flags');
        }
        if (segment.group === 2) {
          // An AGP aperture ignores Size; an aperture maps backing pages. Neither
          // is silently treated as this finite physical memory capacity proof.
          if ((segment.flags & 0x03) !== 0 || BigInt(segment.size) !== BigInt(segment.commitLimit)) {
            problems.push('Non-budget segment capacity meaning unsupported');
          } else uncoveredCapacity += segment.size;
        }
      }
      if (segmentIds.size !== adapter.segmentCount) problems.push('Missing segment ID');
    }
  }
  if (!integer(uncoveredCapacity)) problems.push('Non-budget capacity overflow');
  if (input.boundaries.length === 0 || !integer(input.endedAtEpochMs)
      || input.boundaries.some((b, i) => !integer(b.atEpochMs) || !phases.some(p => p === b.phase)
        || (i > 0 && b.atEpochMs < (input.boundaries[i - 1]?.atEpochMs ?? Infinity)))) {
    problems.push('Invalid actual phase boundaries');
  }
  const unassigned: { sequence: number; reason: string }[] = [];
  const qualified: { sequence: number; phase: string; chargedUsageBytes: number; upperBoundBytes: number;
    startedAtEpochMs: number; endedAtEpochMs: number }[] = [];
  const caseWindows: { sequence: number; upperBoundBytes: number; chargedUsageBytes: number;
    startedAtEpochMs: number; endedAtEpochMs: number }[] = [];
  const sequences = new Set<number>();
  for (const window of input.windows) {
    if (!integer(window.startedAtEpochMs) || !integer(window.endedAtEpochMs)
        || window.startedAtEpochMs > window.endedAtEpochMs) {
      problems.push('Invalid usage window time interval'); continue;
    }
    const caseStart = input.boundaries[0]?.atEpochMs;
    if (caseStart !== undefined && (window.endedAtEpochMs < caseStart || window.startedAtEpochMs >= input.endedAtEpochMs)) {
      unassigned.push({ sequence: window.sequence, reason: 'wholly outside current case' }); continue;
    }
    let index = input.boundaries.length - 1;
    while (index >= 0 && (input.boundaries[index]?.atEpochMs ?? Infinity) > window.startedAtEpochMs) index--;
    const boundary = input.boundaries[index];
    const end = input.boundaries[index + 1]?.atEpochMs ?? input.endedAtEpochMs;
    const contained = boundary !== undefined && window.endedAtEpochMs < end;
    if (!contained) unassigned.push({ sequence: window.sequence, reason: 'crosses phase or case boundary; retained for case peak' });
    const before = problems.length;
    if (window.nonce !== input.nonce || window.runSha256 !== input.runSha256 || !integer(window.sequence)
        || sequences.has(window.sequence) || !integer(window.startedAtEpochMs) || !integer(window.endedAtEpochMs)
        || window.startedAtEpochMs > window.endedAtEpochMs || window.ownershipErrors.length > 0
        || window.queryErrors.length > 0) problems.push('Invalid, foreign or incomplete usage window');
    sequences.add(window.sequence);
    const expected = new Set<string>();
    const owners = new Set<string>();
    for (const owner of window.owners) {
      if (!validIdentity(owner) || owners.has(identity(owner))) problems.push('Invalid or duplicate PID birth');
      owners.add(identity(owner));
      for (const adapter of adapters.values()) for (let node = 0; node < adapter.nodes; node++) {
        for (const group of [0, 1] as const) expected.add(`${identity(owner)}:${adapter.luid}:${node}:${group}`);
      }
    }
    if (owners.size === 0 || expected.size === 0) problems.push('Empty ownership cannot prove zero');
    let charged = 0;
    for (const row of window.rows) {
      if (!expected.delete(key(row)) || !row.valid || row.currentUsage === null || !integer(row.currentUsage)
          || row.reservation === null || !integer(row.reservation) || row.budget === null || !integer(row.budget)) {
        problems.push('Missing, duplicate, failed or foreign process query'); continue;
      }
      charged += row.currentUsage;
    }
    if (expected.size > 0 || !integer(charged) || !integer(charged + uncoveredCapacity)) problems.push('Incomplete or overflowing query sum');
    if (problems.length === before) caseWindows.push({ sequence: window.sequence,
      chargedUsageBytes: charged, upperBoundBytes: charged + uncoveredCapacity,
      startedAtEpochMs: window.startedAtEpochMs, endedAtEpochMs: window.endedAtEpochMs });
    if (problems.length === before && contained && boundary !== undefined) qualified.push({ sequence: window.sequence,
      phase: boundary.phase, chargedUsageBytes: charged, upperBoundBytes: charged + uncoveredCapacity,
      startedAtEpochMs: window.startedAtEpochMs, endedAtEpochMs: window.endedAtEpochMs });
  }
  for (const phase of phases) if (!qualified.some(row => row.phase === phase)) problems.push(`Missing sampled phase: ${phase}`);
  const maximum = (phase?: string): number | null => {
    const rows = phase === undefined ? caseWindows : qualified.filter(row => row.phase === phase);
    return rows.length === 0 ? null : Math.max(...rows.map(row => row.upperBoundBytes));
  };
  const peak = maximum();
  return { meaning: 'sampled conservative usage upper bound; not exact physical residency',
    status: problems.length === 0 ? 'known' : 'unknown', problems, windows: qualified, caseWindows, unassigned,
    nonBudgetCapacityUpperBoundBytes: problems.length === 0 ? uncoveredCapacity : null,
    baselineUpperBoundBytes: maximum('baseline'), peakUpperBoundBytes: peak,
    releasedUpperBoundBytes: maximum('released'),
    // Subtracting an inflated baseline would understate an increase. The absolute
    // peak is a conservative bound on additional use because true baseline >= 0.
    additionalPeakUpperBoundBytes: problems.length === 0 ? peak : null,
    within512MiB: problems.length === 0 && peak !== null && peak < 512 * 1024 * 1024,
    physicalResidentBytes: null, allocatedBytes: null,
    limitations: ['Sampled windows do not prove continuous maxima',
      'Query windows contain sequential per-process readings',
      'Shared charging may overcount; no exact union or per-category physical total is claimed',
      'Non-budget actual is unknown; its complete finite segment capacity is bounded instead'] };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === 'string';
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const ownerShape = (value: unknown): value is UsageIdentity => record(value) && number(value['pid']) && text(value['birth']);
const rowShape = (value: unknown): value is UsageRow => ownerShape(value) && record(value)
  && text(value['luid']) && number(value['node']) && (value['group'] === 0 || value['group'] === 1)
  && (value['currentUsage'] === null || number(value['currentUsage']))
  && (value['reservation'] === null || number(value['reservation']))
  && (value['budget'] === null || number(value['budget'])) && typeof value['valid'] === 'boolean';

export function parseUsageWindow(value: unknown): UsageWindow {
  if (!record(value) || !text(value['nonce']) || !text(value['runSha256']) || !number(value['sequence'])
      || !number(value['startedAtEpochMs']) || !number(value['endedAtEpochMs'])
      || !Array.isArray(value['owners']) || !value['owners'].every(ownerShape)
      || !Array.isArray(value['rows']) || !value['rows'].every(rowShape)
      || !texts(value['ownershipErrors']) || !texts(value['queryErrors'])) throw new Error('Invalid documented usage window');
  return { nonce: value['nonce'], runSha256: value['runSha256'], sequence: value['sequence'],
    startedAtEpochMs: value['startedAtEpochMs'], endedAtEpochMs: value['endedAtEpochMs'],
    owners: value['owners'], rows: value['rows'], ownershipErrors: value['ownershipErrors'], queryErrors: value['queryErrors'] };
}

export function parseUsageCensus(value: unknown): UsageCensus {
  if (!record(value) || !text(value['nonce']) || !text(value['runSha256']) || !text(value['sourceSha256'])
      || !text(value['enumerationSha256']) || !text(value['rundownSha256']) || !texts(value['errors'])
      || !Array.isArray(value['adapters'])) throw new Error('Invalid documented usage census');
  const adapters: UsageAdapter[] = [];
  for (const adapter of value['adapters']) {
    if (!record(adapter) || !text(adapter['luid']) || !number(adapter['nodes']) || !number(adapter['segmentCount'])
        || !Array.isArray(adapter['segments'])) throw new Error('Invalid census adapter');
    const segments: UsageAdapter['segments'][number][] = [];
    for (const segment of adapter['segments']) {
      if (!record(segment) || !number(segment['id']) || !number(segment['flags']) || !number(segment['size'])
          || !text(segment['commitLimit']) || (segment['group'] !== 0 && segment['group'] !== 1 && segment['group'] !== 2)) {
        throw new Error('Invalid census segment');
      }
      segments.push({ id: segment['id'], flags: segment['flags'], size: segment['size'],
        commitLimit: segment['commitLimit'], group: segment['group'] });
    }
    adapters.push({ luid: adapter['luid'], nodes: adapter['nodes'], segmentCount: adapter['segmentCount'], segments });
  }
  return { nonce: value['nonce'], runSha256: value['runSha256'], sourceSha256: value['sourceSha256'],
    enumerationSha256: value['enumerationSha256'], rundownSha256: value['rundownSha256'], errors: value['errors'], adapters };
}
