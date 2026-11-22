import { addVec3, cleanZeroVec3, curveSamplePoints, fitPlaneNormal, scaleVec3, type Vec3 } from '@pointercad/model';

import { choiceValueOf, previewSolidCommit, toggleValueOf } from '../sketch/numericInput.js';
import type { AppState } from '../store/appState.js';
import { faceOffsetHandleOf, type DistanceHandle } from './faceOffsetHandle.js';
import { selectedExtrudeProfiles } from './sketchRefs.js';

type DistanceHandleSource = Pick<AppState,
  'numericInput' | 'selection' | 'bodies' | 'document' | 'parameterAnalysis' | 'displaySettings' | 'resolvedSketch' | 'sketch'>;

/** 今のスケッチで選んだ面 1 枚を距離で押し出すとき、押し出しの先端につまみを出す。 */
function extrudeHandleOf(source: DistanceHandleSource): DistanceHandle | null {
  const input = source.numericInput;
  if (input?.toolId !== 'extrude' || input.step !== 'extrudeDistance' || input.extrudeRegion !== undefined
    || choiceValueOf(input, 'extrudeEnd') !== 'distance') return null;

  const profiles = selectedExtrudeProfiles(source.document, source.selection);
  if (profiles.length !== 1 || profiles[0].sketchId !== source.sketch.id) return null;
  const face = source.resolvedSketch.faces.find(candidate => candidate.featureId === profiles[0].faceFeatureId);
  if (face === undefined) return null;

  // 確定(resolvePart の planExtrude)と同じ標本から法線を求める。標本の平均を軸の基準点にする。
  const samples = face.curves.flatMap(curveSamplePoints);
  const planeNormal = fitPlaneNormal(samples);
  if (planeNormal === null) return null;
  const base = scaleVec3(samples.reduce<Vec3>(addVec3, [0, 0, 0]), 1 / samples.length);

  const commit = previewSolidCommit(input, { ...source.parameterAnalysis, lengthUnit: source.displaySettings.lengthUnit });
  const value = commit?.values.distance?.value;
  const distanceMm = value !== undefined && Number.isFinite(value) ? value : 0;
  // 式が読めない間も向きと倍率は窓のつまみの状態を保つ。
  const reversed = commit?.flags.reversed ?? toggleValueOf(input, 'reversed');
  const symmetric = commit?.flags.symmetric ?? toggleValueOf(input, 'symmetric');
  const normal = reversed ? cleanZeroVec3(scaleVec3(planeNormal, -1)) : planeNormal;
  const scale = symmetric ? 0.5 : 1;
  return {
    base, normal, distanceMm, origin: addVec3(base, scaleVec3(normal, distanceMm * scale)),
    fieldKey: 'distance', scale, positiveOnly: true,
  };
}

/** 描画とドラッグで同じつまみの位置と向きを使う。 */
export function distanceHandleOf(source: DistanceHandleSource): DistanceHandle | null {
  return faceOffsetHandleOf(source) ?? extrudeHandleOf(source);
}
