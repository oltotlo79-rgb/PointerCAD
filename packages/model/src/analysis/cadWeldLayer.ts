import { expressionValueFromNumber } from '@pointercad/expression';
import { applyPlacementToDirection, applyPlacementToPoint } from '../assembly/placementMath.js';
import { placementFingerprint } from '../assembly/fastening/frames.js';
import { resolveConstrainedAssembly } from '../assembly/resolveConstrainedAssembly.js';
import { partKeyOf, type ResolvedAssembly } from '../assembly/resolveAssembly.js';
import { buildStandardPartFromSource } from '../assembly/standard/buildStandardPart.js';
import { filletWeldLegs, filletWeldSegmentOptions } from '../assembly/welding/filletWeldPart.js';
import { planFilletWeldEdit, weldSegmentsOf } from '../assembly/welding/planFilletWeld.js';
import { previewOccurrenceFilletWeldEdit } from '../assembly/welding/bindWeldSelection.js';
import type { AssemblyDocument } from '../assembly/types.js';
import type { BeamAnalysisDocument, Vector3 } from './analysisModel.js';
import { InputIssue } from './analysisValidation.js';
import { readBeamAnalysisInputs, type StandardBeamContactDefinition } from './beamInputs.js';
import { readCadWeldLayerInputs } from './weldLayerInput.js';
import { readCadWeldSpanInputs, type CadWeldSpanSide, type SavedCadWeldInputs } from './weldSpanInput.js';
import { cadWeldThroatFrame } from './cadWeldThroatFrame.js';
import { BEAM_CONNECTION_TOLERANCE_MM, standardMembersToBeamAnalysis, type StandardBeamAdapterContext } from './standardBeamAdapter.js';

export interface PreparedCadWeldLayer {
  readonly id: string; readonly nodeIdA: string; readonly nodeIdB: string;
  readonly centerM: Vector3; readonly normal: Vector3; readonly along: Vector3;
  readonly widthM: number; readonly lengthM: number; readonly thicknessM: number;
  readonly youngPa: number; readonly poisson: number;
}

/**
 * Where a weld group lives. Top-level groups use the root document; a child-owned group lives in the child document at
 * one exact occurrence prefix, so repeated instances of the same child never share a local bead lookup.
 */
interface WeldScope {
  readonly key: string;
  readonly prefix: readonly string[];
  readonly document: AssemblyDocument;
  readonly solved: ResolvedAssembly;
}

 interface PreparedCadWeldSpanLayer extends Omit<PreparedCadWeldLayer, 'nodeIdA' | 'nodeIdB'> {
  readonly first: CadWeldSpanSide; readonly second: CadWeldSpanSide;
}

/** Legacy endpoint-only entry: no version coercion and no output-shape change. */
export function prepareCadWeldLayers(document: AssemblyDocument, definitionValue: unknown, value: unknown,
  context: StandardBeamAdapterContext): { readonly geometry: BeamAnalysisDocument;
    readonly contact: StandardBeamContactDefinition; readonly welds: readonly PreparedCadWeldLayer[] } {
  const prepared = prepareCadWeldLayersOwned(document, definitionValue, readCadWeldLayerInputs(value), context);
  return { ...prepared, welds: prepared.welds.map(w => {
    const { id, first, second, ...geometry } = w;
    if (first.kind !== 'section-node' || second.kind !== 'section-node') throw new InputIssue('weld-owner', id, 'Original endpoint sections required');
    return { id, nodeIdA: first.nodeId, nodeIdB: second.nodeId, ...geometry };
  }) };
}

/** Explicit saved /2 sides; a span is never represented by an invented endpoint. */
export function prepareCadWeldSpanLayers(document: AssemblyDocument, definitionValue: unknown, value: unknown,
  context: StandardBeamAdapterContext): { readonly geometry: BeamAnalysisDocument;
    readonly contact: StandardBeamContactDefinition; readonly welds: readonly PreparedCadWeldSpanLayer[] } {
  return prepareCadWeldLayersOwned(document, definitionValue, readCadWeldSpanInputs(value), context);
}

