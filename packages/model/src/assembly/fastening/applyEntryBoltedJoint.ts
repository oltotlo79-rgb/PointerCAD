/** Apply an entry-aware plan without extending the saved source or legacy operation unions. */
import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { joinRigidGroup } from '../rigidGroups.js';
import type { AssemblyDocument } from '../types.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { SOCKET_HEAD_CAP_SCREW_FAMILY } from '../catalog/families/socketHeadCapScrew.js';
import { COUNTERSUNK_SOCKET_SCREW_FAMILY } from '../catalog/families/countersunkSocketScrew.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { applyBoltedJoint, type ApplyBoltedJointResult } from './applyBoltedJoint.js';
import type { EntryBoltedJointPlan } from './holeEntryTypes.js';

function boltPart(source: StandardPartSource) {
  const family = [SOCKET_HEAD_CAP_SCREW_FAMILY, COUNTERSUNK_SOCKET_SCREW_FAMILY].find(entry => entry.id === source.options.family);
  const row = family?.rows.find(entry => entry.key === source.options.item && entry.size === source.size);
  if (family === undefined || row === undefined || source.catalog !== 'catalogItem') return null;
  const values = { length: source.options.length ?? '' };
  const expected = createCatalogItemSource(family, row, values);
  if (source.catalogRevision !== expected.catalogRevision || source.generatorRevision !== expected.generatorRevision
    || Object.keys(source.options).length !== Object.keys(expected.options).length
    || Object.entries(expected.options).some(([key, value]) => source.options[key] !== value)) return null;
  return family.build(row, values);
}

export function applyEntryBoltedJoint(document: AssemblyDocument, plan: EntryBoltedJointPlan,
  partRevisions: ReadonlyMap<string, string> = new Map()): ApplyBoltedJointResult {
  const bolt = plan.bolt;
  if (bolt === undefined) return applyBoltedJoint(document, plan.joint, partRevisions);
  const part = boltPart(bolt.source);
  if (part === null) return { ok: false, document, rejections: [{ code: 'boltRowMissing', detail: { size: bolt.source.size } }] };
  const applied = applyBoltedJoint(document, plan.joint, partRevisions);
  if (!applied.ok) return applied;
  const component = createComponentFor(applied.document, bolt.source, { partName: part.name, placement: bolt.placement });
  const componentIds = [...applied.componentIds, component.id];
  const next = joinRigidGroup(addComponent(applied.document, component),
    [plan.joint.headSideComponentId, plan.joint.farSideComponentId, ...componentIds]);
  return { ok: true, document: next, componentIds };
}
