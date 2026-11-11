import type { CurrentOriginIndex, OriginBinding, OriginLookup, ShapeAddress,
  SubShapeOrigin } from '../subShapeOrigin.js';
import type { SubShapeHistoryEntry } from './subShapeHistory.js';

export interface SemanticStepInput {
  readonly sourceId: string;
  /** Two inputs are aliases only when they name the same actual source. */
  readonly aliasOf?: string;
  readonly origins: CurrentOriginIndex;
}
export interface SemanticStepContext {
  /** Only native-proved machining may introduce partial coverage for a genuinely unnamed input. */
  readonly allowUntrackedRegions?: boolean;
  readonly featureId: string;
  readonly inputs: readonly SemanticStepInput[];
}

const key = (address: ShapeAddress): string => `${address.kind}:${address.index}`;
const same = (origin: SubShapeOrigin): string => JSON.stringify(origin,
  (_key: string, value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = record[key];
    return sorted;
  });
const missing = (origin: SubShapeOrigin, reason: 'deleted' | 'source-missing' | 'history-missing'): OriginBinding =>
  ({ origin, state: 'missing', reason });

/** Bounds both newly created origins and inherited nested origins before exposing any partial table. */
export function withinOriginLimits(origin: SubShapeOrigin): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const walk = (value: unknown, depth: number): boolean => {
    if (depth > 16 || ++nodes > 128) return false;
    if (typeof value === 'string') return value.length <= 256;
    if (value === null || typeof value !== 'object') return true;
    if (seen.has(value)) return false;
    seen.add(value);
    const entries = Array.isArray(value) ? value : Object.values(value);
    if (Array.isArray(value) && value.length > 32) return false;
    for (const item of entries) if (!walk(item, depth + 1)) return false;
    seen.delete(value);
    return true;
  };
  if (!walk(origin, 1)) return false;
  return new TextEncoder().encode(JSON.stringify(origin)).length <= 64 * 1024;
}

