import type { AnalysisSource, PropertySource } from './analysisModel.js';
import type { StandardBeamContactDefinition } from './beamInputs.js';
import { InputIssue, number, propertySource, readAnalysisSource, revision, text } from './analysisValidation.js';

interface SourcedNumber { readonly value: number; readonly source: PropertySource }
export interface BoltPreloadDeclaration {
  readonly boltId: string;
  /** Selected-bolt reduction only. External force acts at the two outer loading planes. */
  readonly model: 'coaxial-outer-planes-series-bearing';
  readonly modelSource: PropertySource;
  readonly shankSource: PropertySource;
  readonly shorteningSource: PropertySource;
  readonly preloadN: SourcedNumber;
  /** All compliances are m/N. Thread, head and bearing act in series with the shank,
   * carry bolt tension, and must be excluded from the independently supplied member compliance. */
  readonly threadCompliance: SourcedNumber;
  readonly headCompliance: SourcedNumber;
  readonly bearingCompliance: SourcedNumber;
  readonly memberCompliance: SourcedNumber;
  /** Quasistatic tensile loads, in order, including unloading. No implicit load factors. */
  readonly externalLoadsN: readonly number[];
  readonly loadSource: PropertySource;
}
/** Authored SI inputs, not the old stress-free-shortening schema or a native result. */
export interface CadNativeBoltPreloadInput {
  readonly schema: 'pointercad-cad-native-bolt-preload/1';
  readonly source: AnalysisSource;
  readonly analysisId: string;
  readonly analysisRevision: number;
  readonly boltComponentId: string;
  readonly contactId: string;
  readonly memberIds: readonly [string, string];
  readonly declaration: BoltPreloadDeclaration;
}
export interface CadNativeBoltPreloadSavedInput {
  readonly schema: 'pointercad-cad-native-bolt-preload-saved/1';
  readonly id: string;
  readonly revision: number;
  readonly source: AnalysisSource;
  readonly cadDefinition: StandardBeamContactDefinition;
  readonly input: CadNativeBoltPreloadInput;
}
function fail(path: string, detail: string): never { throw new InputIssue('native-bolt-saved', path, detail); }
function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** Inspect descriptors before reading: no accessors, hidden/symbol keys, sparse arrays,
 * prototypes or non-JSON values can be silently normalized away. */
function json(v: unknown, path: string, depth = 0): void {
  if (depth > 64) fail(path, 'Input is too deeply nested');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number' && Number.isFinite(v)) return;
  if (typeof v !== 'object' || v === null) fail(path, 'Expected finite JSON data');
  if (Array.isArray(v)) {
    if (v.length > 4096 || Reflect.ownKeys(v).length !== v.length + 1) fail(path, 'Expected a bounded dense array');
    for (let i = 0; i < v.length; i++) {
      const d = Object.getOwnPropertyDescriptor(v, String(i));
      if (d === undefined || !d.enumerable || !('value' in d)) fail(path, 'Expected own array data');
      json(d.value, `${path}[${i}]`, depth + 1);
    }
    return;
  }
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail(path, 'Expected a plain object');
  for (const key of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (typeof key !== 'string' || d === undefined || !d.enumerable || !('value' in d)) fail(path, 'Expected own enumerable data fields');
    json(d.value, `${path}.${key}`, depth + 1);
  }
}
function exact(v: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!record(v) || Reflect.ownKeys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail(path, 'Unsupported or missing field');
  return v;
}
function nonnegative(v: unknown, path: string, positive = false): number {
  const n = number(v, path);
  if (n < 0 || (positive && n <= 1e-30)) fail(path, 'Expected a supported nonnegative/positive value');
  return n;
}
function sourced(v: unknown, path: string, positive = false): SourcedNumber {
  const r = exact(v, ['value', 'source'], path);
  return { value: nonnegative(r.value, path, positive), source: propertySource(r.source, `${path}.source`) };
}
function sourceEqual(a: AnalysisSource, b: AnalysisSource): boolean {
  return a.documentId === b.documentId && a.documentRevision === b.documentRevision && a.geometryRevision === b.geometryRevision;
}
export function readCadNativeBoltPreloadInput(v: unknown, path = 'native-bolt-preload.input'): CadNativeBoltPreloadInput {
  json(v, path);
  const r = exact(v, ['schema', 'source', 'analysisId', 'analysisRevision', 'boltComponentId', 'contactId', 'memberIds', 'declaration'], path);
  if (r.schema !== 'pointercad-cad-native-bolt-preload/1') fail(path, 'Unknown CAD preload input version');
  if (!Array.isArray(r.memberIds) || r.memberIds.length !== 2) fail(path, 'Expected two ordered member IDs');
  const memberIds: readonly [string, string] = [text(r.memberIds[0], path), text(r.memberIds[1], path)];
  if (memberIds[0] === memberIds[1]) fail(path, 'Member IDs must differ');
  const d = exact(r.declaration, ['boltId', 'model', 'modelSource', 'shankSource', 'shorteningSource', 'preloadN',
    'threadCompliance', 'headCompliance', 'bearingCompliance', 'memberCompliance', 'externalLoadsN', 'loadSource'], `${path}.declaration`);
  if (d.model !== 'coaxial-outer-planes-series-bearing') fail(path, 'Unsupported preload model');
  if (!Array.isArray(d.externalLoadsN) || d.externalLoadsN.length < 1 || d.externalLoadsN.length > 31) fail(path, 'Expected 1 to 31 explicit external states');
  const externalLoadsN = d.externalLoadsN.map((v: unknown) => {
    const n = nonnegative(v, path); if (n > 1e6) fail(path, 'External load exceeds the existing bound'); return n;
  });
  const declaration: BoltPreloadDeclaration = { boltId: text(d.boltId, path, 64), model: d.model,
    modelSource: propertySource(d.modelSource, path), shankSource: propertySource(d.shankSource, path),
    shorteningSource: propertySource(d.shorteningSource, path), preloadN: sourced(d.preloadN, path, true),
    threadCompliance: sourced(d.threadCompliance, path), headCompliance: sourced(d.headCompliance, path),
    bearingCompliance: sourced(d.bearingCompliance, path), memberCompliance: sourced(d.memberCompliance, path, true),
    externalLoadsN, loadSource: propertySource(d.loadSource, path) };
  return { schema: r.schema, source: readAnalysisSource(r.source, `${path}.source`), analysisId: text(r.analysisId, path),
    analysisRevision: revision(r.analysisRevision, path), boltComponentId: text(r.boltComponentId, path),
    contactId: text(r.contactId, path, 64), memberIds, declaration };
}

