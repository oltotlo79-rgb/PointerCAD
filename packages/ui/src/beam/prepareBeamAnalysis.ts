import { standardMembersToBeamAnalysis, type StandardBeamAdapterContext } from '@pointercad/model';
import type { AnalysisIssue, BeamAnalysisDocument, StandardBeamContactDefinition, StandardBeamImpactDefinition,
  StandardBeamDefinition } from '@pointercad/model/beam-analysis';
import { prepareCadBeamJointContact, type BeamJointContactInput, prepareCadBeamWeldContact, type BeamWeldContactInput, prepareCadBeamBoltContact, type BeamBoltContactInput, standardMembersToBeamBuckling, standardMembersToBeamTransient, translateBeamContact, type BeamBucklingInput,
  type BeamContactInput, type BeamTransientInput, translateBeamImpact, type BeamImpactInput } from '@pointercad/fem';
import type { BeamDefinition } from './beamSession.js';
import type { BeamSourceSnapshot } from './beamSource.js';
import { prepareCadBeamJointInitialStrain, type BeamJointInitialStrainInput } from '@pointercad/fem';

export type PreparedBeamAnalysis =
  | { readonly ok: true; readonly kind: 'joint-initial-strain'; readonly input: BeamJointInitialStrainInput }
  | { readonly ok: true; readonly kind: 'joint-contact'; readonly input: BeamJointContactInput }
  | { readonly ok: true; readonly kind: 'weld-contact'; readonly input: BeamWeldContactInput }
  | { readonly ok: true; readonly kind: 'bolt-contact'; readonly input: BeamBoltContactInput }
  | { readonly ok: true; readonly kind: 'buckling'; readonly input: BeamBucklingInput }
  | { readonly ok: true; readonly kind: 'transient'; readonly input: BeamTransientInput }
  | { readonly ok: true; readonly kind: 'contact'; readonly input: BeamContactInput }
  | { readonly ok: true; readonly kind: 'impact'; readonly input: BeamImpactInput }
  | { readonly ok: true; readonly kind: 'static' | 'modal'; readonly document: BeamAnalysisDocument }
  | { readonly ok: false; readonly issue: AnalysisIssue };

/** Saved schema 5 on the same route as the transient CAD adapter: current straight CAD geometry as unloaded,
 * unrestrained schema-2 geometry whose modal settings carry only the mesh refinement (mode count 1 is a placeholder),
 * then the explicit supports, reference loads, contacts (gap mm -> m here, once) and factors. The contact
 * translation refuses wrong pair orientation, duplicates and two-sided stops against the current positions. */
function prepareContact(source: BeamSourceSnapshot, definition: StandardBeamContactDefinition,
  context: StandardBeamAdapterContext): PreparedBeamAnalysis {
  if (definition.initialStrain !== undefined) {
    try {
      return { ok: true, kind: 'joint-initial-strain', input: prepareCadBeamJointInitialStrain(source.document, definition, context) };
    } catch (error) {
      return { ok: false, issue: { code: 'initial-strain-input', path: 'initialStrain',
        message: error instanceof Error ? error.message : 'Joint initial strain could not be prepared' } };
    }
  }
  if (definition.axialBolts !== undefined && definition.weldLayers !== undefined) {
    try {
      return { ok: true, kind: 'joint-contact', input: prepareCadBeamJointContact(source.document,
        definition, definition.axialBolts, definition.weldLayers, context) };
    } catch (error) {
      return { ok: false, issue: { code: 'joint-input', path: '$',
        message: error instanceof Error ? error.message : 'Combined joint input could not be prepared' } };
    }
  }
  if (definition.weldLayers !== undefined) {
    try {
      return { ok: true, kind: 'weld-contact', input: prepareCadBeamWeldContact(source.document, definition, definition.weldLayers, context) };
    } catch (error) {
      return { ok: false, issue: { code: 'weld-input', path: 'weldLayers',
        message: error instanceof Error ? error.message : 'Effective weld layer input could not be prepared' } };
    }
  }
  if (definition.axialBolts !== undefined) {
    try {
      return { ok: true, kind: 'bolt-contact', input: prepareCadBeamBoltContact(source.document, definition, definition.axialBolts, context) };
    } catch (error) {
      return { ok: false, issue: { code: 'bolt-input', path: 'axialBolts',
        message: error instanceof Error ? error.message : 'Axial bolt input could not be prepared' } };
    }
  }
  const geometryDefinition: StandardBeamDefinition = {
    schema: 'pointercad-standard-beam/2', modal: { modeCount: 1, segmentsPerMember: definition.contact.segmentsPerMember },
    id: definition.id, revision: definition.revision, source: definition.source, units: definition.units,
    members: definition.members, materials: definition.materials, sections: definition.sections,
    constraints: [], loads: [],
  };
  const derived = standardMembersToBeamAnalysis(source.document, geometryDefinition, context);
  if (!derived.ok) return derived;
  try {
    const prepared = translateBeamContact({
      schema: 'pointercad-beam-contact/1', geometry: derived.document,
      supports: definition.supports, referenceLoads: definition.referenceLoads,
      contacts: definition.contact.contacts.map(contact => contact.kind === 'node-plane'
        ? { kind: 'node-plane', id: contact.id, nodeId: contact.nodeId, normal: contact.normal, gapM: contact.gapMm / 1000 }
        : { kind: 'node-pair', id: contact.id, nodeIdA: contact.nodeIdA, nodeIdB: contact.nodeIdB,
          normal: contact.normal, gapM: contact.gapMm / 1000 }),
      loadFactors: definition.contact.loadFactors,
    });
    return { ok: true, kind: 'contact', input: prepared.input };
  } catch (error) {
    return { ok: false, issue: { code: 'contact-input', path: '$',
      message: error instanceof Error ? error.message : 'Contact input could not be prepared' } };
  }
}

