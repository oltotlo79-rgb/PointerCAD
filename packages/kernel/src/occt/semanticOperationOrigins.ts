import type { CurrentOriginIndex, OriginBinding, ShapeAddress } from '../subShapeOrigin.js';
import { composeSubShapeOrigins, withinOriginLimits, type SemanticStepInput } from './composeSubShapeOrigins.js';
import type { SubShapeHistoryEntry } from './subShapeHistory.js';

const untracked = (reason: 'missing-native-map' | 'unsupported-operation' | 'limit'): CurrentOriginIndex =>
  ({ version: 1, state: 'untracked', reason });
const addressKey = (address: ShapeAddress): string => `${address.kind}:${address.index}`;

/** Builder history carries old identities. Only a selected, unique native edge may name a new blend face. */
export function semanticOperationOrigins(
  featureId: string,
  inputs: readonly SemanticStepInput[],
  history: readonly SubShapeHistoryEntry[],
  blend?: { readonly operation: 'fillet' | 'chamfer'; readonly selectedEdgeIndices: readonly number[] },
  options?: { readonly allowUntrackedRegions?: boolean },
): CurrentOriginIndex {
  if (inputs.length === 0 || (options?.allowUntrackedRegions !== true && inputs.some((input) => input.origins.state === 'untracked'))) {
    return untracked('unsupported-operation');
  }
  const inherited = composeSubShapeOrigins({ featureId, inputs, allowUntrackedRegions: options?.allowUntrackedRegions }, history);
  if (inherited.state !== 'tracked' || blend === undefined) return inherited;
  const primary = inputs[0];
  if (primary.origins.state !== 'tracked') return inherited;
  type Region = NonNullable<typeof inherited.fingerprintFallback>[number];
  const occupied = new Set<string>();
  for (const binding of inherited.bindings) {
    if (binding.state === 'unique' || binding.state === 'merged') occupied.add(addressKey(binding.current));
    if (binding.state === 'split') for (const address of binding.candidates) occupied.add(addressKey(address));
  }
  const claims: { faces: ShapeAddress[]; binding?: OriginBinding; reason?: Region['reason'] }[] = [];
  const claimCounts = new Map<string, number>();
  for (const index of new Set(blend.selectedEdgeIndices)) {
    const entry = history.find((item) => item.sourceId === primary.sourceId
      && item.input.kind === 'edge' && item.input.index === index);
    const faceMap = new Map<string, ShapeAddress>();
    for (const current of entry?.generated ?? []) if (current.kind === 'face') faceMap.set(addressKey(current), current);
    const faces = [...faceMap.values()];
    for (const current of faces) claimCounts.set(addressKey(current), (claimCounts.get(addressKey(current)) ?? 0) + 1);
    // Every selected edge's actual Generated claims count, including unnamed or
    // ambiguous sources. A later valid source cannot launder a shared new face.
    const sourceClaims = primary.origins.bindings.filter(binding =>
      (binding.state === 'unique' || binding.state === 'merged')
        ? binding.current.kind === 'edge' && binding.current.index === index
        : binding.state === 'split' && binding.candidates.some(current => current.kind === 'edge' && current.index === index));
    const [source] = sourceClaims;
    if (sourceClaims.length === 1 && source?.state === 'unique' && source.origin.shapeKind === 'edge') {
      const origin = { version: 1 as const, shapeKind: 'face' as const,
        identity: { kind: 'blend-face' as const, featureId, operation: blend.operation, source: source.origin.identity } };
      if (!withinOriginLimits(origin)) return untracked('limit');
      const [first, second, ...rest] = faces;
      const binding: OriginBinding = first === undefined ? { origin, state: 'missing', reason: 'history-missing' }
        : second === undefined ? { origin, state: 'unique', current: first }
          : { origin, state: 'split', candidates: [first, second, ...rest] };
      claims.push({ faces, binding });
    } else {
      const regions = primary.origins.fingerprintFallback?.filter(region =>
        region.current.kind === 'edge' && region.current.index === index) ?? [];
      claims.push({ faces, ...(sourceClaims.length === 0 && regions.length === 1
        ? { reason: regions[0].reason } : {}) });
    }
  }
  const added: OriginBinding[] = [];
  const fingerprintFallback: Region[] = [...(inherited.fingerprintFallback ?? [])].filter(region =>
    !claimCounts.has(addressKey(region.current)));
  for (const claim of claims) {
    const conflict = claim.faces.some(current => occupied.has(addressKey(current))
      || (claimCounts.get(addressKey(current)) ?? 0) !== 1);
    if (claim.binding !== undefined) {
      added.push(conflict ? { origin: claim.binding.origin, state: 'untracked', reason: 'missing-native-map' } : claim.binding);
    } else if (!conflict && claim.reason !== undefined && claim.faces.length === 1) {
      fingerprintFallback.push({ current: claim.faces[0], reason: claim.reason });
    }
  }
  return { ...inherited, bindings: [...inherited.bindings, ...added],
    ...(inherited.fingerprintFallback !== undefined || claims.some(claim => claim.reason !== undefined)
      ? { fingerprintFallback } : {}) };
}
