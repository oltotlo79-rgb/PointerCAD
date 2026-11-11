import { applyPlacementToDirection, applyPlacementToPoint } from '../assembly/placementMath.js';
import { resolveConstrainedAssembly } from '../assembly/resolveConstrainedAssembly.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import { buildStandardPartFromSource } from '../assembly/standard/buildStandardPart.js';
import type { AssemblyDocument } from '../assembly/types.js';
import type { BeamAnalysisDocument, Vector3 } from './analysisModel.js';
import { InputIssue } from './analysisValidation.js';
import { readBeamAnalysisInputs, type StandardBeamContactDefinition } from './beamInputs.js';
import { readCadAxialBoltInputs } from './axialBoltInput.js';
import { BEAM_CONNECTION_TOLERANCE_MM, standardMembersToBeamAnalysis, type StandardBeamAdapterContext } from './standardBeamAdapter.js';

export interface PreparedCadAxialBolt {
  readonly id: string; readonly nodeIdA: string; readonly nodeIdB: string;
  readonly youngPa: number; readonly areaM2: number;
}

/** Re-derives beam endpoints from CAD; caller-supplied solver coordinates are never trusted. */
export function prepareCadAxialBolts(document: AssemblyDocument, definitionValue: unknown,
  value: unknown, context: StandardBeamAdapterContext): { readonly geometry: BeamAnalysisDocument;
    readonly contact: StandardBeamContactDefinition; readonly bolts: readonly PreparedCadAxialBolt[] } {
  const saved = readCadAxialBoltInputs(value);
  const attachment = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
    analyses: [{ kind: 'standard-members', definition: definitionValue }] }, document.id);
  if (!attachment.ok) throw new InputIssue(attachment.issue.code, attachment.issue.path, attachment.issue.message);
  const item = attachment.value.analyses[0];
  if (item?.kind !== 'standard-members' || item.definition.schema !== 'pointercad-standard-beam/5') {
    throw new InputIssue('bolt-contact', '$', 'Existing saved CAD contact definition required');
  }
  const definition = item.definition;
  const checked = standardMembersToBeamAnalysis(document, {
    schema: 'pointercad-standard-beam/2', modal: { modeCount: 1, segmentsPerMember: definition.contact.segmentsPerMember },
    id: definition.id, revision: definition.revision, source: definition.source, units: definition.units,
    members: definition.members, materials: definition.materials, sections: definition.sections, constraints: [], loads: [],
  }, context);
  if (!checked.ok) throw new InputIssue(checked.issue.code, checked.issue.path, checked.issue.message);
  const geometry = checked.document;
  const sameSource = (source: typeof saved.source): boolean => source.documentId === document.id
    && source.documentId === context.currentSource.documentId
    && source.documentRevision === context.currentSource.documentRevision
    && source.geometryRevision === context.currentSource.geometryRevision;
  if (!sameSource(saved.source) || !sameSource(geometry.source) || geometry.id !== saved.analysisId
    || geometry.revision !== saved.analysisRevision || geometry.units !== 'N-mm') {
    throw new InputIssue('stale-source', 'source', 'Bolt associations and beam geometry must belong to the current CAD analysis');
  }
  const solved = resolveConstrainedAssembly(document, context.bodies, { ...context.assemblyOptions, standardPart: buildStandardPartFromSource });
  if (!solved.ok) throw new InputIssue('unresolved-assembly', '$', 'Current CAD constraints must resolve before joint analysis');
  const component = (id: string) => {
    const rows = document.components.filter(row => row.id === id && !row.suppressed);
    if (rows.length !== 1) throw new InputIssue('bolt-owner', id, 'Missing, ambiguous or suppressed top-level occurrence');
    return rows[0];
  };
  const endpoint = (memberId: string, nodeId: string): { point: Vector3; owner: string; path: readonly string[] | null } => {
    const rows = geometry.members.filter(row => row.id === memberId), member = rows[0];
    if (rows.length !== 1 || member === undefined || member.occurrencePath.length < 1
      || member.occurrencePath[member.occurrencePath.length - 1] !== member.componentId || ![member.startNodeId, member.endNodeId].includes(nodeId)
      || member.cadSource === undefined) throw new InputIssue('bolt-owner', memberId, 'Explicit current CAD member endpoint required');
    if (member.occurrencePath.length > 1) {
      // A nested leaf: standardMembersToBeamAnalysis already validated the exact path (source, ancestors, suppression,
      // solved part key) and produced solved WORLD node positions. The owner is the exact leaf path, never its root.
      const nested = geometry.nodes.find(node => node.id === nodeId)?.position;
      if (nested === undefined) throw new InputIssue('bolt-endpoint', nodeId, 'Missing beam endpoint');
      return { point: nested, owner: JSON.stringify(member.occurrencePath), path: member.occurrencePath };
    }
    const owner = component(member.componentId), key = partKeyOf(owner.source);
    if (member.cadSource.expectedPartKey !== key || solved.resolved.partKeys.get(owner.id) !== key) {
      throw new InputIssue('stale-source', memberId, 'Beam occurrence source changed');
    }
    const point = geometry.nodes.find(node => node.id === nodeId)?.position;
    if (point === undefined) throw new InputIssue('bolt-endpoint', nodeId, 'Missing beam endpoint');
    return { point, owner: owner.id, path: null };
  };
  const bolts = saved.bolts.map(bolt => {
    const owner = component(bolt.boltComponentId), source = owner.source;
    if (source.kind !== 'standardPart' || source.catalog !== 'hexBolt' || partKeyOf(source) !== bolt.expectedPartKey
      || solved.resolved.partKeys.get(owner.id) !== bolt.expectedPartKey
      || (owner.materialId ?? null) !== bolt.expectedMaterialId) {
      throw new InputIssue('stale-bolt', bolt.id, 'Selected bolt source or material assignment changed');
    }
    const first = endpoint(bolt.first.memberId, bolt.first.nodeId), second = endpoint(bolt.second.memberId, bolt.second.nodeId);
    if (first.owner === second.owner || first.owner === owner.id || second.owner === owner.id) {
      throw new InputIssue('bolt-owner', bolt.id, 'Bolt must connect two separately owned member endpoints');
    }
    if (first.path !== null || second.path !== null) {
      // Root decision (task100): the saved joint occurrence connection is the only mapping from a root-generated bolt to
      // nested leaves. Exactly one connection may contain the bolt, it must be a complete bolt connection of current
      // unsuppressed root components, and its two saved paths must be exactly the two selected member paths.
      const firstPath = first.path ?? [first.owner], secondPath = second.path ?? [second.owner];
      const same = (a: readonly string[], b: readonly string[]): boolean => JSON.stringify(a) === JSON.stringify(b);
      const containing = (document.jointOccurrenceConnections ?? []).filter(row => row.componentIds.includes(owner.id));
      const connection = containing[0];
      if (containing.length !== 1 || connection === undefined || connection.kind !== 'bolt'
        || new Set(connection.componentIds).size !== connection.componentIds.length
        || connection.componentIds.some(id => document.components.filter(row => row.id === id && !row.suppressed).length !== 1)
        || !((same(connection.firstPath, firstPath) && same(connection.secondPath, secondPath))
          || (same(connection.firstPath, secondPath) && same(connection.secondPath, firstPath)))) {
        throw new InputIssue('bolt-association', bolt.id, 'Nested bolt endpoints require exactly one complete saved bolt connection on the selected leaf paths');
      }
    }
    const generated = buildStandardPartFromSource(source);
    const shaft = generated?.solids.find(feature => feature.kind === 'primitive' && feature.shape.kind === 'cylinder');
    const placement = solved.resolved.placements.get(owner.id);
    if (shaft?.kind !== 'primitive' || shaft.shape.kind !== 'cylinder' || placement === undefined) {
      throw new InputIssue('bolt-geometry', bolt.id, 'Actual generated bolt shaft unavailable');
    }
    const radius = shaft.shape.radius.value, length = shaft.shape.height.value;
    const origin = applyPlacementToPoint(placement, [0, 0, 0]);
    const axis = applyPlacementToDirection(placement, [0, 0, 1]);
    for (const point of [first.point, second.point]) {
      const delta = point.map((v, i) => v - origin[i]);
      const along = delta.reduce((sum, v, i) => sum + v * axis[i], 0);
      const radial = Math.hypot(...delta.map((v, i) => v - along * axis[i]));
      if (radial > BEAM_CONNECTION_TOLERANCE_MM || along < -BEAM_CONNECTION_TOLERANCE_MM
        || along > length + BEAM_CONNECTION_TOLERANCE_MM) {
        throw new InputIssue('bolt-axis', bolt.id, 'Beam endpoints must lie on the actual bolt shaft axis and span');
      }
    }
    const span = Math.hypot(...first.point.map((v, i) => v - second.point[i]));
    const youngPa = bolt.youngMPa * 1e6, areaM2 = bolt.effectiveAreaMm2 * 1e-6;
    if (!(span > 1e-6) || !(radius > 0) || bolt.effectiveAreaMm2 > Math.PI * radius * radius
      || !Number.isFinite(youngPa) || youngPa > 1e30 || !(areaM2 > 1e-30)) {
      throw new InputIssue('bolt-section', bolt.id, 'Finite axial span and explicit effective area within the nominal shank are required');
    }
    return { id: bolt.id, nodeIdA: bolt.first.nodeId, nodeIdB: bolt.second.nodeId, youngPa, areaM2 };
  });
  return { geometry, contact: definition, bolts };
}
