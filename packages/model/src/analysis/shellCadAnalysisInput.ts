import { isSubShapeOrigin } from '../geometry/subShapeOriginValidation.js';
import type { SubShapeOrigin } from '../geometry/subShapeOrigin.js';
import type { PropertySource, Vector3 } from './analysisModel.js';
import { fields, InputIssue, list, number, propertySource, text, vector } from './analysisValidation.js';
import { readShellCadInput, type ShellCadSavedInput } from './shellCadInput.js';

export const SHELL_CAD_ANALYSIS_SCHEMA = 'pointercad-shell-cad-analysis/1';
type ShellSupportOrigin = Extract<SubShapeOrigin, { shapeKind: 'edge' | 'vertex' }>;
type EdgeOrigin = Extract<SubShapeOrigin, { shapeKind: 'edge' }>;
type Fixed6 = readonly [boolean, boolean, boolean, boolean, boolean, boolean];
export interface ShellCadAnalysisInput {
  readonly schema: typeof SHELL_CAD_ANALYSIS_SCHEMA;
  readonly id: 'shell-cad-analysis';
  readonly source: { readonly documentId: string };
  readonly geometry: ShellCadSavedInput;
  readonly material: { readonly id: string; readonly youngMPa: number; readonly poisson: number; readonly source: PropertySource };
  readonly supports: readonly { readonly kind: 'edge' | 'vertex'; readonly origin: ShellSupportOrigin; readonly fixed: Fixed6 }[];
  readonly edgeLoads: readonly { readonly origin: EdgeOrigin; readonly forceNPerMm: Vector3; readonly momentNmmPerMm: Vector3 }[];
  readonly surface: { readonly linearDeflection: number; readonly angularDeflection: number; readonly maximumNodes: number;
    readonly maximumTriangles: number; readonly minimumTriangleAreaMm2: number; readonly minimumAngleDeg: number;
    readonly maximumAspectRatio: number };
}

