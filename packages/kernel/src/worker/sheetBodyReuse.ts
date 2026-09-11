/** 同一再計算内の平行移動だけ異なる板金を、検証済みB-repから複製する。 */
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec, SolidStepSpec, Vec3Tuple } from '../types.js';
import { transformShape, IDENTITY_TRANSFORM } from '../occt/transformShape.js';
import type { BooleanResult } from '../occt/booleanOp.js';
import type { CachedSolid } from './recomputeSolids.js';
import type { ShapeCache } from './shapeCache.js';

interface LocalSheet { readonly key: string; readonly origin: Vec3Tuple }
interface KnownSheet extends LocalSheet { readonly identity: number }
function curveAnchor(curve: CurveSpec): Vec3Tuple | undefined {
  switch (curve.kind) {
    case 'segment': return curve.from;
    case 'arc': case 'ellipse': return curve.center;
    case 'spline': return curve.points[0];
  }
}

/** 量子化・許容差による一致判定をしない。全入力の相対座標が同じ場合だけ候補にする。 */
function localSheet(spec: SolidStepSpec, known: ReadonlyMap<string, KnownSheet>): LocalSheet | null {
  if (spec.kind !== 'sheetBase' && spec.kind !== 'sheetFlange' && spec.kind !== 'sheetBody') return null;
  const parent = spec.kind === 'sheetFlange' ? known.get(spec.targetKey) : undefined;
  const first = spec.kind === 'sheetBase' ? spec.outer[0] : spec.kind === 'sheetBody' ? spec.panels[0]?.outer[0] : undefined;
  const origin = parent?.origin ?? (first === undefined ? undefined : curveAnchor(first));
  if (origin === undefined || !origin.every(Number.isFinite)) return null;
  const shift = (point: Vec3Tuple): Vec3Tuple => {
    const result: Vec3Tuple = [point[0]-origin[0], point[1]-origin[1], point[2]-origin[2]];
    if (result.some((value, i) => !Number.isFinite(value) || value + origin[i] !== point[i])) throw new Error('非可逆な相対座標');
    return result;
  };
  const move = (curve: CurveSpec): CurveSpec => {
    switch (curve.kind) {
      case 'segment': return { ...curve, from: shift(curve.from), to: shift(curve.to) };
      case 'arc': case 'ellipse': return { ...curve, center: shift(curve.center) };
      case 'spline': return { ...curve, points: curve.points.map(shift) };
    }
  };
  try {
    const normalized = spec.kind === 'sheetBase' ? { ...spec, outer: spec.outer.map(move), holes: spec.holes.map((loop) => loop.map(move)) }
      : spec.kind === 'sheetFlange' ? { ...spec, targetKey: parent?.identity,
        flanges: spec.flanges.map((flange) => ({ ...flange, frame: { ...flange.frame, origin: shift(flange.frame.origin) },
          ...(flange.kind === 'profile' ? { outer: flange.outer.map(move), holes: flange.holes.map((loop) => loop.map(move)) } : {}) })) }
      : { ...spec,
      panels: spec.panels.map((panel) => ({ ...panel, outer: panel.outer.map(move), holes: panel.holes.map((loop) => loop.map(move)) })),
      // 曲げのflatProfileは初めから局所座標。移すのはワールド座標の接線原点だけ。
      bends: spec.bends.map((bend) => ({ ...bend, frame: { ...bend.frame, origin: shift(bend.frame.origin) } })),
    };
    const key = JSON.stringify(normalized, (_key: string, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('非有限入力');
      return value;
    });
    return { key, origin };
  } catch { return null; }
}

export function createSheetBodyReuse(oc: OpenCascadeInstance, cache: ShapeCache<CachedSolid>) {
  // B-repは保持しない。LRUから消えたら通常の構築へ戻り、別の所有者を増やさない。
  const prototypes = new Map<string, { readonly key: string; readonly origin: Vec3Tuple }>();
  const known = new Map<string, KnownSheet>(), identities = new Map<string, number>();
  return {
    remember(spec: SolidStepSpec, key: string): void {
      const local = localSheet(spec, known); if (local === null) return;
      const identity = identities.get(local.key) ?? identities.size;
      identities.set(local.key, identity); known.set(key, { ...local, identity });
      prototypes.set(local.key, { key, origin: local.origin });
    },
    copy(spec: SolidStepSpec): BooleanResult | null {
      const local = localSheet(spec, known); if (local === null) return null;
      const prototype = prototypes.get(local.key); if (prototype === undefined) return null;
      const cached = cache.get(prototype.key); if (cached === undefined) return null;
      const translation: Vec3Tuple = [local.origin[0]-prototype.origin[0], local.origin[1]-prototype.origin[1], local.origin[2]-prototype.origin[2]];
      if (!translation.every(Number.isFinite)) return null;
      const copy = transformShape(oc, cached.shape, { ...IDENTITY_TRANSFORM, translation });
      return { shape: copy.shape, volume: cached.mesh.volume, delete: () => copy.delete() };
    },
  };
}
