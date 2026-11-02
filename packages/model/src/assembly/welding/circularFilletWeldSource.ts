/** Version 5 saved geometry. Reading this source never certifies current contact. */
import { exactExpressionValueFromNumber } from '@pointercad/expression';

import type { SubShapeOrigin } from '../../geometry/subShapeOrigin.js';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { PartDocument } from '../../part/types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { rebuildCircularFilletWeldPart, type CircularFilletWeldSection } from './circularFilletWeldGeometry.js';
import { readCircularWeldPathSnapshot, type CircularWeldPathDefinition } from './curvedWeldPath.js';
import { filletWeldLegs } from './filletWeldPart.js';
import { FILLET_WELD_CATALOG_REVISION } from './types.js';

export const CIRCULAR_FILLET_WELD_GENERATOR_REVISION = 'fillet-weld-5';

export interface CircularWeldSavedParent {
  readonly role: 'plane' | 'cylinder';
  readonly documentId: string;
  readonly ownerId: string;
  readonly occurrencePath: readonly string[];
  readonly sourceKey: string;
  readonly placementKey: string;
  readonly bodyFeatureId: string;
  readonly bodyKey: string;
  readonly reference: SubShapeRef;
}
export interface CircularFilletWeldSavedOptions {
  readonly weldId: string;
  readonly beadId: string;
  readonly path: CircularWeldPathDefinition;
  readonly radialDirection: 1 | -1;
  readonly normalDirection: 1 | -1;
  readonly parents: readonly [CircularWeldSavedParent, CircularWeldSavedParent];
}
export interface CircularFilletWeldSavedSource {
  readonly options: CircularFilletWeldSavedOptions;
  readonly section: CircularFilletWeldSection;
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0); }
function index(value: unknown): value is number { return finite(value) && Number.isSafeInteger(value) && value >= 0; }
function strings(value: unknown): value is readonly string[] { return Array.isArray(value) && value.length > 0 && value.every(text); }
function vector(value: unknown): value is Vec3 { return Array.isArray(value) && value.length === 3 && value.every(finite); }

/** Strict wire values; do not silently replace NaN, -0, undefined or foreign objects. */
function wire(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return finite(value);
  if (Array.isArray(value)) return value.every(item => wire(item, depth + 1));
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value).every(item => wire(item, depth + 1));
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key: string, row: unknown): unknown => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return row;
    return Object.fromEntries(Object.entries(row).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}
