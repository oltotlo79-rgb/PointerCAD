import type { MathGeometryCurve, MathGeometryFace, MathGeometryPoint, MathGeometryQuantity, MathGeometryShape } from '@pointercad/model';
import type { RepairMapper } from './referenceRepairGeometry.js';

export function repairMath(quantity: MathGeometryQuantity, map: RepairMapper): MathGeometryQuantity {
  const point = (value: MathGeometryPoint, field: string): MathGeometryPoint => {
    if (value.kind !== 'vertex') return value;
    const ref = map(value.reference, field);
    return ref.fingerprint.kind === 'vertex' ? { ...value, reference: { ...ref, fingerprint: ref.fingerprint } } : value;
  };
  const curve = (value: MathGeometryCurve, field: string): MathGeometryCurve => {
    if (value.kind !== 'edge') return value;
    const ref = map(value.reference, field);
    return ref.fingerprint.kind === 'edge' ? { ...value, reference: { ...ref, fingerprint: ref.fingerprint } } : value;
  };
  const face = (value: MathGeometryFace, field: string): MathGeometryFace => {
    const ref = map(value.reference, field);
    return ref.fingerprint.kind === 'face' ? { ...value, reference: { ...ref, fingerprint: ref.fingerprint } } : value;
  };
  const shape = (value: MathGeometryShape, field: string): MathGeometryShape => {
    switch (value.kind) {
      case 'body': return value;
      case 'face': return face(value, field);
      case 'edge': { const ref = map(value.reference, field); return ref.fingerprint.kind === 'edge'
        ? { ...value, reference: { ...ref, fingerprint: ref.fingerprint } } : value; }
      case 'vertex': { const ref = map(value.reference, field); return ref.fingerprint.kind === 'vertex'
        ? { ...value, reference: { ...ref, fingerprint: ref.fingerprint } } : value; }
    }
  };
  const direction = (value: MathGeometryCurve | MathGeometryFace, field: string): typeof value => value.kind === 'face'
    ? face(value, field) : curve(value, field);
  switch (quantity.kind) {
    case 'coordinate': return { ...quantity, point: point(quantity.point, 'point') };
    case 'point-distance': return { ...quantity, first: point(quantity.first, 'first'), second: point(quantity.second, 'second') };
    case 'point-angle': return { ...quantity, first: point(quantity.first, 'first'), second: point(quantity.second, 'second'), third: point(quantity.third, 'third') };
    case 'shape-distance': return { ...quantity, first: shape(quantity.first, 'first'), second: shape(quantity.second, 'second') };
    case 'length': case 'radius': case 'central-angle': return { ...quantity, curve: curve(quantity.curve, 'curve') };
    case 'area': return { ...quantity, shape: quantity.shape.kind === 'face' ? face(quantity.shape, 'shape') : quantity.shape };
    case 'plane-angle': return { ...quantity, first: face(quantity.first, 'first'), second: face(quantity.second, 'second') };
    case 'line-plane-angle': return { ...quantity, line: curve(quantity.line, 'line'), plane: face(quantity.plane, 'plane') };
    case 'parallel': case 'perpendicular': return { ...quantity, first: direction(quantity.first, 'first'), second: direction(quantity.second, 'second') };
    case 'angle': case 'congruent': case 'similar': return { ...quantity, first: curve(quantity.first, 'first'), second: curve(quantity.second, 'second') };
    case 'volume': case 'contour-length': return quantity;
  }
}