/** Internal composition: beamInputs binds its existing canonical contact reader.
 * The public saved-reader wrapper lives there; no runtime import cycle or FEM dependency.
 * This checks saved structure/identity, not real current CAD geometry or numerical stiffness.
 */
export function readCadNativeBoltPreloadSavedWithContactReader(v: unknown,
  readContact: (v: unknown, path: string) => StandardBeamContactDefinition,
  path: string): CadNativeBoltPreloadSavedInput {
  json(v, path);
  const r = exact(v, ['schema', 'id', 'revision', 'source', 'cadDefinition', 'input'], path);
  if (r.schema !== 'pointercad-cad-native-bolt-preload-saved/1') fail(path, 'Unknown saved preload version');
  const id = text(r.id, path), rev = revision(r.revision, path), source = readAnalysisSource(r.source, `${path}.source`);
  const cad = readContact(r.cadDefinition, `${path}.cadDefinition`), input = readCadNativeBoltPreloadInput(r.input, `${path}.input`);
  if (id !== cad.id || rev !== cad.revision || input.analysisId !== id || input.analysisRevision !== rev
    || !sourceEqual(source, cad.source) || !sourceEqual(source, input.source)) fail(path, 'Saved source or analysis identity disagrees');
  const associations = cad.axialBolts;
  if (cad.weldLayers !== undefined || cad.initialStrain !== undefined || cad.members.length !== 2
    || associations?.bolts.length !== 1 || cad.contact.segmentsPerMember !== 1 || cad.contact.contacts.length !== 1) fail(path, 'Unsupported saved idealization');
  const bolt = associations.bolts[0], pair = cad.contact.contacts[0];
  if (bolt.id !== input.declaration.boltId || bolt.boltComponentId !== input.boltComponentId
    || bolt.first.memberId !== input.memberIds[0] || bolt.second.memberId !== input.memberIds[1]
    || pair.id !== input.contactId || pair.kind !== 'node-pair' || pair.gapMm !== 0) fail(path, 'Saved bolt, member or contact identity disagrees');
  if (new Set([bolt.first.nodeId, bolt.second.nodeId, pair.nodeIdA, pair.nodeIdB]).size !== 4) fail(path, 'Four distinct endpoint IDs required');
  const edge = (a: string, b: string): string => JSON.stringify([a, b].sort());
  const expected = new Set([edge(bolt.first.nodeId, pair.nodeIdA), edge(pair.nodeIdB, bolt.second.nodeId)]);
  if (cad.members.some(m => !expected.has(edge(m.startNodeId, m.endNodeId)))) fail(path, 'Saved member/contact topology disagrees');
  const a = bolt.propertySource, b = input.declaration.shankSource;
  if (a.kind !== b.kind || a.reference !== b.reference || a.condition !== b.condition) fail(path, 'Shank provenance disagrees');
  const factors = [0, ...input.declaration.externalLoadsN];
  if (cad.contact.loadFactors.length !== factors.length || cad.contact.loadFactors.some((f, i) => f !== factors[i])) fail(path, 'External stage order disagrees');
  return { schema: r.schema, id, revision: rev, source, cadDefinition: cad, input };
}