/** Carries original identities through one native builder without using Generated as a continuation. */
export function composeSubShapeOrigins(context: SemanticStepContext,
  history: readonly SubShapeHistoryEntry[]): CurrentOriginIndex {
  if (context.featureId.length > 256 || context.inputs.some(input => input.sourceId.length > 256
    || (input.aliasOf?.length ?? 0) > 256)
    || new Set(context.inputs.map(input => input.sourceId)).size !== context.inputs.length) {
    return { version: 1, state: 'untracked', reason: 'limit' };
  }
  const historyBySource = new Map<string, SubShapeHistoryEntry>();
  for (const entry of history) {
    const addressKey = JSON.stringify([entry.sourceId, entry.input.kind, entry.input.index]);
    if (historyBySource.has(addressKey)) return { version: 1, state: 'untracked', reason: 'missing-native-map' };
    historyBySource.set(addressKey, entry);
  }
  interface Carried { origin: SubShapeOrigin; addresses: ShapeAddress[]; ambiguity: 'split' | 'merged' | null;
    coOrigins: SubShapeOrigin[]; source: string; terminal?: OriginBinding }
  const carried: Carried[] = [];
  type Region = NonNullable<Extract<CurrentOriginIndex, { state: 'tracked' }>['fingerprintFallback']>[number];
  const anonymousPaths: { source: string; input: ShapeAddress; addresses: ShapeAddress[]; reason: Region['reason'] }[] = [];
  let hasAnonymousBoundary = false;
  const carryRegion = (input: SemanticStepInput, region: Region): void => {
    const entry = historyBySource.get(JSON.stringify([input.sourceId, region.current.kind, region.current.index]));
    if (entry === undefined) {
      anonymousPaths.push({ source: input.aliasOf ?? input.sourceId, input: region.current,
        addresses: [], reason: region.reason });
      return;
    }
    const candidates = new Map<string, ShapeAddress>();
    for (const current of [...entry.modified, ...(entry.unchanged === null ? [] : [entry.unchanged])]) {
      if (current.kind === region.current.kind) candidates.set(key(current), current);
    }
    anonymousPaths.push({ source: input.aliasOf ?? input.sourceId, input: region.current,
      addresses: [...candidates.values()], reason: region.reason });
  };
  for (const input of context.inputs) {
    if (input.origins.state === 'untracked') {
      const reason = input.origins.reason;
      if (context.allowUntrackedRegions !== true
        || (reason !== 'imported' && reason !== 'legacy' && reason !== 'unsupported-producer')) return input.origins;
      hasAnonymousBoundary = true;
      for (const entry of history) if (entry.sourceId === input.sourceId) {
        carryRegion(input, { current: entry.input, reason });
      }
      continue;
    }
    if (input.origins.fingerprintFallback !== undefined) {
      hasAnonymousBoundary = true;
      for (const region of input.origins.fingerprintFallback) carryRegion(input, region);
    }
    for (const binding of input.origins.bindings) {
      if (!withinOriginLimits(binding.origin)) return { version: 1, state: 'untracked', reason: 'limit' };
      if (binding.state === 'untracked' || binding.state === 'missing') {
        carried.push({ origin: binding.origin, addresses: [], ambiguity: null,
          coOrigins: [], source: input.aliasOf ?? input.sourceId, terminal: binding });
        continue;
      }
      const old = binding.state === 'split' ? binding.candidates : [binding.current];
      const candidates = new Map<string, ShapeAddress>();
      let deleted = true, found = true;
      for (const current of old) {
        const entry = historyBySource.get(JSON.stringify([input.sourceId, current.kind, current.index]));
        if (entry === undefined) { found = false; continue; }
        deleted &&= entry.deleted;
        for (const address of [...entry.modified, ...(entry.unchanged === null ? [] : [entry.unchanged])]) {
          if (address.kind === current.kind) candidates.set(key(address), address);
        }
      }
      const addresses = [...candidates.values()];
      const terminal = !found ? missing(binding.origin, 'history-missing')
        : addresses.length === 0 ? missing(binding.origin, deleted ? 'deleted' : 'history-missing') : undefined;
      carried.push({ origin: binding.origin, addresses, source: input.aliasOf ?? input.sourceId,
        ambiguity: binding.state === 'split' ? 'split' : binding.state === 'merged' ? 'merged' : null,
        coOrigins: binding.state === 'merged' ? [...binding.coOrigins] : [], terminal });
    }
  }
  const consolidated = new Map<string, Carried>();
  for (const item of carried) {
    const aliasKey = JSON.stringify([item.source, same(item.origin)]);
    const prior = consolidated.get(aliasKey);
    if (prior === undefined) { consolidated.set(aliasKey, item); continue; }
    if (prior.terminal !== undefined || item.terminal !== undefined) {
      prior.terminal = { origin: item.origin, state: 'untracked', reason: 'missing-native-map' };
      prior.addresses = [];
      continue;
    }
    const addresses = new Map<string, ShapeAddress>();
    for (const value of prior.addresses) addresses.set(key(value), value);
    for (const value of item.addresses) addresses.set(key(value), value);
    prior.addresses = [...addresses.values()];
    if (prior.ambiguity === null) prior.ambiguity = item.ambiguity;
    if (prior.addresses.length > 1) prior.ambiguity = 'split';
    prior.coOrigins.push(...item.coOrigins);
  }
  const paths = [...consolidated.values()];
  const reverse = new Map<string, Carried[]>();
  for (const item of paths) for (const address of item.addresses) {
    const addressKey = key(address), owners = reverse.get(addressKey) ?? [];
    owners.push(item); reverse.set(addressKey, owners);
  }
  const bindings: OriginBinding[] = [];
  for (const item of paths) {
    if (item.terminal !== undefined) { bindings.push(item.terminal); continue; }
    if (item.addresses.length === 0) { bindings.push(missing(item.origin, 'history-missing')); continue; }
    const co = new Map<string, SubShapeOrigin>();
    for (const origin of item.coOrigins) co.set(same(origin), origin);
    for (const address of item.addresses) for (const other of reverse.get(key(address)) ?? []) {
      if (other === item || (other.source === item.source && same(other.origin) === same(item.origin))) continue;
      co.set(same(other.origin), other.origin);
    }
    if (item.ambiguity === 'split' || item.addresses.length > 1) {
      const candidates = item.addresses;
      // A previously ambiguous path cannot become a unique match after a later merge.
      if (candidates.length === 1) candidates.push(candidates[0]);
      bindings.push({ origin: item.origin, state: 'split',
        candidates: candidates as [ShapeAddress, ShapeAddress, ...ShapeAddress[]] });
    } else if (item.ambiguity === 'merged' || co.size > 0) {
      const allMap = new Map<string, SubShapeOrigin>([[same(item.origin), item.origin]]);
      for (const origin of co.values()) allMap.set(same(origin), origin);
      const all = [...allMap.values()];
      if (all.length < 2) return { version: 1, state: 'untracked', reason: 'missing-native-map' };
      if (all.length > 32 || all.some(origin => !withinOriginLimits(origin))) {
        return { version: 1, state: 'untracked', reason: 'limit' };
      }
      bindings.push({ origin: item.origin, state: 'merged', current: item.addresses[0],
        coOrigins: all as [SubShapeOrigin, SubShapeOrigin, ...SubShapeOrigin[]] });
    } else bindings.push({ origin: item.origin, state: 'unique', current: item.addresses[0] });
  }
  const occupied = new Set<string>();
  for (const item of paths) for (const current of item.addresses) occupied.add(key(current));
  // Consolidate aliases before considering any output. Every alias must prove the same
  // single continuation; a split, deletion, or conflicting alias cannot be erased by a later row.
  const anonymousSources = new Map<string, { path: typeof anonymousPaths[number];
    addresses: Map<string, ShapeAddress>; ambiguous: boolean }>();
  for (const path of anonymousPaths) {
    const sourceKey = JSON.stringify([path.source, path.input.kind, path.input.index]);
    let source = anonymousSources.get(sourceKey);
    if (source === undefined) {
      source = { path, addresses: new Map(), ambiguous: false };
      anonymousSources.set(sourceKey, source);
    }
    source.ambiguous ||= path.addresses.length !== 1;
    for (const current of path.addresses) source.addresses.set(key(current), current);
    source.ambiguous ||= source.addresses.size !== 1;
  }
  interface AnonymousClaim { path: typeof anonymousPaths[number]; current: ShapeAddress; ambiguous: boolean }
  const byOutput = new Map<string, Map<string, AnonymousClaim>>();
  for (const [sourceKey, source] of anonymousSources) for (const current of source.addresses.values()) {
    const destinations = byOutput.get(key(current)) ?? new Map<string, AnonymousClaim>();
    destinations.set(sourceKey, { path: source.path, current, ambiguous: source.ambiguous });
    byOutput.set(key(current), destinations);
  }
  const fingerprintFallback: Region[] = [];
  for (const [addressKey, producers] of byOutput) {
    const [proved] = producers.values();
    if (occupied.has(addressKey) || producers.size !== 1 || proved === undefined || proved.ambiguous) continue;
    fingerprintFallback.push({ current: proved.current, reason: proved.path.reason });
  }
  return { version: 1, state: 'tracked', bindings,
    ...(hasAnonymousBoundary ? { fingerprintFallback } : {}) };
}

export function lookupSubShapeOrigin(index: CurrentOriginIndex | undefined,
  origin: SubShapeOrigin): OriginLookup {
  if (index === undefined) return { status: 'missing', reason: 'origin-index-missing' };
  if (index.state === 'untracked') return { status: 'missing', reason: index.reason };
  if (!withinOriginLimits(origin)) return { status: 'missing', reason: 'limit' };
  const found = index.bindings.filter(binding => same(binding.origin) === same(origin));
  if (found.length !== 1) return { status: 'missing', reason: 'history-missing' };
  const binding = found[0];
  switch (binding.state) {
    case 'unique': return { status: 'matched', address: binding.current, basis: 'semantic' };
    case 'split': return { status: 'ambiguous', reason: 'split', candidates: binding.candidates };
    case 'merged': return { status: 'ambiguous', reason: 'merged', candidates: [binding.current] };
    case 'missing': return { status: 'missing', reason: binding.reason };
    case 'untracked': return { status: 'missing', reason: binding.reason };
  }
}
