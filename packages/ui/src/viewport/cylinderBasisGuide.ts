import type { SolidFaceEntry, Vec3 } from '@pointercad/model';
import { currentMathGeometry } from '../math/mathGeometryResults.js';
import { parseSubShapeId } from '../solid/subShapeSelection.js';
import type { AppState } from '../store/appState.js';
import type { MeasurementState } from './createMeasureLayer.js';
import { captureSolidMeshAdmission, isSolidMeshAdmissionCurrent, type SolidMeshAdmission } from './solidMeshAdmission.js';

export interface CylinderBasisGuide {
  readonly admission: SolidMeshAdmission;
  readonly selection: readonly string[];
  readonly drawing: MeasurementState;
}

/** A guide requires a committed, receipted current body and current mathematical results. */
export function isCylinderBasisGuideCurrent(guide: CylinderBasisGuide, state: AppState): boolean {
  return !state.isComputing && state.stagedSolid === null && state.selection === guide.selection
    && currentMathGeometry(state).status === 'current' && guide.admission.accounting !== null
    && guide.admission.bodies === state.bodies && isSolidMeshAdmissionCurrent(guide.admission, state);
}

/** A radial reference direction, including when the zero meridian is outside a trimmed face. */
export function cylinderBasisSegment(face: SolidFaceEntry): readonly [Vec3, Vec3] | null {
  const basis = face.cylinderBasis, radius = face.radius;
  if (face.surfaceKind !== 'cylinder' || basis === undefined || radius === null || !Number.isFinite(radius) || radius <= 0) return null;
  const { origin, axis, zeroDirection, axialRange } = basis;
  if (![...origin, ...axis, ...zeroDirection, ...axialRange].every(Number.isFinite)
    || !(axialRange[1] > axialRange[0]) || Math.abs(Math.hypot(...axis) - 1) > 1e-9
    || Math.abs(Math.hypot(...zeroDirection) - 1) > 1e-9
    || Math.abs(axis[0] * zeroDirection[0] + axis[1] * zeroDirection[1] + axis[2] * zeroDirection[2]) > 1e-9) return null;
  const v = axialRange[0] / 2 + axialRange[1] / 2;
  const center: Vec3 = [origin[0] + v * axis[0], origin[1] + v * axis[1], origin[2] + v * axis[2]];
  const end: Vec3 = [center[0] + radius * zeroDirection[0], center[1] + radius * zeroDirection[1], center[2] + radius * zeroDirection[2]];
  return [...center, ...end].every(Number.isFinite) ? [center, end] : null;
}

/** Read current native faces only. No document, history, saved-reference or store writes. */
export function cylinderBasisGuide(state: AppState, text: string): CylinderBasisGuide | null {
  if (state.selection.length !== 1) return null;
  const admission = captureSolidMeshAdmission(state);
  if (admission === null) return null;
  const selected = parseSubShapeId(state.selection[0]);
  if (selected === null || selected.kind !== 'face') return null;
  const body = state.bodies.find(row => row.featureId === selected.bodyFeatureId);
  const face = body?.faces.find(row => row.index === selected.index);
  if (body?.isValid !== true || face === undefined) return null;
  const segment = cylinderBasisSegment(face);
  if (segment === null || face.radius === null) return null;
  // Reuse the existing line/endpoint/label renderer in a separate instance; never publish a measurement.
  const guide: CylinderBasisGuide = { admission, selection: state.selection,
    drawing: { result: { kind: 'pointDistance', value: face.radius, unit: 'mm', segment },
      text, angle: null, anchor: null } };
  return isCylinderBasisGuideCurrent(guide, state) ? guide : null;
}
