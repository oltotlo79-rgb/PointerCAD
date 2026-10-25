import { partKeyOf, type AssemblyDocument, type PartLibrary, type ResolvedAssembly } from '@pointercad/model';
import type { AnalysisSource } from '@pointercad/model/beam-analysis';
import type { AppState } from '../store/appState.js';
import { currentAssemblyMeshPublication, type AssemblyMeshOwnership } from '../viewport/assemblyMeshAdmission.js';
import { nestedJointCommandContext } from '../assembly/nestedWeldDraft.js';

export interface BeamOccurrence {
  readonly path: readonly string[];
  readonly partKey: string;
  readonly label: string;
}

export interface BeamSourceSnapshot {
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
  readonly ownership: AssemblyMeshOwnership;
  readonly resolved: ResolvedAssembly;
  readonly source: AnalysisSource;
  /**
   * The same command context the nested weld editor uses (assemblySlice.ts 771), captured from the same current view.
   * Its own path resolution refuses a stale view; staleness of the snapshot itself stays decided by beamSourceIsCurrent.
   */
  readonly jointOccurrence?: NonNullable<ReturnType<typeof nestedJointCommandContext>>;
}

/** Only a completed, current physical placement is eligible. Animation and drag are not physical inputs. */
export function captureBeamSource(state: AppState): BeamSourceSnapshot | null {
  const view = state.assemblyView;
  const ownership = view?.meshOwnership;
  if (state.assembly === null || view === null || ownership === undefined || state.isComputing
    || state.lastOutcome !== 'success' || state.requestedGeneration !== state.completedGeneration
    || state.completedGeneration <= 0 || state.timelineIndex !== null || state.assemblyMotionPlaying
    || state.assemblyMotionPlacements !== null || state.assemblyDrag !== null
    || state.assemblyDragOverlay !== null || state.assemblyExplodeDraft !== null
    || !currentAssemblyMeshPublication(ownership, state)) return null;
  const jointOccurrence = nestedJointCommandContext(state.assembly, state.assemblyLibrary, view);
  return {
    ...(jointOccurrence === null ? {} : { jointOccurrence }),
    document: state.assembly, library: state.assemblyLibrary, ownership, resolved: view.resolved,
    source: {
      documentId: state.assembly.id,
      documentRevision: state.documentVersion,
      geometryRevision: `${state.activeDocumentId}:${state.completedGeneration}`,
    },
  };
}

export function beamSourceIsCurrent(snapshot: BeamSourceSnapshot, state: AppState): boolean {
  const current = captureBeamSource(state);
  return current !== null && current.document === snapshot.document && current.library === snapshot.library
    // The producer refreshes ledger evidence by replacing only meshOwnership. Its
    // physical publication retains these references; a new resolution is not a refresh.
    && current.resolved === snapshot.resolved
    && current.ownership.document === snapshot.ownership.document
    && current.ownership.library === snapshot.ownership.library
    && current.ownership.activeDocumentId === snapshot.ownership.activeDocumentId
    && current.ownership.documentVersion === snapshot.ownership.documentVersion
    && current.ownership.generation === snapshot.ownership.generation
    && current.ownership.cancelRequestCount === snapshot.ownership.cancelRequestCount
    && current.ownership.outcome === snapshot.ownership.outcome
    && current.ownership.timelineIndex === snapshot.ownership.timelineIndex
    && current.ownership.bodies === snapshot.ownership.bodies
    && current.ownership.sources === snapshot.ownership.sources
    && current.source.documentId === snapshot.source.documentId
    && current.source.documentRevision === snapshot.source.documentRevision
    && current.source.geometryRevision === snapshot.source.geometryRevision;
}

/** Full occurrence paths preserve duplicate IDs in separate subassemblies. No placement is invented. */
export function beamOccurrences(document: AssemblyDocument, resolved: ResolvedAssembly): readonly BeamOccurrence[] {
  const output: BeamOccurrence[] = [];
  const visit = (assembly: AssemblyDocument, view: ResolvedAssembly, parents: readonly string[], labels: readonly string[]): void => {
    for (const component of assembly.components) {
      if (component.suppressed) continue;
      const path = [...parents, component.id];
      const label = [...labels, component.name].join(' / ');
      const nested = view.subAssemblies?.get(component.id);
      if (nested !== undefined) {
        visit(nested.assembly, nested.resolved, path, [...labels, component.name]);
      } else if (component.source.kind === 'standardPart'
        && ['equalAngle', 'channel', 'hBeam', 'flatBar', 'roundBar', 'steelPipe'].includes(component.source.catalog)
        && view.placements.has(component.id) && view.partKeys.get(component.id) === partKeyOf(component.source)) {
        output.push({ path, partKey: partKeyOf(component.source), label });
      }
    }
  };
  visit(document, resolved, [], []);
  return output;
}
