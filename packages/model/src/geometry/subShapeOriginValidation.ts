import { isFiniteNumber, hasExactOwnKeys as record } from '../valueGuards.js';
import type { SubShapeOrigin } from './subShapeOrigin.js';

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function finite(value: unknown): value is number { return isFiniteNumber(value) && !Object.is(value, -0); }
function index(value: unknown): value is number { return finite(value) && Number.isSafeInteger(value) && value >= 0; }
function dense(value: readonly unknown[]): boolean {
  return Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
}
function strings(value: unknown): value is readonly string[] { return Array.isArray(value) && value.length > 0 && dense(value) && value.every(text); }
/** Saved source-line sets of a planar sheet: canonical ascending code-unit order, no duplicates, bounded count. */
function ascendingIds(value: unknown, minimum: number, maximum: number): boolean {
  return strings(value) && value.length >= minimum && value.length <= maximum
    && value.every((id, at) => at === 0 || value[at - 1] < id);
}
function planarProfile(value: unknown, shape: 'face' | 'edge' | 'vertex'): boolean {
  if (shape === 'edge') return record(value, ['sketchId', 'lineFeatureId', 'role']) && text(value.sketchId)
    && text(value.lineFeatureId) && value.role === 'whole-line';
  return record(value, ['sketchId', 'lineFeatureIds']) && text(value.sketchId)
    && (shape === 'face' ? ascendingIds(value.lineFeatureIds, 3, 32) : ascendingIds(value.lineFeatureIds, 2, 2));
}

