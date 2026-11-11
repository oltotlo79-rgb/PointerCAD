import type { AnalysisSource, PropertySource } from './analysisModel.js';
import { fields, InputIssue, number, propertySource, readAnalysisSource, revision, text } from './analysisValidation.js';

/** Explicit associations and material/section assumptions, never inferred from holes or rigid groups.
 * Only top-level occurrences in this first CAD boundary. No derived positions or results are saved. */
export interface CadAxialBolt {
  readonly id: string;
  readonly boltComponentId: string;
  readonly expectedPartKey: string;
  readonly expectedMaterialId: string | null;
  readonly first: { readonly memberId: string; readonly nodeId: string };
  readonly second: { readonly memberId: string; readonly nodeId: string };
  readonly youngMPa: number;
  readonly effectiveAreaMm2: number;
  readonly propertySource: PropertySource;
  readonly idealization: 'bilateral-uniform-axial-elastic';
}
export interface CadAxialBoltInputs {
  readonly schema: 'pointercad-cad-axial-bolts/1';
  readonly source: AnalysisSource;
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly bolts: readonly CadAxialBolt[];
}

/** Strict JSON boundary for a persisted association; consuming document integration is separate. */
export function readCadAxialBoltInputs(value: unknown): CadAxialBoltInputs {
  const row = fields(value, ['schema', 'source', 'analysisId', 'analysisRevision', 'bolts'], '$');
  if (row.schema !== 'pointercad-cad-axial-bolts/1') throw new InputIssue('bolt-schema', '$', 'Unknown axial bolt association');
  const rawBolts = row.bolts;
  if (!Array.isArray(rawBolts) || rawBolts.length < 1 || rawBolts.length > 64
    || Reflect.ownKeys(rawBolts).length !== rawBolts.length + 1
    || Array.from({ length: rawBolts.length }, (_, i) => Object.hasOwn(rawBolts, i)).some(present => !present)) {
    throw new InputIssue('bolt-count', 'bolts', 'Expected a dense list of 1 to 64 bolt associations');
  }
  const ids = new Set<string>(), components = new Set<string>();
  const endpoint = (value: unknown, path: string): CadAxialBolt['first'] => {
    const end = fields(value, ['memberId', 'nodeId'], path);
    return { memberId: text(end.memberId, path), nodeId: text(end.nodeId, path) };
  };
  const bolts = rawBolts.map((value: unknown, index): CadAxialBolt => {
    const path = `bolts[${index}]`;
    const bolt = fields(value, ['id', 'boltComponentId', 'expectedPartKey', 'expectedMaterialId', 'first', 'second',
      'youngMPa', 'effectiveAreaMm2', 'propertySource', 'idealization'], path);
    const id = text(bolt.id, path, 64), boltComponentId = text(bolt.boltComponentId, path);
    if (ids.has(id) || components.has(boltComponentId)) throw new InputIssue('bolt-duplicate', path, 'Bolt occurrence counted more than once');
    ids.add(id); components.add(boltComponentId);
    if (bolt.idealization !== 'bilateral-uniform-axial-elastic') throw new InputIssue('bolt-model', path, 'Unsupported joint behavior');
    const first = endpoint(bolt.first, path), second = endpoint(bolt.second, path);
    if (first.memberId === second.memberId || first.nodeId === second.nodeId) {
      throw new InputIssue('bolt-endpoint', path, 'Two distinct members and endpoint nodes required');
    }
    return { id, boltComponentId, expectedPartKey: text(bolt.expectedPartKey, path, 8192),
      expectedMaterialId: bolt.expectedMaterialId === null ? null : text(bolt.expectedMaterialId, path), first, second,
      youngMPa: number(bolt.youngMPa, path, true), effectiveAreaMm2: number(bolt.effectiveAreaMm2, path, true),
      propertySource: propertySource(bolt.propertySource, path), idealization: bolt.idealization };
  });
  return { schema: row.schema, source: readAnalysisSource(row.source, 'source'), analysisId: text(row.analysisId, 'analysisId'),
    analysisRevision: revision(row.analysisRevision, 'analysisRevision'), bolts };
}
