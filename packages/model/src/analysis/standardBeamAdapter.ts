import type { SolidBody } from '../kernelBridge.js';
import { findDensityMaterial } from '../appearance/densityMaterials.js';
import { massFromVolume } from '../measure/massProperties.js';
import { materialOf } from '../assembly/massProperties.js';
import { applyPlacementToDirection, applyPlacementToPoint } from '../assembly/placementMath.js';
import { resolveConstrainedAssembly } from '../assembly/resolveConstrainedAssembly.js';
import { partKeyOf, type ResolveAssemblyOptions, type ResolvedAssembly } from '../assembly/resolveAssembly.js';
import { buildStandardPartFromSource } from '../assembly/standard/buildStandardPart.js';
import type { AssemblyComponent, AssemblyDocument, StandardCatalogId } from '../assembly/types.js';
import type { JointOccurrenceCommandContext } from '../assembly/jointOccurrenceSelection.js';
import type { AnalysisCheck, AnalysisSource, BeamMember, Vector3 } from './analysisModel.js';
import { beamFrame, readBeamAnalysis, InputIssue } from './analysisValidation.js';
import { readBeamAnalysisInputs, type StandardBeamDefinition } from './beamInputs.js';

/** Absolute CAD endpoint tolerance. It checks an explicit connection; it never creates one. */
export const BEAM_CONNECTION_TOLERANCE_MM = 1e-6;

export interface StandardBeamAdapterContext {
  /** The caller must obtain this stamp and bodies from the same completed CAD recomputation. */
  readonly currentSource: AnalysisSource;
  readonly bodies: ReadonlyMap<string, readonly SolidBody[]>;
  readonly assemblyOptions: Pick<ResolveAssemblyOptions, 'library' | 'subAssemblies'>;
  /**
   * The same command context the nested weld editor uses (ui nestedJointCommandContext). Required only for welds whose
   * endpoints are nested leaf members; their whole saved group is revalidated through previewOccurrenceFilletWeldEdit.
   */
  readonly jointOccurrence?: JointOccurrenceCommandContext;
}

/** Active CAD leaf occurrences omitted from the beam idealization, grouped by catalog kind. */
export interface ExcludedBeamParts {
  readonly kind: StandardCatalogId | 'part';
  readonly count: number;
  /** Sum in kg, or null if any current body volume/material in this group is unavailable. Never a nominal estimate. */
  readonly massKg: number | null;
}

/** Derived accounting only: neither field is added to the saved/solver analysis document. */
export type StandardBeamAnalysisCheck = (Extract<AnalysisCheck, { readonly ok: true }> & {
  readonly totalMassKg: number;
  readonly excludedParts: readonly ExcludedBeamParts[];
}) | Extract<AnalysisCheck, { readonly ok: false }>;

function excludedParts(
  document: AssemblyDocument, resolved: ResolvedAssembly, selectedPaths: ReadonlySet<string>,
  context: StandardBeamAdapterContext,
): readonly ExcludedBeamParts[] {
  const groups = new Map<ExcludedBeamParts['kind'], ExcludedBeamParts>();
  const visit = (current: AssemblyDocument, solved: ResolvedAssembly, parent: readonly string[]): void => {
    for (const component of current.components) {
      if (component.suppressed) continue;
      const path = [...parent, component.id];
      if (component.source.kind === 'subAssembly') {
        const nested = solved.subAssemblies?.get(component.id);
        if (nested === undefined) throw new InputIssue('missing-occurrence', JSON.stringify(path), 'Solved subassembly is unavailable');
        visit(nested.assembly, nested.resolved, path);
        continue;
      }
      if (selectedPaths.has(JSON.stringify(path))) continue;
      const kind = component.source.kind === 'standardPart' ? component.source.catalog : 'part';
      const key = solved.partKeys.get(component.id);
      const bodies = key === undefined ? undefined : context.bodies.get(key);
      const part = component.source.kind === 'part' ? context.assemblyOptions.library?.parts.get(component.source.partRef) : undefined;
      const material = findDensityMaterial(materialOf(component, part));
      const known = material !== undefined && bodies !== undefined && bodies.length > 0
        && bodies.every(body => body.isValid && Number.isFinite(body.volume) && body.volume >= 0);
      const mass = known ? bodies.reduce((sum, body) => sum + massFromVolume(body.volume, material.density) / 1000, 0) : null;
      const previous = groups.get(kind);
      const sum = mass === null || previous?.massKg === null ? null : (previous?.massKg ?? 0) + mass;
      groups.set(kind, { kind, count: (previous?.count ?? 0) + 1, massKg: sum !== null && Number.isFinite(sum) ? sum : null });
    }
  };
  visit(document, resolved, []);
  return [...groups.values()];
}

