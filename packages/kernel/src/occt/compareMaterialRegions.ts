import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { DEFAULT_LINEAR_DEFLECTION } from '../types.js';
import { createAllocations } from './allocations.js';
import { buildBooleanShape } from './buildBooleanShape.js';
import { buildExportMesh, type ExportMesh } from './exportMesh.js';
import { OPEN_FACES_NOT_SUPPORTED, shapeBodyKind } from './shapeBodyKind.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';

export type MaterialRegion =
  | { readonly kind: 'empty'; readonly volume: 0; readonly mesh: null }
  | { readonly kind: 'material'; readonly volume: number; readonly mesh: ExportMesh };
export interface MaterialComparison {
  readonly added: MaterialRegion;
  readonly removed: MaterialRegion;
  readonly common: MaterialRegion;
  readonly beforeVolume: number;
  readonly afterVolume: number;
}
export type MaterialComparisonPhase = 'prepare' | 'removed' | 'added' | 'common';
export interface MaterialComparisonOptions {
  readonly shouldCancel?: () => boolean;
  readonly onPhase?: (phase: MaterialComparisonPhase) => void;
}
export class MaterialComparisonCancelled extends Error {
  constructor() { super('形の比較を中止しました。'); this.name = 'MaterialComparisonCancelled'; }
}
const empty = (): MaterialRegion => ({ kind: 'empty', volume: 0, mesh: null });
const INVALID_RESULT = '形の差を正しく計算できませんでした。';

function inputVolume(oc: OpenCascadeInstance, shape: TopoDS_Shape | null): number {
  if (shape === null) return 0;
  if (shape.IsNull()) throw new Error('比較する形を取得できませんでした。');
  if (shapeBodyKind(oc, shape) !== 'solid') throw new Error(OPEN_FACES_NOT_SUPPORTED);
  if (!isValidShape(oc, shape)) throw new Error('比較する立体の形が正しくありません。');
  const volume = measureVolume(oc, shape);
  if (!Number.isFinite(volume) || volume <= 0) throw new Error('比較する立体の体積を測れませんでした。');
  return volume;
}

/** 入力は借用する。三角形は既存の複製経路で作り、入力形状の表示を変更しない。 */
export function compareMaterialRegions(
  oc: OpenCascadeInstance, before: TopoDS_Shape | null, after: TopoDS_Shape | null,
  options: MaterialComparisonOptions = {},
): MaterialComparison {
  let triangles = 0;
  const checkpoint = (): void => { if (options.shouldCancel?.()) throw new MaterialComparisonCancelled(); };
  const phase = (value: MaterialComparisonPhase): void => { checkpoint(); options.onPhase?.(value); checkpoint(); };
  phase('prepare');
  const beforeVolume = inputVolume(oc, before), afterVolume = inputVolume(oc, after);
  function material(shape: TopoDS_Shape, volume: number): MaterialRegion {
    checkpoint();
    const mesh = buildExportMesh(oc, shape, DEFAULT_LINEAR_DEFLECTION);
    checkpoint(); triangles += mesh.triangleCount;
    if (triangles > 2_000_000) throw new Error('比較する形が大きすぎます。部品を分けて比較してください。');
    return { kind: 'material', volume, mesh };
  }
  function region(operation: 'subtract' | 'intersect', target: TopoDS_Shape | null,
    tool: TopoDS_Shape | null, targetVolume: number): MaterialRegion {
    checkpoint();
    if (target === null || (operation === 'intersect' && tool === null)) return empty();
    if (tool === null) return material(target, targetVolume);
    const allocations = createAllocations();
    try {
      const range = allocations.keep(new oc.Message_ProgressRange_1());
      const shape = buildBooleanShape(oc, operation, target, [tool], range, allocations);
      checkpoint();
      // 正常な空結果は非nullの空COMPOUND。演算失敗を「変更なし」へ読み替えない。
      if (shape.IsNull() || !isValidShape(oc, shape)) throw new Error(INVALID_RESULT);
      if (!hasSolid(oc, shape)) return empty();
      if (shapeBodyKind(oc, shape) !== 'solid') throw new Error(INVALID_RESULT);
      const volume = measureVolume(oc, shape);
      // 微小でも正の材料は残す。干渉判定用のしきい値を流用して消さない。
      if (!Number.isFinite(volume) || volume <= 0) throw new Error(INVALID_RESULT);
      return material(shape, volume);
    } finally { allocations.release(); }
  }
  phase('removed'); const removed = region('subtract', before, after, beforeVolume);
  phase('added'); const added = region('subtract', after, before, afterVolume);
  phase('common'); const common = region('intersect', before, after, beforeVolume);
  checkpoint();
  // 各演算の取りこぼしを同じ立体の総体積と突き合わせる。途中結果は返さない。
  const conserves = (whole: number, parts: number): boolean =>
    Math.abs(whole - parts) <= Math.max(1e-9, Math.abs(whole) * 1e-6);
  if (!conserves(beforeVolume, removed.volume + common.volume)
    || !conserves(afterVolume, added.volume + common.volume)) throw new Error(INVALID_RESULT);
  return { added, removed, common, beforeVolume, afterVolume };
}
