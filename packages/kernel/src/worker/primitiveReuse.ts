/** 同一再計算内で、位置だけ異なる基本形状の検証済み幾何と三角形を複製する。 */
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import type { SolidStepSpec, Vec3Tuple } from '../types.js';
import { createAllocations } from '../occt/allocations.js';
import type { BooleanResult } from '../occt/booleanOp.js';
import { IDENTITY_TRANSFORM, makeTransform } from '../occt/transformShape.js';
import type { CachedSolid } from './recomputeSolids.js';
import type { ShapeCache } from './shapeCache.js';
import type { KnownTriangulation } from '../occt/triangulationReuse.js';

interface PrimitiveCopy extends BooleanResult { readonly triangulation?: KnownTriangulation }

function signature(spec: SolidStepSpec): { key: string; origin: Vec3Tuple } | null {
  if (spec.kind !== 'primitive' || spec.originQuery !== null || spec.targetKey !== null || !spec.origin.every(Number.isFinite)) return null;
  // 大きい寸法も移動前後の丸めを拡大するため、通常構築へ戻す。入力自体は制限しない。
  const extent = Object.values(spec.shape).reduce<number>((sum, value) => sum + (typeof value === 'number' ? Math.abs(value) : 0), 0);
  if (!Number.isFinite(extent) || 8 * Number.EPSILON * extent > 1e-9) return null;
  try {
    const key = JSON.stringify({ ...spec, origin: [0, 0, 0] }, (_key: string, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('非有限入力');
      return value;
    });
    return { key, origin: spec.origin };
  } catch { return null; }
}

export function createPrimitiveReuse(oc: OpenCascadeInstance, cache: ShapeCache<CachedSolid>) {
  // 形状の所有権は増やさない。追い出された候補や別の再計算では通常構築へ戻る。
  const prototypes = new Map<string, { key: string; origin: Vec3Tuple }>();
  return {
    remember(spec: SolidStepSpec, key: string): void {
      const local = signature(spec);
      if (local === null) return;
      const previous = prototypes.get(local.key);
      // 複製を次の複製元へ重ねず、最初の実形状を使って座標の丸めを累積させない。
      if (previous === undefined || !cache.has(previous.key)) prototypes.set(local.key, { key, origin: local.origin });
    },
    copy(spec: SolidStepSpec): PrimitiveCopy | null {
      const local = signature(spec);
      if (local === null) return null;
      const prototype = prototypes.get(local.key);
      if (prototype === undefined) return null;
      const delta: Vec3Tuple = [local.origin[0] - prototype.origin[0], local.origin[1] - prototype.origin[1], local.origin[2] - prototype.origin[2]];
      // 大座標や非可逆な差では通常構築へ戻す。座標や入力を丸めて一致させない。
      if (delta.some((value, i) => !Number.isFinite(value) || value + prototype.origin[i] !== local.origin[i]
        || 8 * Number.EPSILON * Math.max(Math.abs(value), Math.abs(local.origin[i]), Math.abs(prototype.origin[i])) > 1e-9)) return null;
      const source = cache.get(prototype.key);
      if (source === undefined) return null;
      const owned = createAllocations();
      try {
        // 幾何も三角形も独立した複製にする。位置だけをこの複製へ与える。
        const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(source.shape, true, true));
        if (!copier.IsDone()) throw new Error('基本形状を複製できませんでした。');
        const copied = owned.keep(copier.Shape());
        const transform = makeTransform(oc, { ...IDENTITY_TRANSFORM, translation: delta }, owned.keep);
        const location = owned.keep(new oc.TopLoc_Location_2(transform));
        const moved = owned.keep(copied.Moved(location, true));
        return { shape: moved, volume: source.mesh.volume, triangulation: source.triangulation, delete: owned.release };
      } catch (error) { owned.release(); throw error; }
    },
  };
}
