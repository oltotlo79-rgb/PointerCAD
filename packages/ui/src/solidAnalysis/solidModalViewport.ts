import { solidFiniteFieldOf } from '../solidFinite/solidFiniteFieldState.js';
import type { SolidSource } from '@pointercad/fem';
import type { AppState } from '../store/appState.js';
import { solidAnalysisFieldOf } from './solidFieldState.js';
import type { SolidFieldMesh } from './solidFieldView.js';
import { solidModalPreview } from './solidModalState.js';
import type { SolidModeDrawing } from './solidModeLayer.js';
import { solidBucklingPreview } from './solidBucklingState.js';

type LayerState = Pick<AppState, 'solidAnalysisSession' | 'solidFiniteSession' | 'solidModal' | 'solidBuckling' | 'document' | 'completedGeneration' | 'activeDocumentId' | 'assembly' | 'drawing'>;

/**
 * Identity the shown modal result must still match: the current document and completed recompute generation (the
 * `revision` the CAD context gives the mesh), with the result's own mesh key. The mesh key itself cannot be recomputed
 * without meshing; any geometry or document-version change already invalidates the run (attachSolidAnalysis).
 */
export function solidModalCurrentSource(state: LayerState): SolidSource | null {
  const display = state.solidModal.display;
  if (state.solidAnalysisSession === null || display === null) return null;
  return { documentId: state.document.id, revision: state.completedGeneration, meshKey: display.source.meshKey };
}

/** Same identity rule for the buckling shape: the current document and generation with the request's own mesh key. */
export function solidBucklingCurrentSource(state: LayerState): SolidSource | null {
  const input = state.solidBuckling.input;
  if (state.solidAnalysisSession === null || input === null) return null;
  return { documentId: state.document.id, revision: state.completedGeneration, meshKey: input.reference.source.meshKey };
}

/** The analysis overlays are exclusive and share the one mode layer: a drawn buckling shape (explicitly shown) hides
 * the modal preview and the stress field; otherwise a drawable mode preview hides the field; otherwise the field shows. */
export function solidAnalysisLayersOf(state: LayerState): { readonly field: SolidFieldMesh | null; readonly mode: SolidModeDrawing | null } {
  const buckling = solidBucklingPreview(state.solidBuckling, solidBucklingCurrentSource(state));
  if (buckling !== null && buckling.kind === 'preview') return { field: null, mode: buckling };
  const preview = solidModalPreview(state.solidModal, solidModalCurrentSource(state));
  const mode = preview !== null && preview.kind === 'preview' ? preview : null;
  const finite = state.solidFiniteSession;
  const field = finite === null ? solidAnalysisFieldOf(state.solidAnalysisSession)
    : finite.ownerId === state.activeDocumentId && state.assembly === null && state.drawing === null
      && finite.result?.input.source.documentId === state.document.id
      && finite.result.input.source.revision === state.completedGeneration ? solidFiniteFieldOf(finite) : null;
  return { field: mode === null ? field : null, mode };
}

/** The live viewport and its tests share this exact subscription decision. */
export function solidAnalysisLayersChanged(next: LayerState, previous: LayerState): boolean {
  return next.solidAnalysisSession !== previous.solidAnalysisSession || next.solidFiniteSession !== previous.solidFiniteSession
    || next.solidModal !== previous.solidModal || next.solidBuckling !== previous.solidBuckling
    || next.document !== previous.document || next.completedGeneration !== previous.completedGeneration
    || next.activeDocumentId !== previous.activeDocumentId || next.assembly !== previous.assembly || next.drawing !== previous.drawing;
}
