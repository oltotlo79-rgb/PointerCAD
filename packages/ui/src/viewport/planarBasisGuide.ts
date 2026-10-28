import type { SolidFaceEntry, Vec3 } from '@pointercad/model';
import { validPlanarHoleBasis } from '../solid/planarHoleInput.js';
import { parseSubShapeId } from '../solid/subShapeSelection.js';
import type { AppState } from '../store/appState.js';
import type { MeasurementState } from './createMeasureLayer.js';
import { isCylinderBasisGuideCurrent, type CylinderBasisGuide } from './cylinderBasisGuide.js';
import { captureSolidMeshAdmission } from './solidMeshAdmission.js';

/** 円筒ガイドと同じ所有票。追加するのは表示専用のX/Y線だけで、文書へ保存しない。 */
export interface PlanarBasisGuide extends CylinderBasisGuide {
  readonly xDrawing: MeasurementState;
  readonly yDrawing: MeasurementState;
}

export interface PlanarBasisLabels {
  readonly origin: string;
  readonly x: string;
  readonly y: string;
}

/** nativeの実原点と正方向。線の長さだけを選択面の実面積から決める。 */
export function planarBasisDrawings(face: SolidFaceEntry, labels: PlanarBasisLabels):
readonly [MeasurementState, MeasurementState, MeasurementState] | null {
  if (face.surfaceKind !== 'plane' || !validPlanarHoleBasis(face.planarBasis)
    || !Number.isFinite(face.area) || face.area <= 0) return null;
  const { origin, xAxis, yAxis } = face.planarBasis;
  const length = Math.sqrt(face.area) / 4;
  if (!Number.isFinite(length) || length <= 0) return null;
  const end = (axis: Vec3): Vec3 => [origin[0] + length * axis[0],
    origin[1] + length * axis[1], origin[2] + length * axis[2]];
  const x = end(xAxis), y = end(yAxis);
  if (![...x, ...y].every(Number.isFinite)
    || Math.hypot(x[0] - origin[0], x[1] - origin[1], x[2] - origin[2]) === 0
    || Math.hypot(y[0] - origin[0], y[1] - origin[1], y[2] - origin[2]) === 0) return null;
  const drawing = (point: Vec3, text: string, value: number): MeasurementState => ({
    result: { kind: 'pointDistance', value, unit: 'mm', segment: [origin, point] },
    text, angle: null, anchor: null,
  });
  return [drawing(origin, labels.origin, 0), drawing(x, labels.x, length), drawing(y, labels.y, length)];
}

/** 描画直前にも、既存の所有票・数学結果・選択の同一性を照合する。 */
export function isPlanarBasisGuideCurrent(guide: PlanarBasisGuide, state: AppState): boolean {
  return isCylinderBasisGuideCurrent(guide, state);
}

/** 選択した現平面だけを読む。保存参照・文書・測定store・履歴への書込みはない。 */
export function planarBasisGuide(state: AppState, labels: PlanarBasisLabels): PlanarBasisGuide | null {
  if (state.selection.length !== 1) return null;
  const admission = captureSolidMeshAdmission(state);
  if (admission === null) return null;
  const selected = parseSubShapeId(state.selection[0]);
  if (selected === null || selected.kind !== 'face') return null;
  const bodies = state.bodies.filter(body => body.featureId === selected.bodyFeatureId);
  if (bodies.length !== 1 || bodies[0].isValid !== true) return null;
  const faces = bodies[0].faces.filter(face => face.index === selected.index);
  if (faces.length !== 1) return null;
  const drawings = planarBasisDrawings(faces[0], labels);
  if (drawings === null) return null;
  const guide: PlanarBasisGuide = { admission, selection: state.selection,
    drawing: drawings[0], xDrawing: drawings[1], yDrawing: drawings[2] };
  return isPlanarBasisGuideCurrent(guide, state) ? guide : null;
}