function prepareCadWeldLayersOwned(document: AssemblyDocument, definitionValue: unknown, saved: SavedCadWeldInputs,
  context: StandardBeamAdapterContext): { readonly geometry: BeamAnalysisDocument;
    readonly contact: StandardBeamContactDefinition; readonly welds: readonly PreparedCadWeldSpanLayer[] } {
  const spanRoute = saved.schema === 'pointercad-cad-weld-layers/2';
  if (spanRoute && definitionValue !== null && typeof definitionValue === 'object'
    && (Object.hasOwn(definitionValue, 'axialBolts') || Object.hasOwn(definitionValue, 'initialStrain'))) {
    throw new InputIssue('weld-span-unsupported', '$', 'Span solver does not support bolt or initial-strain combinations');
  }
  type SavedSide = SavedCadWeldInputs['welds'][number]['first'];
  const explicitSide = (side: SavedSide): CadWeldSpanSide => 'kind' in side ? side : { kind: 'section-node', ...side };
  const sideKey = (side: SavedSide): string => {
    const s = explicitSide(side);
    return JSON.stringify(s.kind === 'section-node' ? [s.kind, s.memberId, s.nodeId] : [s.kind, s.memberId]);
  };
  const read = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: definitionValue }] }, document.id);
  if (!read.ok) throw new InputIssue(read.issue.code, read.issue.path, read.issue.message);
  const item = read.value.analyses[0];
  if (item?.kind !== 'standard-members' || item.definition.schema !== 'pointercad-standard-beam/5') throw new InputIssue('weld-contact', '$', 'Current CAD contact definition required');
  const definition = item.definition;
  if (!spanRoute && definition.weldLayers?.schema === 'pointercad-cad-weld-layers/2') throw new InputIssue('weld-span-unsupported', 'weldLayers', 'Span weld requires its own solver route');
  if (spanRoute && definition.weldLayers !== undefined && (definition.weldLayers.schema !== 'pointercad-cad-weld-layers/2'
    || JSON.stringify(definition.weldLayers) !== JSON.stringify(saved))) throw new InputIssue('weld-association', 'weldLayers', 'Saved span input must match the current definition');
  const checked = standardMembersToBeamAnalysis(document, { schema: 'pointercad-standard-beam/2',
    modal: { modeCount: 1, segmentsPerMember: definition.contact.segmentsPerMember },
    id: definition.id, revision: definition.revision, source: definition.source, units: definition.units,
    members: definition.members, materials: definition.materials, sections: definition.sections, constraints: [], loads: [] }, context);
  if (!checked.ok) throw new InputIssue(checked.issue.code, checked.issue.path, checked.issue.message);
  const geometry = checked.document;
  if (saved.source.documentId !== document.id || saved.source.documentId !== context.currentSource.documentId
    || saved.source.documentRevision !== context.currentSource.documentRevision || saved.source.geometryRevision !== context.currentSource.geometryRevision
    || saved.analysisId !== geometry.id || saved.analysisRevision !== geometry.revision || geometry.units !== 'N-mm') {
    throw new InputIssue('stale-source', 'source', 'Weld and beam associations must belong to current CAD geometry');
  }
  const solved = resolveConstrainedAssembly(document, context.bodies, { ...context.assemblyOptions, standardPart: buildStandardPartFromSource });
  if (!solved.ok) throw new InputIssue('unresolved-assembly', '$', 'Current assembly must resolve');
  // Existing weld footprint revalidation reads component placements. Supply actual solved world poses, once.
  const world: AssemblyDocument = { ...document, components: document.components.map((component): AssemblyDocument['components'][number] => {
    const pose = solved.resolved.placements.get(component.id);
    return pose === undefined ? component : { ...component, placement: { rotation: pose.rotation,
      position: [expressionValueFromNumber(pose.position[0]), expressionValueFromNumber(pose.position[1]), expressionValueFromNumber(pose.position[2])] } };
  }) };
  const rootScope: WeldScope = { key: '[]', prefix: [], document, solved: solved.resolved };
  /** The child document and solved view at one exact occurrence prefix (ancestors unique, unsuppressed, subassemblies). */
  const childScope = (prefix: readonly string[], id: string): WeldScope => {
    let current = document, view = solved.resolved;
    for (const step of prefix) {
      const rows = current.components.filter(c => c.id === step && !c.suppressed), row = rows[0];
      const nested = row?.source.kind === 'subAssembly' ? context.assemblyOptions.subAssemblies?.get(row.source.assemblyRef) : undefined;
      const nestedView = view.subAssemblies?.get(step)?.resolved;
      if (rows.length !== 1 || nested === undefined || nestedView === undefined) {
        throw new InputIssue('weld-owner', id, 'Exact current child occurrence of the weld group required');
      }
      current = nested; view = nestedView;
    }
    return { key: JSON.stringify(prefix), prefix, document: current, solved: view };
  };
  const component = (scope: WeldScope, id: string) => {
    const matches = scope.document.components.filter(c => c.id === id && !c.suppressed);
    if (matches.length !== 1) throw new InputIssue('weld-owner', id, 'Current unique top-level occurrence required');
    return matches[0];
  };
  const memberPath = (memberId: string): readonly string[] | null => {
    const matches = geometry.members.filter(m => m.id === memberId);
    return matches.length === 1 && matches[0] !== undefined ? matches[0].occurrencePath : null;
  };
  const endpoint = (side: SavedSide) => {
    const ownedSide = explicitSide(side), memberId = ownedSide.memberId;
    const nodeId = ownedSide.kind === 'section-node' ? ownedSide.nodeId : undefined;
    const matches = geometry.members.filter(m => m.id === memberId), m = matches[0];
    if (matches.length !== 1 || m === undefined || m.occurrencePath.length < 1
      || m.occurrencePath[m.occurrencePath.length - 1] !== m.componentId
      || (nodeId !== undefined && ![m.startNodeId, m.endNodeId].includes(nodeId)) || m.cadSource === undefined) throw new InputIssue('weld-owner', memberId, 'Owned original member endpoint required');
    // Nested leaf: path, ancestors, suppression and solved part key were validated by standardMembersToBeamAnalysis and
    // its node positions are solved WORLD positions (no second parent composition). Owner = exact leaf path.
    const nestedPath = m.occurrencePath.length > 1 ? m.occurrencePath : null;
    const owner = nestedPath === null ? component(rootScope, m.componentId) : null;
    if (owner !== null && (m.cadSource.expectedPartKey !== partKeyOf(owner.source)
      || solved.resolved.partKeys.get(owner.id) !== m.cadSource.expectedPartKey)) throw new InputIssue('stale-source', memberId, 'Member source changed');
    const a = geometry.nodes.find(n => n.id === m.startNodeId), b = geometry.nodes.find(n => n.id === m.endNodeId);
    if (a === undefined || b === undefined) throw new InputIssue('weld-endpoint', nodeId ?? memberId, 'Missing endpoint');
    const span: Vector3 = [b.position[0]-a.position[0], b.position[1]-a.position[1], b.position[2]-a.position[2]];
    const length = Math.hypot(...span);
    if (!(length > BEAM_CONNECTION_TOLERANCE_MM)) throw new InputIssue('weld-endpoint', nodeId ?? memberId, 'Degenerate member');
    return { owner: owner === null ? JSON.stringify(nestedPath) : owner.id, path: nestedPath,
      kind: ownedSide.kind, length,
      point: ownedSide.kind === 'member-span' || nodeId === a.id ? a.position : b.position,
      axis: [span[0]/length, span[1]/length, span[2]/length] as Vector3 };
  };
  /** A child-owned group: both endpoint members are leaves of the SAME occurrence prefix. */
  const sharedPrefix = (first: readonly string[] | null, second: readonly string[] | null): readonly string[] | null => {
    if (first === null || second === null || first.length !== second.length) return null;
    const a = first.slice(0, -1), b = second.slice(0, -1);
    return JSON.stringify(a) === JSON.stringify(b) ? a : null;
  };
  const scopeKeyOf = (weld: (typeof saved.welds)[number]): string => {
    const prefix = sharedPrefix(memberPath(weld.first.memberId), memberPath(weld.second.memberId));
    return JSON.stringify([prefix ?? [], weld.beadComponentId]);
  };
  const associations = new Map(saved.welds.map(weld => [scopeKeyOf(weld), weld]));
  if (associations.size !== saved.welds.length) {
    throw new InputIssue('weld-duplicate', 'welds', 'Distinct members and unique physical bead associations required');
  }
  const verifiedGroups = new Set<string>();
  const pairGroups = new Map<string, string>();
  const welds = saved.welds.map(weld => {
    const first = endpoint(weld.first), second = endpoint(weld.second);
    const childPrefix = sharedPrefix(first.path, second.path);
    const scope = childPrefix === null ? rootScope : childScope(childPrefix, weld.id);
    const bead = component(scope, weld.beadComponentId), source = bead.source;
    if (source.kind !== 'standardPart' || source.catalog !== 'filletWeld' || partKeyOf(source) !== weld.expectedPartKey
      || scope.solved.partKeys.get(bead.id) !== weld.expectedPartKey || bead.materialId !== weld.expectedMaterialId
      || placementFingerprint(bead.placement) !== weld.expectedPlacementKey || buildStandardPartFromSource(source) === null) {
      throw new InputIssue('stale-weld', weld.id, 'Weld source, material or placement changed');
    }
    const options = filletWeldSegmentOptions(source.options), legs = filletWeldLegs(source.size);
    if (options === null || legs === null) {
      throw new InputIssue('weld-scope', weld.id, 'Valid saved straight-extruded bead groups required');
    }
    const rootConnected = childPrefix === null && (first.path !== null || second.path !== null);
    if (childPrefix !== null) {
      // Child-owned group: the child's own weldParts name its own leaf components, in saved order.
      if (first.path?.[first.path.length - 1] !== options.parts[0] || second.path?.[second.path.length - 1] !== options.parts[1]
        || options.parts[0] === options.parts[1]) {
        throw new InputIssue('weld-owner', weld.id, 'Endpoint leaves must be the two welded parts recorded by the child-owned group, in order');
      }
    } else if (!rootConnected) {
      if (first.owner !== options.parts[0] || second.owner !== options.parts[1] || first.owner === second.owner) throw new InputIssue('weld-owner', weld.id, 'Endpoint owners must match the two recorded welded parts in order');
    } else {
      // Root decision (task100/101): the saved connection maps root motion owners (weldParts, unchanged) to leaves.
      const firstPath = first.path ?? [first.owner], secondPath = second.path ?? [second.owner];
      const same = (x: readonly string[], y: readonly string[]): boolean => JSON.stringify(x) === JSON.stringify(y);
      const containing = (document.jointOccurrenceConnections ?? []).filter(row => row.componentIds.includes(bead.id));
      const connection = containing[0];
      if (first.owner === second.owner || containing.length !== 1 || connection === undefined || connection.kind !== 'weld'
        || !same(connection.firstPath, firstPath) || !same(connection.secondPath, secondPath)) {
        throw new InputIssue('weld-association', weld.id, 'Nested weld endpoints require exactly one saved weld connection on the selected leaf paths in order');
      }
    }
    const pair = JSON.stringify(spanRoute ? [sideKey(weld.first), sideKey(weld.second)].sort()
      : [explicitSide(weld.first), explicitSide(weld.second)].map(s => s.kind === 'section-node' ? s.nodeId : '').sort());
    const groupKey = JSON.stringify([scope.key, options.weldId]);
    const previousGroup = pairGroups.get(pair);
    if (previousGroup !== undefined && previousGroup !== groupKey) {
      throw new InputIssue('weld-scope', weld.id, 'Same endpoint pair must belong to one complete weld group');
    }
    pairGroups.set(pair, groupKey);
    if (!verifiedGroups.has(groupKey)) {
      const group = weldSegmentsOf(scope.document).get(options.weldId);
      if (group === undefined || group.length === 0) throw new InputIssue('weld-owner', weld.id, 'Missing weld group');
      const segments = group.map(member => {
        const association = associations.get(JSON.stringify([childPrefix ?? [], member.id]));
        const memberOptions = member.source.kind === 'standardPart' ? filletWeldSegmentOptions(member.source.options) : null;
        const memberLegs = member.source.kind === 'standardPart' ? filletWeldLegs(member.source.size) : null;
        if (member.suppressed || association === undefined || memberOptions === null || memberLegs === null
          || member.rigidGroupId !== bead.rigidGroupId || member.materialId !== weld.expectedMaterialId
          || association.expectedMaterialId !== weld.expectedMaterialId
          || memberLegs.legOnFirst !== legs.legOnFirst || memberLegs.legOnSecond !== legs.legOnSecond
          || memberOptions.interiorAngleDegrees !== options.interiorAngleDegrees
          || memberOptions.cylindricalRadius !== options.cylindricalRadius || memberOptions.cylindricalSide !== options.cylindricalSide
          || sideKey(association.first) !== sideKey(weld.first)
          || sideKey(association.second) !== sideKey(weld.second)
          || association.effectiveThroatMm !== weld.effectiveThroatMm
          || association.complianceLengthMm !== weld.complianceLengthMm
          || association.youngMPa !== weld.youngMPa || association.poisson !== weld.poisson) {
          throw new InputIssue('weld-group', weld.id, 'No silent merging: every original interval needs the same owned sections and declared layer material');
        }
        return { start: memberOptions.station, length: memberOptions.length };
      }).sort((a, b) => a.start-b.start);
      if (segments.some((segment, i) => i > 0 && segments[i-1].start+segments[i-1].length > segment.start)) {
        throw new InputIssue('weld-duplicate', weld.id, 'Overlapping original intervals cannot form effective layers');
      }
      // Validate the entire original group, including gaps; never submit a selected subset as a replacement.
      const request = { weldId: options.weldId, legOnSecond: legs.legOnSecond,
        legOnFirst: legs.legOnFirst, segments, materialId: weld.expectedMaterialId };
      if (rootConnected && context.jointOccurrence === undefined) {
        throw new InputIssue('weld-association', weld.id, 'Nested weld groups need the current joint occurrence view');
      }
      // Child-owned: the footprint is checked in the child's own frame (rigid, so frame independent) against the child's
      // own components; root-connected: through the existing occurrence edit scene; top-level: the solved world document.
      const nestedPreview = rootConnected && context.jointOccurrence !== undefined
        ? previewOccurrenceFilletWeldEdit(context.jointOccurrence, request) : null;
      const verified = nestedPreview !== null
        ? (nestedPreview.ok ? { ok: true as const, plan: nestedPreview.plan } : { ok: false as const })
        : planFilletWeldEdit(childPrefix === null ? world : scope.document, request, new Map(),
          owner => context.bodies.get(partKeyOf(owner.source)) ?? null);
      if (!verified.ok || verified.plan.replacedComponentIds.length !== group.length
        || group.some(member => !verified.plan.replacedComponentIds.includes(member.id))) {
        throw new InputIssue('weld-footprint', weld.id, 'Current solved CAD bodies must verify the whole original weld group');
      }
      verifiedGroups.add(groupKey);
    }
    // Solved placements of nested occurrences are already WORLD placements: no parent composition here.
    const pose = scope.solved.placements.get(bead.id);
    if (pose === undefined) throw new InputIssue('weld-frame', weld.id, 'Missing solved bead placement');
    const rootStart = applyPlacementToPoint(pose, [0, 0, 0]), rootEnd = applyPlacementToPoint(pose, [0, 0, options.length]);
    for (const end of [first, second]) for (const root of [rootStart, rootEnd]) {
      const axial = end.axis.reduce((sum, v, i) => sum + v*(root[i]-end.point[i]), 0);
      if (end.kind === 'section-node' && Math.abs(axial) > BEAM_CONNECTION_TOLERANCE_MM) throw new InputIssue('weld-section', weld.id, 'Weld root must lie at the selected member endpoint section, not a remote span');
      if (end.kind === 'member-span' && (axial < -BEAM_CONNECTION_TOLERANCE_MM || axial > end.length + BEAM_CONNECTION_TOLERANCE_MM)) throw new InputIssue('weld-span', weld.id, 'Both bead ends must lie inside the owned finite member span');
    }
    if (options.interiorAngleDegrees !== undefined || options.cylindricalRadius !== undefined) {
      const frame = cadWeldThroatFrame(legs.legOnSecond, legs.legOnFirst, options);
      if (frame === null || weld.effectiveThroatMm > frame.heightMm) {
        throw new InputIssue('weld-throat', weld.id, 'Effective throat must remain inside the actual saved section');
      }
      const [dx, dy] = frame.direction;
      const c = applyPlacementToPoint(pose, [dx*weld.effectiveThroatMm/2, dy*weld.effectiveThroatMm/2, options.length/2]);
      return { id: weld.id, first: explicitSide(weld.first), second: explicitSide(weld.second),
        centerM: [c[0]/1000, c[1]/1000, c[2]/1000] as Vector3,
        normal: applyPlacementToDirection(pose, [dy, -dx, 0]), along: applyPlacementToDirection(pose, [0, 0, 1]),
        widthM: options.length/1000, lengthM: weld.effectiveThroatMm/1000, thicknessM: weld.complianceLengthMm/1000,
        youngPa: weld.youngMPa*1e6, poisson: weld.poisson };
    }
    const a = legs.legOnSecond, b = legs.legOnFirst, hypotenuse = Math.hypot(a, b), throat = a*b/hypotenuse;
    if (weld.effectiveThroatMm > throat) throw new InputIssue('weld-throat', weld.id, 'Effective throat exceeds actual triangular altitude');
    const c = applyPlacementToPoint(pose, [b/hypotenuse*weld.effectiveThroatMm/2, a/hypotenuse*weld.effectiveThroatMm/2, options.length/2]);
    return { id: weld.id, first: explicitSide(weld.first), second: explicitSide(weld.second),
      centerM: [c[0]/1000, c[1]/1000, c[2]/1000] as Vector3,
      normal: applyPlacementToDirection(pose, [a/hypotenuse, -b/hypotenuse, 0]), along: applyPlacementToDirection(pose, [0, 0, 1]),
      widthM: options.length/1000, lengthM: weld.effectiveThroatMm/1000, thicknessM: weld.complianceLengthMm/1000,
      youngPa: weld.youngMPa*1e6, poisson: weld.poisson };
  });
  if (welds.some(w => !Number.isFinite(w.youngPa) || w.youngPa > 1e30 || w.thicknessM <= 1e-30)) throw new InputIssue('weld-units', '$', 'Finite bounded SI compliance required');
  return { geometry, contact: definition, welds };
}