function selectedComponent(
  document: AssemblyDocument,
  path: readonly string[],
  options: StandardBeamAdapterContext['assemblyOptions'],
): AssemblyComponent {
  let current = document;
  for (let index = 0; index < path.length; index += 1) {
    const matches = current.components.filter(component => component.id === path[index]);
    const component = matches[0];
    if (matches.length !== 1 || component === undefined || component.suppressed) {
      throw new InputIssue('missing-occurrence', JSON.stringify(path), 'Occurrence is missing, ambiguous or suppressed');
    }
    const rotation = component.placement.rotation;
    if (rotation.length !== 4 || rotation.some(value => !Number.isFinite(value)) || Math.hypot(...rotation) < 1e-12) {
      throw new InputIssue('invalid-placement', JSON.stringify(path), 'An occurrence or ancestor has an invalid rotation');
    }
    if (index === path.length - 1) return component;
    const nested = component.source.kind === 'subAssembly'
      ? options.subAssemblies?.get(component.source.assemblyRef)
      : undefined;
    if (nested === undefined) {
      throw new InputIssue('missing-occurrence', JSON.stringify(path), 'Occurrence ancestor is not a resolved subassembly');
    }
    current = nested;
  }
  throw new InputIssue('missing-occurrence', 'members', 'Occurrence path is empty');
}

function solvedOccurrence(resolved: ResolvedAssembly, path: readonly string[]): ResolvedAssembly {
  let current = resolved;
  for (const id of path.slice(0, -1)) {
    const nested = current.subAssemblies?.get(id);
    if (nested === undefined) {
      throw new InputIssue('missing-occurrence', JSON.stringify(path), 'Solved occurrence ancestor is unavailable');
    }
    current = nested.resolved;
  }
  return current;
}

function generatedLength(component: AssemblyComponent): number {
  const source = component.source;
  if (source.kind !== 'standardPart' || ![
    'equalAngle', 'channel', 'hBeam', 'flatBar', 'roundBar', 'steelPipe',
  ].includes(source.catalog)) {
    throw new InputIssue('unsupported-geometry', component.id, 'Select a supported generated straight structural member');
  }
  const generated = buildStandardPartFromSource(source);
  const first = generated?.solids[0];
  const length = first?.kind === 'extrude'
    ? first.distance.value
    : first?.kind === 'primitive' && first.shape.kind === 'cylinder'
      ? first.shape.height.value
      : undefined;
  if (length === undefined || !Number.isFinite(length) || length <= 0) {
    throw new InputIssue('unsupported-geometry', component.id, 'Current catalog and generator cannot produce this straight member');
  }
  return length;
}

/** Unreachable for read inputs; a new saved schema must be routed here explicitly before it compiles. */
function unroutedDefinition(definition: never): never {
  throw new InputIssue('unsupported-model', '$', `Unrouted standard beam definition ${JSON.stringify(definition)}`);
}

function readDefinition(value: unknown, ownerId: string): StandardBeamDefinition {
  const checked = readBeamAnalysisInputs({
    schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: value }],
  }, ownerId);
  if (!checked.ok) {
    throw new InputIssue(checked.issue.code, checked.issue.path, checked.issue.message);
  }
  const input = checked.value.analyses[0];
  if (input?.kind !== 'standard-members') {
    throw new InputIssue('invalid-input', '$', 'Expected standard member input');
  }
  // Exhaustive over every saved standard-member schema: only 1 (static) and 2 (modal) reach the static adapter.
  const definition = input.definition;
  switch (definition.schema) {
    case 'pointercad-standard-beam/1':
    case 'pointercad-standard-beam/2':
      return definition;
    case 'pointercad-standard-beam/3':
      throw new InputIssue('unsupported-analysis', '$', 'Use the explicit buckling CAD adapter for schema 3');
    case 'pointercad-standard-beam/4':
      throw new InputIssue('unsupported-analysis', '$', 'Use the explicit transient CAD adapter for schema 4');
    case 'pointercad-standard-beam/5':
      throw new InputIssue('unsupported-analysis', '$', 'Use the explicit contact preparation for schema 5');
    case 'pointercad-standard-beam/6':
      throw new InputIssue('unsupported-analysis', '$', 'Use the explicit impact preparation for schema 6');
    default:
      return unroutedDefinition(definition);
  }
}

