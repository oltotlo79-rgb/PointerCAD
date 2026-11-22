import type { AutoSaveDocument, AutoSaver } from '@pointercad/io';
import { createEmptyPartDocument } from '@pointercad/model';
import { readSolidCadSavedInput, withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyticalSolid } from '../fatigue/fatigueSolid.testSupport.js';
import { solidResultsToSave } from '../solidAnalysis/savedSolidResults.js';
import { createSolidAnalysisSession } from '../solidAnalysis/solidAnalysisSession.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachAutoSave } from './attachAutoSave.js';

/**
 * 統括の決定 2026-11-22 08:25: the recovery copy never holds a static solid result, while the manual save still does.
 * The copy is what attachAutoSave hands to the saver on a document change (the bundle given to markDirty).
 */
const marked: AutoSaveDocument[] = [];
const saver: AutoSaver = { markDirty: document => { marked.push(document); }, saveNow: () => Promise.resolve(),
  stop: () => undefined, readLatest: () => Promise.resolve(null), discard: () => Promise.resolve() };
let detach: (() => void) | null = null;

beforeEach(() => { marked.length = 0; useAppStore.setState({ ...createInitialDocumentState(), solidAnalysisSession: null }); });
afterEach(() => { detach?.(); detach = null; });

describe('recovery copy and the static solid result', () => {
  it('leaves a finished result of the saved input out of the copy that the manual save would keep', async () => {
    const empty = createEmptyPartDocument();
    const definition = readSolidCadSavedInput({ schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: empty.id },
      bodyFeatureId: 'box', fixedFaces: ['fixed'], loadedFaces: ['loaded'], youngMPa: 200, poisson: 0, tractionMPa: [1, 0, 0],
      linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 0.1 });
    const document = withBeamAnalysisInputs(empty, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition }] });
    useAppStore.getState().applyDocument(document);
    const outcome = await analyticalSolid(document.id, useAppStore.getState().completedGeneration);
    useAppStore.setState({ solidAnalysisSession: { ...createSolidAnalysisSession(document.id, definition), status: 'complete', result: outcome } });
    detach = attachAutoSave({ saver, bundleParts: true, visibility: null });
    // A non-shape edit: the session keeps its result, so the manual save would still put it in the file.
    useAppStore.getState().applyDocument({ ...useAppStore.getState().document, name: '名前だけ変えた部品' });
    const state = useAppStore.getState();
    expect(solidResultsToSave(state, state.document, '1.0.4')?.get('solid-cad')?.kind).toBe('oofem-linear-solid-tet4');
    expect(marked).toHaveLength(1);
    const copy = marked[0];
    if (copy === undefined || !('kind' in copy) || copy.kind !== 'part') throw new Error('Expected a part bundle in the recovery copy');
    expect(copy.document).toBe(state.document);
    expect(copy.analysisResults).toBeUndefined();
  });
});