function dense(value: unknown, path: string): void {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1
    || Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).some(present => !present)) {
    throw new InputIssue('invalid-input', path, 'Expected a dense array without extra properties');
  }
}
function fixed6(value: unknown, path: string): Fixed6 {
  dense(value, path);
  if (!Array.isArray(value) || value.length !== 6) throw new InputIssue('invalid-input', path, 'Expected six fixed flags');
  const values: unknown[] = Array.from(value);
  const [a, b, c, d, e, f] = values;
  if (typeof a !== 'boolean' || typeof b !== 'boolean' || typeof c !== 'boolean' || typeof d !== 'boolean'
    || typeof e !== 'boolean' || typeof f !== 'boolean' || !(a || b || c || d || e || f)) {
    throw new InputIssue('invalid-input', path, 'At least one explicit fixed degree of freedom is required');
  }
  return [a, b, c, d, e, f];
}
function savedOrigin(value: unknown, kind: 'edge' | 'vertex', path: string): ShellSupportOrigin {
  if (!isSubShapeOrigin(value) || value.shapeKind !== kind) throw new InputIssue('invalid-input', path, 'Expected matching semantic origin');
  return structuredClone(value);
}
function key(value: unknown): string {
  return JSON.stringify(value, (_key: string, row: unknown): unknown => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
    return Object.fromEntries(Object.entries(row).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}
function noDuplicates(origins: readonly SubShapeOrigin[], path: string): void {
  if (new Set(origins.map(key)).size !== origins.length) throw new InputIssue('duplicate-id', path, 'Duplicate semantic reference');
}
function triple(value: unknown, path: string): Vector3 { dense(value, path); return vector(value, path); }

/** A complete input only; old shell-cad idealization remains a separate, unchanged schema. */
export function readShellCadAnalysisInput(value: unknown, path = 'shell-cad-analysis'): ShellCadAnalysisInput {
  const row = fields(value, ['schema', 'id', 'source', 'geometry', 'material', 'supports', 'edgeLoads', 'surface'], path);
  if (row.schema !== SHELL_CAD_ANALYSIS_SCHEMA || row.id !== 'shell-cad-analysis') throw new InputIssue('unsupported-schema', path, 'Unsupported shell analysis version');
  const source = fields(row.source, ['documentId'], `${path}.source`);
  const documentId = text(source.documentId, `${path}.source.documentId`);
  const geometry = readShellCadInput(row.geometry, `${path}.geometry`);
  if (geometry.source.documentId !== documentId) throw new InputIssue('wrong-document', path, 'Shell geometry belongs to a different document');
  const faces = geometry.midsurfaceFaces.map((entry, index) => {
    let parsed: unknown;
    try { parsed = JSON.parse(entry); } catch { throw new InputIssue('invalid-input', path, `Invalid midsurface key ${index}`); }
    const reference = fields(parsed, ['bodyFeatureId', 'origin'], `${path}.geometry.midsurfaceFaces[${index}]`);
    if (reference.bodyFeatureId !== geometry.bodyFeatureId || !isSubShapeOrigin(reference.origin) || reference.origin.shapeKind !== 'face')
      throw new InputIssue('invalid-input', path, 'Midsurface must name a face of the selected body');
    if (entry !== key(reference)) throw new InputIssue('invalid-input', path, 'Midsurface key must use the canonical origin representation');
    return reference.origin;
  });
  noDuplicates(faces, `${path}.geometry.midsurfaceFaces`);
  const mat = fields(row.material, ['id', 'youngMPa', 'poisson', 'source'], `${path}.material`);
  const poisson = number(mat.poisson, `${path}.material.poisson`);
  if (poisson <= -1 || poisson >= 0.5) throw new InputIssue('invalid-input', path, 'Poisson ratio must be between -1 and 0.5');
  const material = { id: text(mat.id, `${path}.material.id`), youngMPa: number(mat.youngMPa, `${path}.material.youngMPa`, true),
    poisson, source: propertySource(mat.source, `${path}.material.source`) };
  dense(row.supports, `${path}.supports`); dense(row.edgeLoads, `${path}.edgeLoads`);
  const supports = list<ShellCadAnalysisInput['supports'][number]>(row.supports, `${path}.supports`, 2048, (item, at) => {
    const data = fields(item, ['kind', 'origin', 'fixed'], at);
    if (data.kind !== 'edge' && data.kind !== 'vertex') throw new InputIssue('invalid-input', at, 'Expected edge or vertex support');
    return { kind: data.kind, origin: savedOrigin(data.origin, data.kind, `${at}.origin`), fixed: fixed6(data.fixed, `${at}.fixed`) };
  });
  const edgeLoads = list<ShellCadAnalysisInput['edgeLoads'][number]>(row.edgeLoads, `${path}.edgeLoads`, 2048, (item, at) => {
    const data = fields(item, ['origin', 'forceNPerMm', 'momentNmmPerMm'], at);
    const origin = savedOrigin(data.origin, 'edge', `${at}.origin`);
    if (origin.shapeKind !== 'edge') throw new InputIssue('invalid-input', at, 'Expected edge');
    return { origin, forceNPerMm: triple(data.forceNPerMm, `${at}.forceNPerMm`), momentNmmPerMm: triple(data.momentNmmPerMm, `${at}.momentNmmPerMm`) };
  });
  if (supports.length === 0) throw new InputIssue('invalid-input', path, 'At least one support is required');
  noDuplicates(supports.map(item => item.origin), `${path}.supports`); noDuplicates(edgeLoads.map(item => item.origin), `${path}.edgeLoads`);
  const surf = fields(row.surface, ['linearDeflection', 'angularDeflection', 'maximumNodes', 'maximumTriangles',
    'minimumTriangleAreaMm2', 'minimumAngleDeg', 'maximumAspectRatio'], `${path}.surface`);
  const surface = { linearDeflection: number(surf.linearDeflection, path, true), angularDeflection: number(surf.angularDeflection, path, true),
    maximumNodes: number(surf.maximumNodes, path), maximumTriangles: number(surf.maximumTriangles, path),
    minimumTriangleAreaMm2: number(surf.minimumTriangleAreaMm2, path), minimumAngleDeg: number(surf.minimumAngleDeg, path),
    maximumAspectRatio: number(surf.maximumAspectRatio, path) };
  if (!Number.isSafeInteger(surface.maximumNodes) || surface.maximumNodes < 3 || !Number.isSafeInteger(surface.maximumTriangles)
    || surface.maximumTriangles < 1 || surface.minimumTriangleAreaMm2 < 0 || surface.minimumAngleDeg < 0
    || surface.minimumAngleDeg > 60 || surface.maximumAspectRatio < 1) throw new InputIssue('invalid-input', path, 'Invalid shell surface quality settings');
  return { schema: SHELL_CAD_ANALYSIS_SCHEMA, id: 'shell-cad-analysis', source: { documentId }, geometry, material, supports, edgeLoads, surface };
}
