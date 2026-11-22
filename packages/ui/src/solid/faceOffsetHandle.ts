/**
 * 面の移動の矢印のつまみ(M-05 4-2a)の位置と向きを、ストアの状態から求める純関数。
 *
 * つまみは「面の移動」の入力欄が開いている間だけ、選んだ平らな面の重心から外向きの法線の上に出る。
 * 根もとは欄の距離だけ動かした所(打てば打った数の所、引けば引いた所)。距離は確定と同じ道筋
 * (`previewSolidCommit`。空欄の既定・式・変数表・表示の単位が決定と同じ)で読むので、つまみの位置と
 * 確定して動く面の位置は同じになる。ストアにも文書にも触れない。描くのは `../viewport/solidLayerFaceHandle.ts`、
 * 引くのは `../viewport/faceOffsetHandleDrag.ts`。
 *
 * 外向き: 平らな面の `axis` は、計算部が面の向き(反転)を見て符号を揃えた外向きの法線
 * (kernel の occt/subShapes.ts の readFaceGeometry)。面の移動の正の距離も同じ符号の法線の向きへ動かし、
 * 材料を足す(kernel の occt/editSolidFace.ts の readSignature と `volumeBefore + offset * area`)。
 */
import { addVec3, normalizeVec3, scaleVec3, type Vec3 } from '@pointercad/model';

import { previewSolidCommit } from '../sketch/numericInput.js';
import type { AppState } from '../store/appState.js';
import { parseSubShapeId } from './subShapeSelection.js';

/** つまみ 1 つ。座標はどれも部品の座標(mm)。 */
export interface DistanceHandle {
  /** つまみが動く軸の基準点。 */
  readonly base: Vec3;
  /** 正の距離の向きを表す単位法線。 */
  readonly normal: Vec3;
  /** 欄の距離(mm)。確定と同じ読み方で読めない時は 0(つまみは面の上に出る)。 */
  readonly distanceMm: number;
  /** つまみの根もと = base + normal × distanceMm × scale。矢印はここから normal の向きへ出る。 */
  readonly origin: Vec3;
  readonly fieldKey: 'faceOffsetDistance' | 'distance';
  /** 欄の距離のうち、つまみが片側へ進む割合。 */
  readonly scale: number;
  readonly positiveOnly: boolean;
}

/** つまみを求める材料(ストアから読むものだけ)。 */
type FaceOffsetHandleSource = Pick<AppState, 'numericInput' | 'selection' | 'bodies' | 'parameterAnalysis' | 'displaySettings'>;

/**
 * 面の移動の入力欄が開いていて、選択がちょうど平らな面 1 枚の時のつまみ。それ以外は null。
 * 面の一覧はいま描いている立体(`bodies`)から引く。立体が作れていない(`isValid` が偽)時も出さない。
 */
export function faceOffsetHandleOf(source: FaceOffsetHandleSource): DistanceHandle | null {
  const input = source.numericInput;
  if (input === null || input.step !== 'faceOffsetDistance' || source.selection.length !== 1) return null;
  const selected = parseSubShapeId(source.selection[0]);
  if (selected === null || selected.kind !== 'face') return null;
  const body = source.bodies.find(candidate => candidate.featureId === selected.bodyFeatureId);
  const face = body?.isValid === true ? body.faces.find(candidate => candidate.index === selected.index) : undefined;
  if (face === undefined || face.surfaceKind !== 'plane' || face.axis === null || !face.centroid.every(Number.isFinite)) return null;
  const normal = normalizeVec3(face.axis);
  if (!normal.some(component => component !== 0)) return null;
  // 決定(NumericInputPopover の Enter)と同じ評価の文脈: パラメータの解析と表示の単位。
  const commit = previewSolidCommit(input, { ...source.parameterAnalysis, lengthUnit: source.displaySettings.lengthUnit });
  const value = commit?.values.faceOffsetDistance?.value;
  const distanceMm = value !== undefined && Number.isFinite(value) ? value : 0;
  return {
    base: face.centroid, normal, distanceMm, origin: addVec3(face.centroid, scaleVec3(normal, distanceMm)),
    fieldKey: 'faceOffsetDistance', scale: 1, positiveOnly: false,
  };
}