/** Derive a solver input from current solved CAD placements; never writes into a CAD document. */
export function standardMembersToBeamAnalysis(
  document: AssemblyDocument,
  definitionValue: unknown,
  context: StandardBeamAdapterContext,
): StandardBeamAnalysisCheck {
  try {
    const definition = readDefinition(definitionValue, document.id);
    const expected = definition.source;
    const current = context.currentSource;
    if (current.documentId !== document.id || expected.documentId !== current.documentId
      || expected.documentRevision !== current.documentRevision || expected.geometryRevision !== current.geometryRevision) {
      throw new InputIssue('stale-source', 'source', 'Analysis associations do not match the current CAD revision');
    }
    const selected = definition.members.map(member => {
      const component = selectedComponent(document, member.occurrencePath, context.assemblyOptions);
      if (partKeyOf(component.source) !== member.expectedPartKey) {
        throw new InputIssue('changed-source', member.id, 'Member size, options or source revisions changed');
      }
      return { member, component, length: generatedLength(component) };
    });
    const solved = resolveConstrainedAssembly(document, context.bodies, {
      ...context.assemblyOptions,
      standardPart: buildStandardPartFromSource,
    });
    if (!solved.ok) {
      throw new InputIssue('unresolved-assembly', '$', `CAD ${solved.reason} could not be solved: ${solved.messages.join('; ')}`);
    }
    const positions = new Map<string, Vector3>();
    const members: BeamMember[] = [];
    const putEndpoint = (id: string, point: Vector3): void => {
      const prior = positions.get(id);
      if (prior !== undefined && Math.hypot(
        point[0] - prior[0], point[1] - prior[1], point[2] - prior[2],
      ) > BEAM_CONNECTION_TOLERANCE_MM) {
        throw new InputIssue('inconsistent-connection', id, 'Explicitly shared endpoint does not coincide in solved world coordinates');
      }
      if (prior === undefined) positions.set(id, point);
    };
    for (const { member, component, length } of selected) {
      const occurrence = solvedOccurrence(solved.resolved, member.occurrencePath);
      const placement = occurrence.placements.get(component.id);
      if (placement === undefined || occurrence.partKeys.get(component.id) !== member.expectedPartKey) {
        throw new InputIssue('missing-occurrence', member.id, 'Current solved member source is unavailable');
      }
      const [cx, cy] = member.sectionFrame.centroidMm;
      // The supported actual generators extrude along local +Z from local z=0.
      // Nested solved placements are already world placements: do not compose the parent twice.
      putEndpoint(member.startNodeId, applyPlacementToPoint(placement, [cx, cy, 0]));
      putEndpoint(member.endNodeId, applyPlacementToPoint(placement, [cx, cy, length]));
      members.push({
        id: member.id, componentId: component.id, occurrencePath: [...member.occurrencePath],
        startNodeId: member.startNodeId, endNodeId: member.endNodeId,
        materialId: member.materialId, sectionId: member.sectionId,
        localYHint: applyPlacementToDirection(placement, member.sectionFrame.principalY),
        cadSource: {
          expectedPartKey: member.expectedPartKey,
          sectionFrameSource: member.sectionFrame.source,
          shearCenterModel: member.sectionFrame.shearCenterModel,
        },
      });
    }
    const checked = readBeamAnalysis({
      schema: definition.modal === undefined ? 'pointercad-beam/1' : 'pointercad-beam/2',
      ...(definition.modal === undefined ? {} : { modal: definition.modal }),
      id: definition.id, revision: definition.revision,
      source: definition.source, units: definition.units,
      nodes: [...positions].map(([id, position]) => ({ id, position })),
      members, materials: definition.materials, sections: definition.sections,
      constraints: definition.constraints, loads: definition.loads,
    });
    if (!checked.ok) return checked;
    const materials = new Map(checked.document.materials.map(material => [material.id, material]));
    const sections = new Map(checked.document.sections.map(section => [section.id, section]));
    let totalMassKg = 0;
    for (const member of checked.document.members) {
      const start = positions.get(member.startNodeId), end = positions.get(member.endNodeId);
      const material = materials.get(member.materialId), section = sections.get(member.sectionId);
      if (start === undefined || end === undefined || material === undefined || section === undefined) {
        throw new InputIssue('missing-reference', member.id, 'Missing validated node/material/section reference');
      }
      // Standard-member inputs are N-mm only: mm² -> m², with the same physical length as the beam solver.
      totalMassKg += (section.area / 1e6) * beamFrame(start, end, member.localYHint, 1e-3).lengthM * material.densityKgM3;
    }
    return { ...checked, totalMassKg,
      excludedParts: excludedParts(document, solved.resolved,
        new Set(checked.document.members.map(member => JSON.stringify(member.occurrencePath))), context) };
  } catch (error) {
    if (error instanceof InputIssue) {
      return { ok: false, issue: { code: error.code, path: error.path, message: error.message } };
    }
    return { ok: false, issue: { code: 'invalid-cad-input', path: '$', message: 'CAD member input could not be resolved' } };
  }
}
