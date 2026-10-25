import { createAssemblyDocument, createStandardPartSource, DEFAULT_COMPONENT_PLACEMENT,
  EMPTY_PART_LIBRARY, IDENTITY_PLACEMENT, partKeyOf, STEEL_PRODUCTS, steelProductOptions, type AssemblyDocument } from '@pointercad/model';
import type { PropertySource } from '@pointercad/model/beam-analysis';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { createStrengthSession } from '../strength/strengthSession.js';
import type { AssemblyMeshOwnership } from '../viewport/assemblyMeshAdmission.js';
import { createBeamSession, editBeamSession, type BeamSession } from './beamSession.js';
import { captureBeamSource } from './beamSource.js';

export const evidence: PropertySource = { kind: 'user-supplied', reference: 'Independent rectangular test section',
  condition: 'Linear isotropic numerical example; no grade capacity assertion' };

/** Unit metadata only. The product E2E must obtain actual completed OCCT publication. */
export function beamUiFixture() {
  const product = STEEL_PRODUCTS.find(row => row.key === 'SS400:flatBar:FB 50×6');
  if (product === undefined) throw new Error('Actual flat-bar fixture product is unavailable');
  const component = { id: 'member', name: 'Member',
    source: createStandardPartSource(product.catalog, product.size, { ...steelProductOptions(product), length: '2000' }),
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: true, suppressed: false };
  const document: AssemblyDocument = { ...createAssemblyDocument('Beam form test'), components: [component] };
  const current = { publication: true };
  const bodies: AssemblyMeshOwnership['bodies'] = new Map();
  const owner: AssemblyMeshOwnership = {
    document, library: EMPTY_PART_LIBRARY, activeDocumentId: document.id, documentVersion: 3, generation: 7,
    outcome: 'success', timelineIndex: null, cancelRequestCount: 0, bodies, sources: new Map(),
    receipt: { status: 'known', observationId: 'unit-metadata-only', hostEpoch: 0, workerEpochs: [], owners: [],
      limitBytes: 1024, workerRetainedBackingBytes: 0, hostRetainedBackingBytes: 0, pendingCloneReservedBytes: 0,
      admittedBoundBytes: 0, coverage: 'registered-solid-mesh-backings-only',
      unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] },
    backingInspection: { status: 'known', hostEpoch: 0, inputBackingBytes: 0, additionalBackingBytes: 0,
      sameSourceBackings: [], coverage: 'registered-main-solid-backings-only',
      unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] },
    backingInspectionCurrent: () => true, receiptCurrent: () => true,
    publicationCurrent: () => current.publication, uiSnapshot: { epoch: 0, buffers: [] },
  };
  const partKey = partKeyOf(component.source);
  const state: AppState = { ...useAppStore.getState(), assembly: document, drawing: null,
    assemblyLibrary: owner.library, activeDocumentId: document.id, documentVersion: owner.documentVersion,
    requestedGeneration: 7, completedGeneration: 7, cancelRequestCount: 0, recomputeCancelled: false,
    isComputing: false, lastOutcome: 'success', timelineIndex: null, assemblyMotionPlaying: false,
    assemblyMotionPlacements: null, assemblyDrag: null, assemblyDragOverlay: null, assemblyExplodeDraft: null,
    strengthSession: createStrengthSession('mm'),
    assemblyView: { sourceDocument: document,
      resolved: { parts: new Map(), placements: new Map([[component.id, IDENTITY_PLACEMENT]]),
        partKeys: new Map([[component.id, partKey]]), errors: [] },
      bodies, appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(), meshOwnership: owner },
  };
  const source = captureBeamSource(state);
  if (source === null) throw new Error('Unit publication fixture is inconsistent');
  const occurrence = { path: [component.id], partKey, label: component.name };
  let session = editBeamSession(createBeamSession(document.id, 'beam-test'), { kind: 'select', occurrence, selected: true });
  const member = session.members[0];
  session = { ...session, members: [{ ...member, values: { ...member.values,
    young: '208 GPa', shear: '80 GPa', density: '7850', area: '300', iy: '900', iz: '62500',
    torsion: '3300', shearFactor: '5/6', cx: '25', cy: '3', endFx: '10' },
    fixedStart: true, confirmed: true, material: evidence, section: evidence, frame: evidence }] };
  return { state, source, owner, current, component, occurrence, session };
}

export function requireBeamSession(): BeamSession {
  const session = useAppStore.getState().beamSession;
  if (session === null) throw new Error('Expected beam session');
  return session;
}
