/** Capture a saved reference from one current body, never from its old fingerprint. */
import type { SubShapeRef, SubShapeKind } from '../geometry/subShapeRef.js';
import type { OriginLookup, ShapeAddress, SubShapeOrigin } from '../geometry/subShapeOrigin.js';
import type { SolidBody } from './solidContracts.js';

const sameAddress = (left: ShapeAddress, right: ShapeAddress): boolean =>
  left.kind === right.kind && left.index === right.index;

function semanticKey(origin: SubShapeOrigin): string {
  return JSON.stringify(origin, (_key: string, value: unknown): unknown => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = record[key];
    return sorted;
  });
}

/** A saved origin is resolved only against this body's current proof table. */
export function resolveCurrentOrigin(body: SolidBody, reference: SubShapeRef): OriginLookup {
  if (body.featureId !== reference.bodyFeatureId || !body.isValid || reference.origin === undefined) {
    return { status: 'missing', reason: 'origin-index-missing' };
  }
  if (reference.origin.shapeKind !== reference.fingerprint.kind) {
    return { status: 'missing', reason: 'origin-index-missing' };
  }
  const origins = body.origins;
  if (origins === undefined) return { status: 'missing', reason: 'origin-index-missing' };
  if (origins.state === 'untracked') return { status: 'missing', reason: origins.reason };
  const key = semanticKey(reference.origin);
  const matches = origins.bindings.filter(binding => semanticKey(binding.origin) === key);
  if (matches.length !== 1) return { status: 'missing', reason: 'history-missing' };
  const binding = matches[0];
  switch (binding.state) {
    case 'unique': return { status: 'matched', address: binding.current, basis: 'semantic' };
    case 'split': return { status: 'ambiguous', reason: 'split', candidates: binding.candidates };
    case 'merged': return { status: 'ambiguous', reason: 'merged', candidates: [binding.current] };
    case 'missing': return { status: 'missing', reason: binding.reason };
    case 'untracked': return { status: 'missing', reason: binding.reason };
  }
}

export function createSubShapeReference(body: SolidBody, kind: SubShapeKind, index: number): SubShapeRef | null {
  if (!body.isValid || body.featureId.length === 0 || !Number.isSafeInteger(index) || index < 0) return null;
  const address: ShapeAddress = { kind, index };
  const origins = body.origins;
  if (origins?.state !== 'tracked') return null;
  // A merged or multiply claimed address must not be given one arbitrary saved identity.
  const claims = origins.bindings.filter(binding => {
    switch (binding.state) {
      case 'unique': return sameAddress(binding.current, address);
      case 'merged': return sameAddress(binding.current, address);
      case 'split': return binding.candidates.some(candidate => sameAddress(candidate, address));
      case 'missing':
      case 'untracked': return false;
    }
  });
  if (claims.length !== 1 || claims[0].state !== 'unique' || claims[0].origin.shapeKind !== kind) return null;
  const origin = claims[0].origin;
  // The same identity on two bindings (e.g. a non-consuming mirror joined with its original) can never resolve:
  // resolveCurrentOrigin requires exactly one match. Do not save such a reference.
  const key = semanticKey(origin);
  if (origins.bindings.filter(binding => semanticKey(binding.origin) === key).length !== 1) return null;
  switch (kind) {
    case 'face': {
      const found = body.faces.filter(face => face.index === index);
      if (found.length !== 1) return null;
      const face = found[0];
      return { bodyFeatureId: body.featureId, index, origin, fingerprint: {
        kind: 'face', surfaceKind: face.surfaceKind, area: face.area,
        position: face.centroid, axis: face.axis, radius: face.radius,
      } };
    }
    case 'edge': {
      const found = body.edges.filter(edge => edge.index === index);
      if (found.length !== 1) return null;
      const edge = found[0];
      return { bodyFeatureId: body.featureId, index, origin, fingerprint: {
        kind: 'edge', curveKind: edge.curveKind, length: edge.length,
        position: edge.midpoint, axis: edge.axis, radius: edge.radius,
      } };
    }
    case 'vertex': {
      const found = body.vertices.filter(vertex => vertex.index === index);
      if (found.length !== 1) return null;
      const vertex = found[0];
      return { bodyFeatureId: body.featureId, index, origin, fingerprint: {
        kind: 'vertex', position: vertex.position,
      } };
    }
  }
}
