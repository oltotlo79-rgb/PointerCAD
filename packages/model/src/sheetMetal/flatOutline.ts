/** 結合後の展開立体を中厚面で切り、製作用の外周と穴だけを取り出す。 */
import type { KernelBridge } from '../kernelBridge.js';
import { curveStart } from '../sketch/intersectionMath.js';
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { sheetLoopContains } from './groupClippedPanels.js';
import { orientSheetLoop, type SheetGeometryResult } from './panelGeometry.js';
import { collectSheetCurveLoops, type SheetClippedLoop } from './sheetCurveLoops.js';

export interface SheetFlatOutline {
  readonly loops: readonly SheetClippedLoop[];
  readonly toleranceMm: number;
}
/** 出力許容差0.01mmに対し、曲線標本には0.001mmを割り当てる。 */
export const SHEET_OUTLINE_TOLERANCE_MM = 0.001;
const normal: Vec3 = [0, 0, 1];

export function classifySheetOutline(curves: readonly ResolvedCurve[]): SheetGeometryResult<readonly SheetClippedLoop[]> {
  const collected = collectSheetCurveLoops(curves, normal); if (!collected.ok) return collected;
  if (collected.value.length === 0) return { ok: false, message: '展開形状に閉じた切断輪郭がありません。' };
  const loops: SheetClippedLoop[] = [];
  for (const [i, loop] of collected.value.entries()) {
    let depth = 0;
    const point = curveStart(loop.curves[0]);
    for (const [j, container] of collected.value.entries()) {
      if (i === j) continue;
      const inside = sheetLoopContains(container.curves, point, [1, 0, 0], [0, 1, 0]);
      if (!inside.ok) return inside;
      if (inside.value) depth++;
    }
    // OCCT断面の向きは分類根拠にしない。入れ子の深さで穴を決めてから向きをそろえる。
    const kind = depth % 2 === 0 ? 'outer' : 'hole';
    const oriented = orientSheetLoop(loop.curves, normal, kind === 'hole');
    if (oriented === null) return { ok: false, message: '展開輪郭の向きをそろえられませんでした。' };
    loops.push({ kind, curves: oriented });
  }
  return { ok: true, value: loops };
}

export async function resolveSheetFlatOutline(bridge: Pick<KernelBridge, 'sectionSketchCurves'>,
  bodyKey: string, thickness: number, shouldCancel: () => boolean = () => false): Promise<SheetGeometryResult<SheetFlatOutline>> {
  if (shouldCancel()) return { ok: false, message: '展開輪郭の書き出しを中止しました。' };
  if (!Number.isFinite(thickness) || thickness <= 0) return { ok: false, message: '展開輪郭の板厚が不正です。' };
  const result = await bridge.sectionSketchCurves([{ featureId: 'sheet-cut-outline', bodyKey, source: null,
    curveToleranceMm: SHEET_OUTLINE_TOLERANCE_MM,
    plane: { id: 'sheet-cut-plane', origin: [0, 0, thickness / 2], normal, axisU: [1, 0, 0], axisV: [0, 1, 0] } }]);
  if (shouldCancel()) return { ok: false, message: '展開輪郭の書き出しを中止しました。' };
  if (result.failures.length > 0) return { ok: false, message: result.failures[0].message };
  const curves: ResolvedCurve[] = [];
  for (const curve of result.results[0]?.curves ?? []) {
    // 精密断面の橋は直線・円弧だけを返す。補間や二度目の標本化を許さない。
    if (curve.kind === 'segment') curves.push({ ...curve, from: [curve.from[0], curve.from[1], 0], to: [curve.to[0], curve.to[1], 0] });
    else if (curve.kind === 'arc') curves.push({ ...curve, center: [curve.center[0], curve.center[1], 0] });
    else return { ok: false, message: '展開輪郭の精密な線分・円弧が得られませんでした。' };
  }
  const loops = classifySheetOutline(curves);
  return loops.ok ? { ok: true, value: { loops: loops.value, toleranceMm: SHEET_OUTLINE_TOLERANCE_MM } } : loops;
}