/** Saved schema 6 on the contact route's geometry adapter: current straight CAD geometry as unloaded, unrestrained
 * schema-2 geometry whose modal settings carry only the mesh refinement (mode count 1 is a placeholder), then the
 * explicit supports, initial velocities and fixed planes. translateBeamImpact checks the exact contract (rigid modes,
 * restrained velocities, step and sample bounds). No external load exists on this route. */
function prepareImpact(source: BeamSourceSnapshot, definition: StandardBeamImpactDefinition,
  context: StandardBeamAdapterContext): PreparedBeamAnalysis {
  const geometryDefinition: StandardBeamDefinition = {
    schema: 'pointercad-standard-beam/2', modal: { modeCount: 1, segmentsPerMember: definition.impact.segmentsPerMember },
    id: definition.id, revision: definition.revision, source: definition.source, units: definition.units,
    members: definition.members, materials: definition.materials, sections: definition.sections,
    constraints: [], loads: [],
  };
  const derived = standardMembersToBeamAnalysis(source.document, geometryDefinition, context);
  if (!derived.ok) return derived;
  try {
    const input: BeamImpactInput = {
      schema: 'pointercad-beam-impact/1', geometry: derived.document, supports: definition.supports,
      initialVelocities: definition.impact.initialVelocities,
      contacts: definition.impact.planes.map(impactPlaneContact),
      contactStiffnessNPerM: definition.impact.contactStiffnessNPerM, history: definition.impact.history,
    };
    return { ok: true, kind: 'impact', input: translateBeamImpact(input).input };
  } catch (error) {
    return { ok: false, issue: { code: 'impact-input', path: '$',
      message: error instanceof Error ? error.message : 'Impact input could not be prepared' } };
  }
}

/** The saved direction points from the node towards the plane (gap = gapM - unit(direction) . u); only its length is
 * changed here, never its sign. The gap is converted mm -> m exactly once. */
export function impactPlaneContact(plane: StandardBeamImpactDefinition['impact']['planes'][number]): BeamImpactInput['contacts'][number] {
  const length = Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]);
  return { nodeId: plane.nodeId, gapM: plane.gapMm / 1000,
    directionUnit: [plane.normal[0] / length, plane.normal[1] / length, plane.normal[2] / length] };
}

/** Review and execution share the same strict CAD adapter and source ownership. */
export function prepareBeamAnalysis(source: BeamSourceSnapshot, definition: BeamDefinition): PreparedBeamAnalysis {
  const context = { currentSource: source.source, bodies: source.ownership.bodies,
    assemblyOptions: { library: source.library, subAssemblies: source.library.assemblies },
    ...(source.jointOccurrence === undefined ? {} : { jointOccurrence: source.jointOccurrence }) };
  // Impact (schema 6) has its own route and is never prepared as another analysis.
  if (definition.schema === 'pointercad-standard-beam/6') return prepareImpact(source, definition, context);
  if (definition.schema === 'pointercad-standard-beam/5') return prepareContact(source, definition, context);
  if (definition.schema === 'pointercad-standard-beam/4') {
    const checked = standardMembersToBeamTransient(source.document, definition, context);
    return checked.ok ? { ok: true, kind: 'transient', input: checked.input } : checked;
  }
  if (definition.schema === 'pointercad-standard-beam/3') {
    const checked = standardMembersToBeamBuckling(source.document, definition, context);
    return checked.ok ? { ok: true, kind: 'buckling', input: checked.input } : checked;
  }
  const checked = standardMembersToBeamAnalysis(source.document, definition, context);
  return checked.ok ? { ok: true, kind: checked.document.modal === undefined ? 'static' : 'modal', document: checked.document } : checked;
}
