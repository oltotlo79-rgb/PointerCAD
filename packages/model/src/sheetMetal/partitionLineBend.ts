/** 指定線を中立曲げ帯の中心とし、固定面・円筒帯・動く面を同じ輪郭から導出する。 */
import { curveStart } from '../sketch/intersectionMath.js';
import type { ResolvedSegment } from '../sketch/types.js';
import { addVec3, crossVec3, dotVec3, lengthVec3, normalizeVec3, scaleVec3, subVec3 } from '../sketch/vec3.js';
import { sheetBendMetrics, type SheetBendInput, type SheetBendMetrics } from './bendAllowance.js';
import { clipSheetPanel } from './clipSheetPanel.js';
import { groupClippedPanels } from './groupClippedPanels.js';
import { flangeEndFrame, type SheetGeometryResult, type SheetPanelGeometry, type SheetTangentFrame } from './panelGeometry.js';
import { rigidSheetCurve } from './rigidCurve.js';

export interface SheetLineBendPartition {
  readonly rule: SheetBendInput;
  readonly fixed: readonly SheetPanelGeometry[];
  readonly moving: readonly SheetPanelGeometry[];
  /** 移動前の面。再展開の比較と、既存の接続がどちら側に属するかの判定に使う。 */
  readonly flatMoving: readonly SheetPanelGeometry[];
  /** frameを原点にしたXY展開輪郭。y=0..BAの間だけを円筒へ写す。 */
  readonly bands: readonly SheetPanelGeometry[];
  readonly frame: SheetTangentFrame;
  readonly movingSource: SheetTangentFrame; readonly movingTarget: SheetTangentFrame;
  readonly metrics: SheetBendMetrics;
}
const FLAT: SheetTangentFrame = { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] };

function clipped(panel: SheetPanelGeometry, frame: SheetTangentFrame, side: -1 | 1, id: string): SheetGeometryResult<readonly SheetPanelGeometry[]> {
  const result = clipSheetPanel(panel, { origin: frame.origin, normal: frame.yAxis }, side, id);
  return result.ok ? groupClippedPanels(result.value, panel.normal, frame.yAxis, id) : result;
}
function movePanel(panel: SheetPanelGeometry, from: SheetTangentFrame, to: SheetTangentFrame): SheetPanelGeometry {
  return { ...panel, normal: to.normal, outer: panel.outer.map((curve) => rigidSheetCurve(curve, from, to)),
    holes: panel.holes.map((loop) => loop.map((curve) => rigidSheetCurve(curve, from, to))) };
}

export function partitionSheetLineBend(panel: SheetPanelGeometry, line: ResolvedSegment, fixedSide: 'left' | 'right',
  input: SheetBendInput, featureId: string): SheetGeometryResult<SheetLineBendPartition> {
  const metrics = sheetBendMetrics(input); if (!metrics.ok) return { ok: false, message: '板金の曲げ角・板厚・半径・K係数を確認してください。' };
  const vector = subVec3(line.to, line.from), length = lengthVec3(vector), normal = panel.normal;
  if (panel.outer.length === 0 || ![...line.from, ...line.to, ...normal, length].every(Number.isFinite) || length <= 1e-7
    || Math.abs(lengthVec3(normal) - 1) > 1e-10 || Math.min(input.radius, input.thickness) <= 1e-7)
    return { ok: false, message: '曲げるパネルと重ならない2点の指定線を選んでください。' };
  if (Math.abs(dotVec3(vector, normal)) > 1e-7 || Math.abs(dotVec3(subVec3(line.from, curveStart(panel.outer[0])), normal)) > 1e-7)
    return { ok: false, message: '曲げる線は選択したパネルと同じ平面に置いてください。' };
  // y正方向を動く側へ揃え、軸の反転で左右を処理する。寸法は拡縮しない。
  const xAxis = scaleVec3(normalizeVec3(vector), fixedSide === 'left' ? -1 : 1), yAxis = crossVec3(normal, xAxis);
  const allowance = metrics.metrics.bendAllowance;
  const frame: SheetTangentFrame = { origin: addVec3(line.from, scaleVec3(yAxis, -allowance / 2)), xAxis, yAxis, normal };
  const movingSource = { ...frame, origin: addVec3(frame.origin, scaleVec3(yAxis, allowance)) };
  const target = flangeEndFrame(frame, input.thickness, input.radius, input.angle); if (!target.ok) return target;
  if (input.angle === 0) return { ok: true, value: { rule: input, fixed: [panel], moving: [], flatMoving: [], bands: [], frame, movingSource,
    movingTarget: target.value, metrics: metrics.metrics } };
  const fixed = clipped(panel, frame, -1, `${featureId}:fixed`); if (!fixed.ok) return fixed;
  const moving = clipped(panel, movingSource, 1, `${featureId}:moving`); if (!moving.ok) return moving;
  if (fixed.value.length === 0 || moving.value.length === 0)
    return { ok: false, message: '曲げの両側に平らな板が残るよう、指定線・角度・半径を変更してください。' };
  const stripStart = clipped(panel, frame, 1, `${featureId}:band-start`); if (!stripStart.ok) return stripStart;
  const bands: SheetPanelGeometry[] = [];
  for (const piece of stripStart.value) {
    const result = clipped(piece, movingSource, -1, `${featureId}:band:${piece.id}`); if (!result.ok) return result;
    bands.push(...result.value.map((item) => movePanel(item, frame, FLAT)));
  }
  if (bands.length === 0) return { ok: false, message: '指定線の接線間に曲げる材料がありません。' };
  return { ok: true, value: { rule: input, fixed: fixed.value, moving: moving.value.map((item) => movePanel(item, movingSource, target.value)),
    flatMoving: moving.value, bands, frame, movingSource, movingTarget: target.value, metrics: metrics.metrics } };
}
