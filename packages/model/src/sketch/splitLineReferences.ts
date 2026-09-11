import { constraintTargets } from './constraints/types.js';
import { mapSketchCoordinates } from './mapCoordinates.js';
import type { CoordinateInput, SketchDocument, SketchElementRef, SketchFeature } from './types.js';

export interface SplitLineIdentity {
  readonly startPointId: string;
  readonly pieceIds: readonly string[];
}

/** Curve constraints describe the original complete curve; never silently shorten their target. */
export function hasSplitLineConstraint(document: SketchDocument, ids: ReadonlySet<string>): boolean {
  return (document.constraints ?? []).some((constraint) => constraintTargets(constraint).some((target) =>
    target.kind === 'point' ? ids.has(target.pointId.split(':')[0])
      : target.kind === 'vertex' ? ids.has(target.featureId) : ids.has(target.element.featureId)));
}

export function remapSplitCoordinate(
  input: CoordinateInput, split: ReadonlyMap<string, SplitLineIdentity>,
): CoordinateInput {
  if (input.mode === 'absolute' || input.base.kind !== 'vertex' || input.base.vertex !== 'start') return input;
  const identity = split.get(input.base.featureId);
  return identity === undefined ? input : { ...input, base: { kind: 'point', pointId: identity.startPointId } };
}

function remapElements(refs: readonly SketchElementRef[], split: ReadonlyMap<string, SplitLineIdentity>): readonly SketchElementRef[] {
  return refs.flatMap((ref) => {
    const identity = split.get(ref.featureId);
    return identity === undefined || (ref.index !== undefined && ref.index !== 0)
      ? [ref] : identity.pieceIds.map((featureId) => ({ featureId }));
  });
}

/** Last piece retains the original id and end. Boundaries retain the entire original path. */
export function remapSplitFeature(feature: SketchFeature, split: ReadonlyMap<string, SplitLineIdentity>): SketchFeature {
  const mapped = mapSketchCoordinates(feature, (input) => remapSplitCoordinate(input, split));
  if (mapped.kind === 'face') return { ...mapped, boundary: remapElements(mapped.boundary, split) };
  if (mapped.kind === 'offset') return { ...mapped, source: remapElements(mapped.source, split) };
  if (mapped.kind === 'copy') return { ...mapped, source: remapElements(mapped.source, split) };
  return mapped;
}
