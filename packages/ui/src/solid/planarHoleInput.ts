import type { SolidFaceEntry, SubShapeRef } from '@pointercad/model';

export type PlanarHoleBasis = NonNullable<SolidFaceEntry['planarBasis']>;
interface BasisBody {
  readonly featureId: string;
  readonly isValid?: boolean;
  readonly faces: readonly Pick<SolidFaceEntry, 'index' | 'surfaceKind' | 'planarBasis'>[];
}

/** nativeが導いた基準を検証する。world軸の平面を捏造しない。 */
export function validPlanarHoleBasis(basis: PlanarHoleBasis | undefined): basis is PlanarHoleBasis {
  if (basis === undefined) return false;
  const { origin, xAxis: u, yAxis: v, normal: n } = basis;
  if (![...origin, ...u, ...v, ...n].every(Number.isFinite)
    || [u, v, n].some(axis => Math.abs(Math.hypot(...axis) - 1) > 1e-9)) return false;
  const cross = [
    n[1] * u[2] - n[2] * u[1],
    n[2] * u[0] - n[0] * u[2],
    n[0] * u[1] - n[1] * u[0],
  ];
  return Math.abs(n[0] * u[0] + n[1] * u[1] + n[2] * u[2]) <= 1e-9
    && cross.every((component, index) => Math.abs(component - v[index]) <= 1e-9);
}

/** 加工callerが同じ現body一覧から解決した面参照の基準だけを読む。 */
export function planarBasisForReference(bodies: readonly BasisBody[], ref: SubShapeRef): PlanarHoleBasis | null {
  if (ref.fingerprint.kind !== 'face' || ref.fingerprint.surfaceKind !== 'plane') return null;
  const candidates = bodies.filter(row => row.featureId === ref.bodyFeatureId);
  const body = candidates.length === 1 ? candidates[0] : undefined;
  const faces = body?.faces.filter(row => row.index === ref.index) ?? [];
  const face = faces.length === 1 ? faces[0] : undefined;
  return body?.isValid === true && face?.surfaceKind === 'plane' && validPlanarHoleBasis(face.planarBasis)
    ? face.planarBasis : null;
}
