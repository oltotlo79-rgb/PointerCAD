import type { AnalysisSource, PropertySource } from './analysisModel.js';
import { fields, InputIssue, number, propertySource, readAnalysisSource, revision, text } from './analysisValidation.js';

/** Explicit effective-layer assumptions and identities only; no saved derived frame or result. */
export interface CadWeldLayer {
  readonly id: string;
  readonly beadComponentId: string;
  readonly expectedPartKey: string;
  readonly expectedPlacementKey: string;
  readonly expectedMaterialId: string;
  readonly first: { readonly memberId: string; readonly nodeId: string };
  readonly second: { readonly memberId: string; readonly nodeId: string };
  readonly youngMPa: number;
  readonly poisson: number;
  readonly effectiveThroatMm: number;
  readonly complianceLengthMm: number;
  readonly propertySource: PropertySource;
  readonly idealization: 'rectangular-effective-elastic-throat';
}
export interface CadWeldLayerInputs {
  readonly schema: 'pointercad-cad-weld-layers/1';
  readonly source: AnalysisSource;
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly welds: readonly CadWeldLayer[];
}
export function readCadWeldLayerInputs(value: unknown): CadWeldLayerInputs {
  const root = fields(value, ['schema', 'source', 'analysisId', 'analysisRevision', 'welds'], '$');
  if (root.schema !== 'pointercad-cad-weld-layers/1') throw new InputIssue('weld-schema', '$', 'Unknown effective weld layer association');
  const rows = root.welds;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 64 || Reflect.ownKeys(rows).length !== rows.length + 1
    || Array.from({ length: rows.length }, (_, i) => Object.hasOwn(rows, i)).some(p => !p)) {
    throw new InputIssue('weld-count', 'welds', 'Dense list of 1 to 64 associations required');
  }
  const ids = new Set<string>(), beads = new Set<string>();
  const endpoint = (raw: unknown): CadWeldLayer['first'] => {
    const row = fields(raw, ['memberId', 'nodeId'], 'endpoint');
    return { memberId: text(row.memberId, 'endpoint'), nodeId: text(row.nodeId, 'endpoint') };
  };
  const welds = rows.map((raw: unknown): CadWeldLayer => {
    const row = fields(raw, ['id', 'beadComponentId', 'expectedPartKey', 'expectedPlacementKey', 'expectedMaterialId',
      'first', 'second', 'youngMPa', 'poisson', 'effectiveThroatMm', 'complianceLengthMm', 'propertySource', 'idealization'], 'welds');
    const id = text(row.id, 'id', 64), beadComponentId = text(row.beadComponentId, 'beadComponentId');
    const first = endpoint(row.first), second = endpoint(row.second);
    // A bead id is local to its owning document: the same child bead is associated once per occurrence, through that
    // occurrence's own members. The physical identity is checked again with the occurrence prefix by prepareCadWeldLayers.
    const association = JSON.stringify([beadComponentId, first.memberId, second.memberId]);
    if (ids.has(id) || beads.has(association) || first.memberId === second.memberId || first.nodeId === second.nodeId) {
      throw new InputIssue('weld-duplicate', 'welds', 'Distinct members and unique physical bead associations required');
    }
    ids.add(id); beads.add(association);
    const poisson = number(row.poisson, 'poisson');
    if (poisson < 0 || poisson >= .5 || row.idealization !== 'rectangular-effective-elastic-throat') {
      throw new InputIssue('weld-model', 'welds', 'Only the declared isotropic effective elastic layer is supported');
    }
    return { id, beadComponentId, expectedPartKey: text(row.expectedPartKey, 'expectedPartKey', 8192),
      expectedPlacementKey: text(row.expectedPlacementKey, 'expectedPlacementKey', 8192),
      expectedMaterialId: text(row.expectedMaterialId, 'expectedMaterialId'), first, second,
      youngMPa: number(row.youngMPa, 'youngMPa', true), poisson,
      effectiveThroatMm: number(row.effectiveThroatMm, 'effectiveThroatMm', true),
      complianceLengthMm: number(row.complianceLengthMm, 'complianceLengthMm', true),
      propertySource: propertySource(row.propertySource, 'propertySource'), idealization: row.idealization };
  });
  return { schema: root.schema, source: readAnalysisSource(root.source, 'source'),
    analysisId: text(root.analysisId, 'analysisId'), analysisRevision: revision(root.analysisRevision, 'analysisRevision'), welds };
}