// Semantic references retain the existing origin vocabulary, with finite recursion.
// These are saved identity checks, never runtime topology resolution.
function profile(value: unknown, region: boolean, curve = false): boolean {
  const key = region ? (curve ? 'curveFeatureIds' : 'lineFeatureIds') : (curve ? 'curveFeatureId' : 'lineFeatureId');
  return record(value, region ? ['sketchId', 'faceFeatureId', key] : ['sketchId', 'faceFeatureId', key, 'role'])
    && text(value.sketchId) && text(value.faceFeatureId)
    && (region ? strings(value[key]) && value[key].length >= 3 : text(value[key]) && value.role === (curve ? 'whole-curve' : 'whole-line'));
}
function pointProducer(value: unknown, depth: number): boolean {
  if (depth > 16 || !object(value)) return false;
  switch (value.kind) {
    case 'point': return record(value, ['kind', 'featureId']) && text(value.featureId);
    case 'linear-point': return record(value, ['kind', 'featureId', 'step']) && text(value.featureId) && index(value.step);
    case 'grid-point': return record(value, ['kind', 'featureId', 'row', 'column']) && text(value.featureId) && index(value.row) && index(value.column);
    case 'circular-point': return record(value, ['kind', 'featureId', 'numerator', 'denominator']) && text(value.featureId)
      && index(value.numerator) && index(value.denominator) && value.denominator > 0 && value.numerator < value.denominator;
    case 'copied-point': return record(value, ['kind', 'featureId', 'source', 'placement']) && text(value.featureId)
      && pointProducer(value.source, depth + 1) && copyPlacement(value.placement);
    default: return false;
  }
}
function copyPlacement(value: unknown): boolean {
  if (record(value, ['kind']) && (value.kind === 'mirror' || value.kind === 'translate')) return true;
  if (record(value, ['kind', 'step'])) return value.kind === 'linear' && index(value.step);
  return record(value, ['kind', 'fullCircle', 'numerator', 'denominator']) && value.kind === 'circular'
    && typeof value.fullCircle === 'boolean' && index(value.numerator) && index(value.denominator)
    && value.denominator > 0 && value.numerator < value.denominator;
}
function holeCenter(value: unknown, depth: number): boolean {
  return record(value, ['sketchId', 'producer']) && text(value.sketchId) && pointProducer(value.producer, depth + 1);
}
function pointSource(value: unknown, depth: number): boolean {
  if (depth > 16 || !object(value)) return false;
  switch (value.kind) {
    case 'origin': return record(value, ['kind']);
    case 'sketch-point': return record(value, ['kind', 'anchor']) && holeCenter(value.anchor, depth + 1);
    case 'reference-point': return record(value, ['kind', 'featureId']) && text(value.featureId);
    case 'curve-vertex': return record(value, ['kind', 'sketchId', 'featureId', 'vertex']) && text(value.sketchId) && text(value.featureId)
      && ['start', 'end', 'center'].includes(String(value.vertex));
    case 'semantic-subshape': return record(value, ['kind', 'bodyFeatureId', 'origin']) && text(value.bodyFeatureId) && origin(value.origin, depth + 1);
    case 'sphere-grid': {
      const extra = ['latitudeMathDefinition', 'longitudeMathDefinition'].filter(key => Object.hasOwn(value, key));
      return record(value, ['kind', 'featureId', 'latitudeSource', 'longitudeSource', ...extra]) && text(value.featureId)
        && text(value.latitudeSource) && text(value.longitudeSource) && extra.every(key => text(value[key]));
    }
    default: return false;
  }
}
function holePlacement(value: unknown, depth: number): boolean {
  if (record(value, ['kind']) && value.kind === 'original') return true;
  if (record(value, ['kind', 'step'])) return value.kind === 'linear' && index(value.step);
  if (record(value, ['kind', 'slotId', 'source'])) return value.kind === 'point-slot' && text(value.slotId) && pointSource(value.source, depth + 1);
  return copyPlacement(value) && typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'circular';
}
function identity(value: unknown, shape: string, depth: number): boolean {
  if (depth > 16 || !object(value)) return false;
  const list = (items: unknown, child: string, minimum: number): boolean => Array.isArray(items) && dense(items) && items.length >= minimum
    && items.length <= 64 && items.every(item => identity(item, child, depth + 1));
  if (shape === 'face') switch (value.kind) {
    case 'box-face': return record(value, ['kind', 'featureId', 'role']) && text(value.featureId)
      && ['bottom', 'top', 'front', 'back', 'left', 'right'].includes(String(value.role));
    case 'cylinder-face': case 'cone-face': return record(value, ['kind', 'featureId', 'role']) && text(value.featureId)
      && ['side', 'start', 'end'].includes(String(value.role));
    case 'sphere-face': case 'torus-face': return record(value, ['kind', 'featureId', 'role']) && text(value.featureId) && value.role === 'surface';
    case 'surface-side': return record(value, ['kind', 'featureId', 'profile']) && text(value.featureId)
      && record(value.profile, ['sketchId', 'lineFeatureId', 'role']) && text(value.profile.sketchId)
      && text(value.profile.lineFeatureId) && value.profile.role === 'whole-line';
    case 'planar-surface-face': return record(value, ['kind', 'featureId', 'profile']) && text(value.featureId)
      && planarProfile(value.profile, 'face');
    case 'extrude-side': case 'extrude-curve-side': return record(value, ['kind', 'featureId', 'profile']) && text(value.featureId)
      && profile(value.profile, false, value.kind === 'extrude-curve-side');
    case 'extrude-cap': case 'extrude-curve-cap': return record(value, ['kind', 'featureId', 'profile', 'end']) && text(value.featureId)
      && (value.end === 'start' || value.end === 'end') && profile(value.profile, true, value.kind === 'extrude-curve-cap');
    case 'blend-face': return record(value, ['kind', 'featureId', 'operation', 'source']) && text(value.featureId)
      && (value.operation === 'fillet' || value.operation === 'chamfer') && identity(value.source, 'edge', depth + 1);
    case 'merged-face': return record(value, ['kind', 'featureId', 'sources']) && text(value.featureId) && list(value.sources, 'face', 2);
    case 'hole-face': return record(value, ['kind', 'featureId', 'center', 'placement', 'stage', 'role']) && text(value.featureId)
      && holeCenter(value.center, depth + 1) && holePlacement(value.placement, depth + 1)
      && (value.stage === 'thread' ? value.role === 'groove' : ['bore', 'counterbore', 'countersink'].includes(String(value.stage))
        && ['wall', 'floor', 'entry-cap'].includes(String(value.role)));
    default: return false;
  }
  if (shape === 'edge') switch (value.kind) {
    case 'cylinder-edge': return record(value, ['kind', 'featureId', 'role']) && text(value.featureId) && ['start-ring', 'end-ring', 'seam'].includes(String(value.role));
    case 'planar-surface-edge': return record(value, ['kind', 'featureId', 'profile']) && text(value.featureId)
      && planarProfile(value.profile, 'edge');
    case 'box-edge': return record(value, ['kind', 'featureId', 'role']) && text(value.featureId)
      && ['bottom-front', 'bottom-back', 'bottom-left', 'bottom-right', 'top-front', 'top-back', 'top-left', 'top-right', 'front-left', 'front-right', 'back-left', 'back-right'].includes(String(value.role));
    case 'face-intersection-edge': return record(value, ['kind', 'featureId', 'faces']) && text(value.featureId)
      && Array.isArray(value.faces) && value.faces.length === 2 && list(value.faces, 'face', 2);
    case 'merged-edge': return record(value, ['kind', 'featureId', 'sources']) && text(value.featureId) && list(value.sources, 'edge', 2);
    default: return false;
  }
  if (shape === 'vertex') switch (value.kind) {
    case 'box-vertex': return record(value, ['kind', 'featureId', 'role']) && text(value.featureId)
      && ['bottom-front-left', 'bottom-front-right', 'bottom-back-left', 'bottom-back-right', 'top-front-left', 'top-front-right', 'top-back-left', 'top-back-right'].includes(String(value.role));
    case 'cylinder-vertex': return record(value, ['kind', 'featureId', 'role']) && text(value.featureId) && ['seam-start', 'seam-end'].includes(String(value.role));
    case 'planar-surface-vertex': return record(value, ['kind', 'featureId', 'profile']) && text(value.featureId)
      && planarProfile(value.profile, 'vertex');
    case 'face-intersection-vertex': return record(value, ['kind', 'featureId', 'faces']) && text(value.featureId)
      && Array.isArray(value.faces) && value.faces.length === 3 && list(value.faces, 'face', 3);
    case 'merged-vertex': return record(value, ['kind', 'featureId', 'sources']) && text(value.featureId) && list(value.sources, 'vertex', 2);
    default: return false;
  }
  return false;
}
function origin(value: unknown, depth = 0): value is SubShapeOrigin {
  return record(value, ['version', 'shapeKind', 'identity']) && value.version === 1
    && ['face', 'edge', 'vertex'].includes(String(value.shapeKind)) && identity(value.identity, String(value.shapeKind), depth + 1);
}

export const isSubShapeOrigin = origin;
