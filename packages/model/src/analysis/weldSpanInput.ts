import type { AnalysisSource } from './analysisModel.js';
import { fields, InputIssue, number, propertySource, readAnalysisSource, revision, text } from './analysisValidation.js';
import type { CadWeldLayer } from './weldLayerInput.js';
import { readCadWeldLayerInputs, type CadWeldLayerInputs } from './weldLayerInput.js';

export type CadWeldSpanSide =
  | { readonly kind: 'section-node'; readonly memberId: string; readonly nodeId: string }
  | { readonly kind: 'member-span'; readonly memberId: string };
export interface CadWeldSpanLayer extends Omit<CadWeldLayer, 'first' | 'second'> {
  readonly first: CadWeldSpanSide;
  readonly second: CadWeldSpanSide;
}
export interface CadWeldSpanInputs {
  readonly schema: 'pointercad-cad-weld-layers/2';
  readonly source: AnalysisSource;
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly welds: readonly CadWeldSpanLayer[];
}
export type SavedCadWeldInputs = CadWeldLayerInputs | CadWeldSpanInputs;

/** Check descriptors before reading values: unknown accessors and sparse arrays must never run as input. */
function plain(value: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 4096 || Reflect.ownKeys(value).length !== value.length + 1) return false;
    return Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, i))
      .every(d => d !== undefined && d.enumerable && 'value' in d && plain(d.value, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Reflect.ownKeys(value).every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && d !== undefined && d.enumerable && 'value' in d && plain(d.value, depth + 1);
  });
}
function strictFields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  const row = fields(value, names, path);
  if (Reflect.ownKeys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name))) {
    throw new InputIssue('shape', path, 'Unsupported or missing field');
  }
  return row;
}
function side(value: unknown): CadWeldSpanSide {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InputIssue('weld-side', 'side', 'Expected explicit weld side');
  const kind: unknown = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  if (kind === 'section-node') {
    const row = strictFields(value, ['kind', 'memberId', 'nodeId'], 'side');
    return { kind, memberId: text(row.memberId, 'side.memberId'), nodeId: text(row.nodeId, 'side.nodeId') };
  }
  if (kind === 'member-span') {
    const row = strictFields(value, ['kind', 'memberId'], 'side');
    return { kind, memberId: text(row.memberId, 'side.memberId') };
  }
  throw new InputIssue('weld-side', 'side', 'Unknown weld side');
}
export function readCadWeldSpanInputs(value: unknown): CadWeldSpanInputs {
  if (!plain(value)) throw new InputIssue('shape', '$', 'Plain dense weld input required');
  const root = strictFields(value, ['schema', 'source', 'analysisId', 'analysisRevision', 'welds'], '$');
  if (root.schema !== 'pointercad-cad-weld-layers/2') throw new InputIssue('weld-schema', '$', 'Expected weld span association version 2');
  if (!Array.isArray(root.welds) || root.welds.length < 1 || root.welds.length > 64) throw new InputIssue('weld-count', 'welds', 'Dense list of 1 to 64 associations required');
  const ids = new Set<string>(), beads = new Set<string>();
  const welds = root.welds.map((value: unknown): CadWeldSpanLayer => {
    const row = strictFields(value, ['id', 'beadComponentId', 'expectedPartKey', 'expectedPlacementKey', 'expectedMaterialId',
      'first', 'second', 'youngMPa', 'poisson', 'effectiveThroatMm', 'complianceLengthMm', 'propertySource', 'idealization'], 'welds');
    const id = text(row.id, 'id', 64), beadComponentId = text(row.beadComponentId, 'beadComponentId');
    const first = side(row.first), second = side(row.second);
    const association = JSON.stringify([beadComponentId, ...[first.memberId, second.memberId].sort()]);
    if (ids.has(id) || beads.has(association) || first.memberId === second.memberId
      || (first.kind === 'section-node' && second.kind === 'section-node' && first.nodeId === second.nodeId)) {
      throw new InputIssue('weld-duplicate', 'welds', 'Distinct members and unique physical bead associations required');
    }
    ids.add(id); beads.add(association);
    const poisson = number(row.poisson, 'poisson');
    if (poisson < 0 || poisson >= .5 || row.idealization !== 'rectangular-effective-elastic-throat') throw new InputIssue('weld-model', 'welds', 'Only isotropic effective elastic layers are supported');
    return { id, beadComponentId, expectedPartKey: text(row.expectedPartKey, 'expectedPartKey', 8192),
      expectedPlacementKey: text(row.expectedPlacementKey, 'expectedPlacementKey', 8192), expectedMaterialId: text(row.expectedMaterialId, 'expectedMaterialId'),
      first, second, youngMPa: number(row.youngMPa, 'youngMPa', true), poisson,
      effectiveThroatMm: number(row.effectiveThroatMm, 'effectiveThroatMm', true), complianceLengthMm: number(row.complianceLengthMm, 'complianceLengthMm', true),
      propertySource: propertySource(row.propertySource, 'propertySource'), idealization: row.idealization };
  });
  return { schema: root.schema, source: readAnalysisSource(root.source, 'source'), analysisId: text(root.analysisId, 'analysisId'),
    analysisRevision: revision(root.analysisRevision, 'analysisRevision'), welds };
}
export function readSavedCadWeldInputs(value: unknown): SavedCadWeldInputs {
  if (value === null || typeof value !== 'object') throw new InputIssue('weld-schema', '$', 'Unknown weld association');
  const schema = Object.getOwnPropertyDescriptor(value, 'schema');
  if (schema === undefined || !('value' in schema)) throw new InputIssue('weld-schema', '$', 'Unknown weld association');
  if (schema.value === 'pointercad-cad-weld-layers/1') return readCadWeldLayerInputs(value);
  if (schema.value === 'pointercad-cad-weld-layers/2') return readCadWeldSpanInputs(value);
  throw new InputIssue('weld-schema', '$', 'Unknown weld association');
}
