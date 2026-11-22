import { createEmptyPartDocument, type PartDocument } from '@pointercad/model';
import { readSolidCadSavedInput, withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { afterEach, describe, expect, it } from 'vitest';
import { analyticalSolid } from '../fatigue/fatigueSolid.testSupport.js';
import { useAppStore } from '../store/useAppStore.js';
import { canExportSolidReport, exportSolidReport } from './exportSolidReport.js';
import { createSolidAnalysisSession, type SolidAnalysisSession } from './solidAnalysisSession.js';

/** J-03c stage 2: when the solid report button can be pressed, and the refusals that write nothing. */
const GENERATION = 7;
const initial = useAppStore.getState();
afterEach(() => { useAppStore.setState(initial, true); });

function documentWithInput(): PartDocument {
  const empty = createEmptyPartDocument();
  return withBeamAnalysisInputs(empty, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad',
    definition: readSolidCadSavedInput({ schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: empty.id },
      bodyFeatureId: 'box', fixedFaces: ['fixed'], loadedFaces: ['loaded'], youngMPa: 200, poisson: 0, tractionMPa: [1, 0, 0],
      linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 0.1 }) }] });
}

async function finished(document: PartDocument): Promise<SolidAnalysisSession> {
  const saved = document.beamAnalysisInputs?.analyses[0];
  if (saved?.kind !== 'solid-cad') throw new Error('Missing saved solid input');
  return { ...createSolidAnalysisSession(document.id, saved.definition), status: 'complete',
    result: await analyticalSolid(document.id, GENERATION) };
}

describe('ソリッドの静解析の報告書の書き出し(釦の押せる条件と断り)', () => {
  it('保存した入力のまま、今の形で計算し終えた結果がある時だけ押せる', async () => {
    const document = documentWithInput(), session = await finished(document);
    const state = { document, solidAnalysisSession: session, completedGeneration: GENERATION };
    expect(canExportSolidReport(state)).toBe(true);
    expect(canExportSolidReport({ ...state, solidAnalysisSession: null })).toBe(false);
    expect(canExportSolidReport({ ...state, completedGeneration: GENERATION + 1 })).toBe(false);
    expect(canExportSolidReport({ ...state, solidAnalysisSession: { ...session, status: 'running' } })).toBe(false);
    expect(canExportSolidReport({ ...state, solidAnalysisSession: { ...session, values: { ...session.values, young: '300' } } }))
      .toBe(false);
    expect(canExportSolidReport({ ...state, document: createEmptyPartDocument() })).toBe(false);
  });

  it('会話が無い時は何もせず、書ける結果が無い時は書き出さずに理由を出す', async () => {
    useAppStore.setState({ solidAnalysisSession: null, fileMessage: null });
    await expect(exportSolidReport('1.0.4')).resolves.toBe(false);
    expect(useAppStore.getState().fileMessage).toBeNull();
    const document = documentWithInput(), session = await finished(document);
    useAppStore.setState({ document, completedGeneration: GENERATION + 1, solidAnalysisSession: session, fileMessage: null });
    await expect(exportSolidReport('1.0.4')).resolves.toBe(false);
    expect(useAppStore.getState().fileMessage).toEqual({ key: 'analysisReport.unavailable', failed: true });
  });
});