function owned<T>(value: T): T {
  if (typeof value === 'object' && value !== null) { Object.values(value).forEach(owned); Object.freeze(value); }
  return value;
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
  const list = (items: unknown, child: string, minimum: number): boolean => Array.isArray(items) && items.length >= minimum
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
function face(value: unknown, role: 'plane' | 'cylinder'): SubShapeRef | null {
  if (!object(value)) return null;
  if (!record(value, Object.hasOwn(value, 'origin') ? ['bodyFeatureId', 'index', 'fingerprint', 'origin'] : ['bodyFeatureId', 'index', 'fingerprint'])
    || !text(value.bodyFeatureId) || !index(value.index)) return null;
  const f = value.fingerprint;
  if (!record(f, ['kind', 'surfaceKind', 'area', 'position', 'axis', 'radius']) || f.kind !== 'face' || f.surfaceKind !== role
    || !finite(f.area) || f.area <= 0 || !vector(f.position) || !vector(f.axis)
    || Math.abs(Math.hypot(...f.axis) - 1) > 1e-9
    || (role === 'plane' ? f.radius !== null : !finite(f.radius) || f.radius <= 0)) return null;
  if (Object.hasOwn(value, 'origin') && (!origin(value.origin) || value.origin.shapeKind !== 'face')) return null;
  return owned({ bodyFeatureId: value.bodyFeatureId, index: value.index,
    fingerprint: { kind: 'face', surfaceKind: role, area: f.area, position: [...f.position], axis: [...f.axis], radius: role === 'plane' ? null : Number(f.radius) },
    ...(!Object.hasOwn(value, 'origin') || !origin(value.origin) ? {} : { origin: structuredClone(value.origin) }) });
}
function parent(value: unknown, role: 'plane' | 'cylinder'): CircularWeldSavedParent | null {
  if (!record(value, ['role', 'documentId', 'ownerId', 'occurrencePath', 'sourceKey', 'placementKey', 'bodyFeatureId', 'bodyKey', 'reference'])
    || value.role !== role || !text(value.documentId) || !text(value.ownerId) || !strings(value.occurrencePath)
    || !text(value.sourceKey) || !text(value.placementKey) || !text(value.bodyFeatureId) || !text(value.bodyKey)) return null;
  const reference = face(value.reference, role);
  if (reference === null || reference.bodyFeatureId !== value.bodyFeatureId) return null;
  return owned({ role, documentId: value.documentId, ownerId: value.ownerId, occurrencePath: [...value.occurrencePath],
    sourceKey: value.sourceKey, placementKey: value.placementKey, bodyFeatureId: value.bodyFeatureId, bodyKey: value.bodyKey, reference });
}
function options(value: unknown): CircularFilletWeldSavedOptions | null {
  if (!wire(value) || !record(value, ['weldId', 'beadId', 'path', 'radialDirection', 'normalDirection', 'parents'])
    || !text(value.weldId) || !text(value.beadId) || (value.radialDirection !== 1 && value.radialDirection !== -1)
    || (value.normalDirection !== 1 && value.normalDirection !== -1) || !Array.isArray(value.parents) || value.parents.length !== 2) return null;
  const path = readCircularWeldPathSnapshot(value.path), plane = parent(value.parents[0], 'plane'), cylinder = parent(value.parents[1], 'cylinder');
  if (path === null || plane === null || cylinder === null || !path.definition.intervals.some(row => row.beadId === value.beadId)
    || plane.documentId !== cylinder.documentId || plane.documentId !== path.definition.evidence.source.documentId
    || canonical(plane.occurrencePath) === canonical(cylinder.occurrencePath)) return null;
  const s = path.definition.evidence.source;
  if (![plane, cylinder].some(p => p.ownerId === s.ownerId && canonical(p.occurrencePath) === canonical(s.occurrencePath)
    && p.sourceKey === s.sourceKey && p.placementKey === s.placementKey && p.bodyFeatureId === s.bodyFeatureId && p.bodyKey === s.bodyKey)) return null;
  return owned({ weldId: value.weldId, beadId: value.beadId, path: path.definition,
    radialDirection: value.radialDirection, normalDirection: value.normalDirection, parents: [plane, cylinder] });
}

export function createCircularFilletWeldSource(radialLegMm: number, normalLegMm: number, value: unknown): StandardPartSource | null {
  if (!finite(radialLegMm) || !finite(normalLegMm) || radialLegMm <= 0 || normalLegMm <= 0) return null;
  const payload = options(value);
  if (payload === null) return null;
  const source: StandardPartSource = { kind: 'standardPart', catalog: 'filletWeld',
    size: `${exactExpressionValueFromNumber(radialLegMm).source}x${exactExpressionValueFromNumber(normalLegMm).source}`,
    options: { weldCircular: canonical(payload) }, catalogRevision: FILLET_WELD_CATALOG_REVISION,
    generatorRevision: CIRCULAR_FILLET_WELD_GENERATOR_REVISION };
  return readCircularFilletWeldSource(source) === null ? null : owned(source);
}

export function readCircularFilletWeldSource(source: StandardPartSource): CircularFilletWeldSavedSource | null {
  if (source.catalog !== 'filletWeld' || source.catalogRevision !== FILLET_WELD_CATALOG_REVISION
    || source.generatorRevision !== CIRCULAR_FILLET_WELD_GENERATOR_REVISION || !record(source.options, ['weldCircular'])
    || typeof source.options.weldCircular !== 'string') return null;
  let value: unknown;
  try { value = JSON.parse(source.options.weldCircular); } catch { return null; }
  const payload = options(value), legs = filletWeldLegs(source.size);
  if (payload === null || legs === null || canonical(payload) !== source.options.weldCircular
    || source.size !== `${exactExpressionValueFromNumber(legs.legOnSecond).source}x${exactExpressionValueFromNumber(legs.legOnFirst).source}`) return null;
  const section: CircularFilletWeldSection = { beadId: payload.beadId, radialLegMm: legs.legOnSecond, normalLegMm: legs.legOnFirst,
    radialDirection: payload.radialDirection, normalDirection: payload.normalDirection };
  return rebuildCircularFilletWeldPart(payload.path, section) === null ? null : owned({ options: payload, section });
}

/** Source restoration only. Current contact, group completeness and strength are separate. */
export function buildCircularFilletWeldPartFromSource(source: StandardPartSource): PartDocument | null {
  const saved = readCircularFilletWeldSource(source);
  return saved === null ? null : rebuildCircularFilletWeldPart(saved.options.path, saved.section);
}
