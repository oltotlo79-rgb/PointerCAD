import { countSolidShapes } from './solidTopology.js';
/** 板金の部材をつなぐ共通の形状契約。借用元を破壊せず1ソリッドへ結合する。 */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { booleanOp } from './booleanOp.js';
import type { OcctShapeHandle } from './makeBox.js';
import { measureVolume } from './solidMesh.js';
import { createAllocations } from './allocations.js';
import { unifySheetFlat } from './unifySheetFlat.js';

export function countSheetMetalSolids(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  return countSolidShapes(oc, shape);
}

export function joinSheetMetalShapes(oc: OpenCascadeInstance, target: TopoDS_Shape, tool: TopoDS_Shape, context: 'flange' | 'flat' = 'flange'): OcctShapeHandle {
  if (countSheetMetalSolids(oc, target) !== 1 || countSheetMetalSolids(oc, tool) !== 1) throw new Error(context === 'flat'
    ? '展開のパネルが1つの立体になっていません。輪郭を確認してください。' : 'フランジは1つの板金ボディの縁から作成してください。');
  const totalVolume = measureVolume(oc, target) + measureVolume(oc, tool);
  const { keep, release } = createAllocations();
  try {
    const joined = keep(booleanOp(oc, 'union', target, tool));
    if (countSheetMetalSolids(oc, joined.shape) !== 1) throw new Error(context === 'flat'
      ? '展開のパネルが接続していません。固定面・曲げ・継ぎ目を確認してください。' : 'フランジが元の板に接続していません。基板の縁を選び直してください。');
    if (!Number.isFinite(totalVolume) || Math.abs(joined.volume - totalVolume) > Math.max(1e-7, totalVolume * 1e-10))
      throw new Error(context === 'flat' ? '展開したパネルが重なっています。曲げの位置・長さ・継ぎ目を変更してください。'
        : 'フランジが既存の板に食い込んでいます。角度・長さ・端の位置を変更してください。');
    const result = context === 'flat' ? keep(unifySheetFlat(oc, joined.shape, totalVolume)) : joined;
    return { shape: result.shape, delete: release };
  } catch (error) { release(); throw error; }
}
