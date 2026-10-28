import type { AssemblyDocument, StandardBeamAdapterContext } from '@pointercad/model';
import { readBeamAnalysisInputs, type AnalysisSource } from '@pointercad/model/beam-analysis';
import { prepareCadBeamBoltContact } from './cadBeamBoltContact.js';
import { translateBeamBoltContact } from './beamBoltContact.js';
import type { CadNativeBoltPreloadInput } from '@pointercad/model/beam-analysis';
export type { CadNativeBoltPreloadInput } from '@pointercad/model/beam-analysis';
import { prepareNativeBoltPreload } from './nativeBoltPreload.js';
import type { NativeBoltPreloadWireInput } from './nativeBoltPreloadBinding.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Do not invoke getters, inherit keys, silently strip metadata or accept sparse arrays. */
function json(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error('cad-preload-json-depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null) throw new Error('cad-preload-json');
  if (Array.isArray(value)) {
    if (value.length > 4096 || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('cad-preload-array');
    for (let i = 0; i < value.length; i++) {
      const field = Object.getOwnPropertyDescriptor(value, String(i));
      if (field === undefined || !field.enumerable || !('value' in field)) throw new Error('cad-preload-array');
      json(field.value, depth + 1);
    }
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('cad-preload-object');
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || field === undefined || !field.enumerable || !('value' in field)) throw new Error('cad-preload-object');
    json(field.value, depth + 1);
  }
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!record(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('cad-preload-fields');
  return value;
}
function sameSource(value: unknown, current: AnalysisSource): boolean {
  const row = fields(value, ['documentId', 'documentRevision', 'geometryRevision']);
  return row.documentId === current.documentId && row.documentRevision === current.documentRevision && row.geometryRevision === current.geometryRevision;
}

/** Pure preparation; no Worker, native call, mutation, inferred material, torque conversion or
 * automatic coordinate rotation. Only the already-supported global-axis coaxial reduction.
 * Source matching authorizes which CAD data is read; the dedicated validator separately
 * proves 4 distinct nodes, two collinear members, the contact topology and exact support/load model.
 */
export async function prepareCadNativeBoltPreload(document: AssemblyDocument, definitionValue: unknown,
  value: unknown, context: StandardBeamAdapterContext) {
  json(value); json(definitionValue);
  const row = fields(value, ['schema', 'source', 'analysisId', 'analysisRevision', 'boltComponentId', 'contactId', 'memberIds', 'declaration']);
  if (row.schema !== 'pointercad-cad-native-bolt-preload/1' || !sameSource(row.source, context.currentSource)
    || context.currentSource.documentId !== document.id) throw new Error('cad-preload-owner');
  const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: definitionValue }] }, document.id);
  if (!checked.ok) throw new Error(`cad-preload-definition: ${checked.issue.code}`);
  const item = checked.value.analyses[0];
  if (item?.kind !== 'standard-members' || item.definition.schema !== 'pointercad-standard-beam/5') throw new Error('cad-preload-definition');
  const definition = item.definition, associations = definition.axialBolts;
  if (definition.id !== row.analysisId || definition.revision !== row.analysisRevision
    || !sameSource(definition.source, context.currentSource)) throw new Error('cad-preload-analysis-owner');
  if (definition.initialStrain !== undefined || definition.weldLayers !== undefined || definition.members.length !== 2
    || associations?.bolts.length !== 1 || definition.contact.segmentsPerMember !== 1
    || definition.contact.contacts.length !== 1) throw new Error('cad-preload-unsupported-model');
  const association = associations.bolts[0], pair = definition.contact.contacts[0];
  if (association.boltComponentId !== row.boltComponentId || pair.id !== row.contactId || pair.kind !== 'node-pair'
    || pair.gapMm !== 0) throw new Error('cad-preload-selection');
  if (!Array.isArray(row.memberIds) || row.memberIds.length !== 2
    || row.memberIds[0] !== association.first.memberId || row.memberIds[1] !== association.second.memberId
    || row.memberIds[0] === row.memberIds[1]) throw new Error('cad-preload-member-owner');
  // Actual catalog shaft, endpoint span, occurrence paths, revisions, E/A provenance and
  // current solved placements are checked by the existing CAD boundary, not by caller coordinates.
  const input = prepareCadBeamBoltContact(document, definition, associations, context);
  const { plan } = translateBeamBoltContact(input);
  const declaration = fields(row.declaration, ['boltId', 'model', 'modelSource', 'shankSource', 'shorteningSource', 'preloadN',
    'threadCompliance', 'headCompliance', 'bearingCompliance', 'memberCompliance', 'externalLoadsN', 'loadSource']);
  const shank = fields(declaration.shankSource, ['kind', 'reference', 'condition']);
  if (declaration.boltId !== association.id || shank.kind !== association.propertySource.kind
    || shank.reference !== association.propertySource.reference || shank.condition !== association.propertySource.condition) throw new Error('cad-preload-shank-provenance');
  const number = (key: string): number => {
    const field = fields(declaration[key], ['value', 'source']);
    if (typeof field.value !== 'number' || !Number.isFinite(field.value)) throw new Error('cad-preload-number');
    return field.value;
  };
  const bolt = plan.bolts[0], a = plan.contact.nodes[bolt.nodeA - 1].positionM, b = plan.contact.nodes[bolt.nodeB - 1].positionM;
  const lengthM = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  // Fi is prescribed; the locked stress-free shortening follows the explicitly selected
  // two-spring model. It is not read from, or written to, CadJointInitialStrain.
  const shorteningM = number('preloadN') * (lengthM / (bolt.youngPa * bolt.areaM2)
    + number('threadCompliance') + number('headCompliance') + number('bearingCompliance') + number('memberCompliance'));
  const prepared = await prepareNativeBoltPreload({ schema: 'pointercad-native-bolt-preload-plan/1', shorteningM,
    declaration: row.declaration, boltPlan: { ...plan, contact: { ...plan.contact,
      members: plan.contact.members.map(({ number, nodes, material, section, frame }) => ({ number, nodes, material, section, frame })) } } });
  const authored: CadNativeBoltPreloadInput = { schema: 'pointercad-cad-native-bolt-preload/1', source: { ...definition.source },
    analysisId: definition.id, analysisRevision: definition.revision, boltComponentId: association.boltComponentId,
    contactId: pair.id, memberIds: [association.first.memberId, association.second.memberId], declaration: prepared.plan.declaration };
  const wire: NativeBoltPreloadWireInput = { source: { documentId: document.id, revision: definition.source.documentRevision }, plan: prepared.plan };
  return { authored, wire, inputSha256: prepared.inputSha256,
    ownership: { source: { ...definition.source }, analysisId: definition.id, analysisRevision: definition.revision,
      boltComponentId: association.boltComponentId, memberIds: definition.members.map(member => member.id),
      nodeIds: input.contact.geometry.nodes.map(node => node.id), contactId: pair.id },
    scope: 'selected-coaxial-axial-reduction' as const };
}
