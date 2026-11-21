/**
 * 梁の静解析の結果の保存(J-03b 段 1)を、本物の店の動作(openAssembly・applyAssembly・openBeam)で確かめる。
 * 開いた時の結果は、開いた文書のままの間だけ梁の窓へ戻り、保存の束へも入る。形を変える確定・別の文書を開くと使わない。
 */
import { createAssemblyDocument, createUndoStack, type AssemblyDocument } from '@pointercad/model';
import type { BeamAnalysisResult, SavedAnalysisResult, StandardBeamDefinition } from '@pointercad/model/beam-analysis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createStrengthSession } from '../strength/strengthSession.js';
import { beamUiFixture, requireBeamSession } from './beam.testSupport.js';
import { beamDefinition } from './beamSession.js';
import {
  analysisResultsToSave, beamDefinitionFingerprint, savedBeamResultDropped, shownSavedBeamResult,
} from './savedBeamResults.js';

const ANALYSIS_ID = 'beam-1';

function documentWithBeam(): AssemblyDocument {
  const document = createAssemblyDocument('保存した結果');
  const definition: StandardBeamDefinition = { schema: 'pointercad-standard-beam/1', id: ANALYSIS_ID, revision: 2, units: 'N-mm',
    source: { documentId: document.id, documentRevision: 1, geometryRevision: 'saved' },
    members: [], materials: [], sections: [], constraints: [], loads: [] };
  return { ...document, beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] } };
}

function savedResult(document: AssemblyDocument): SavedAnalysisResult {
  const result: BeamAnalysisResult = { kind: 'oofem-linear-beam-3d', model: 'linear-timoshenko-isotropic',
    analysisId: ANALYSIS_ID, analysisRevision: 2, source: { documentId: document.id, documentRevision: 1, geometryRevision: 'saved' },
    inputSha256: 'a'.repeat(64), nodes: [], elements: [], structuralCertification: false,
    balance: { referenceM: [0, 0, 0], forceN: [0, 0, 0], momentNm: [0, 0, 0], maximumFreeResidual: 0 } };
  return { analysisId: ANALYSIS_ID, kind: result.kind, analysisRevision: 2, bindingSha256: 'b'.repeat(64), appVersion: '1.0.4', result };
}

function openWithResult(): { readonly document: AssemblyDocument; readonly saved: SavedAnalysisResult } {
  const document = documentWithBeam();
  const saved = savedResult(document);
  useAppStore.getState().openAssembly(document, undefined, { analysisResults: new Map([[ANALYSIS_ID, saved]]) });
  useAppStore.setState({ strengthSession: createStrengthSession('mm') });
  return { document, saved };
}

beforeEach(resetTestStore);
afterEach(resetTestStore);

describe('開いたファイルの梁の結果を店が持つ', () => {
  it('開いた文書のままなら、梁の窓を開いた会話へ結果を戻して「保存した結果」と出し、保存し直しても落とさない', () => {
    const { document, saved } = openWithResult();
    useAppStore.getState().openBeam();
    const state = useAppStore.getState();
    const session = state.beamSession;
    if (session === null) throw new Error('梁の会話が開いていない');
    expect(session.result).toBe(saved.result);
    expect(shownSavedBeamResult(session, state.assembly, state.assemblyOpenedAnalysisResults)).toBe(saved);
    expect(analysisResultsToSave(state, document)?.get(ANALYSIS_ID)?.result).toBe(saved.result);
    expect(savedBeamResultDropped(state.assembly, state.assemblyOpenedAnalysisResults)).toBe(false);
  });

  it('形を変える確定の後は、梁の窓へ戻さず、保存の束へも入れない', () => {
    const { document } = openWithResult();
    useAppStore.getState().applyAssembly({ ...document, name: '形を変えた' });
    useAppStore.getState().openBeam();
    const state = useAppStore.getState();
    const changed = state.assembly;
    if (changed === null) throw new Error('組立が開いていない');
    expect(state.beamSession?.result ?? null).toBeNull();
    expect(analysisResultsToSave(state, changed)).toBeUndefined();
  });

  it('保存してあった結果を出さなかった印は、開いた文書のままの間だけ持ち、別の文書を開くと持ち越さない', () => {
    const document = documentWithBeam();
    useAppStore.getState().openAssembly(document, undefined, { analysisResultsDropped: true });
    const opened = useAppStore.getState();
    expect(savedBeamResultDropped(opened.assembly, opened.assemblyOpenedAnalysisResults)).toBe(true);
    useAppStore.getState().openAssembly(createAssemblyDocument('別の組立'));
    expect(useAppStore.getState().assemblyOpenedAnalysisResults).toBeNull();
  });
});

/** 確かめた会話に、計算した時の指紋の組と一緒に静解析の結果を置く(計算部は流さない。結果の中身は店の判定に関わらない)。 */
function reviewedWithResult(fingerprint: 'same' | 'other') {
  const fixture = beamUiFixture();
  const opened = fixture.state.assembly;
  if (opened === null) throw new Error('組立が無い');
  // 開いた組立と同じく取り消しの履歴を持たせる(applyAssembly は履歴の無い組立を書き換えない: assemblySlice.ts の applyAssembly)。
  useAppStore.setState({ ...fixture.state, beamSession: fixture.session,
    assemblyUndoStack: createUndoStack({ document: opened, library: fixture.state.assemblyLibrary }) });
  useAppStore.getState().reviewBeam();
  const reviewed = requireBeamSession();
  if (reviewed.reviewed === null) throw new Error('確かめられていない');
  const draft = beamDefinition(reviewed, reviewed.reviewed, reviewed.reviewed.document.parameters);
  if (!draft.ok) throw new Error('定義を作れない');
  const definition = draft.definition;
  const computed: BeamAnalysisResult = { ...savedResult(opened).result, analysisId: definition.id, analysisRevision: definition.revision };
  const definitionSha256 = beamDefinitionFingerprint(fingerprint === 'same' ? definition
    : { ...definition, source: { ...definition.source, geometryRevision: 'another-run' } });
  useAppStore.setState({ beamSession: { ...reviewed, status: 'complete', result: computed }, beamResultDefinition: { result: computed, definitionSha256 } });
  return { definition, computed };
}

describe('「入力を文書に反映」でも残す静解析の結果(J-03d、本物の applyBeamInputs)', () => {
  it('計算した時と中身が同じ定義を反映すると、結果を反映した後の文書と組で残し、窓に出して保存の束へも入れる', () => {
    const { definition, computed } = reviewedWithResult('same');
    useAppStore.getState().applyBeamInputs();
    const state = useAppStore.getState();
    const applied = state.assembly, session = state.beamSession;
    if (applied === null || session === null) throw new Error('組立か会話が無い');
    expect(state.assemblyOpenedAnalysisResults?.origin).toBe('applied');
    expect(state.assemblyOpenedAnalysisResults?.document).toBe(applied);
    expect(session.result).toBe(computed);
    expect(shownSavedBeamResult(session, applied, state.assemblyOpenedAnalysisResults)?.result).toBe(computed);
    expect(analysisResultsToSave(state, applied)?.get(definition.id)?.result).toBe(computed);
    expect(state.fileMessage).toBeNull();
  });

  it('計算した時と中身が違う時は結果を残さず、残さなかった事を 1 行で知らせる', () => {
    const { definition } = reviewedWithResult('other');
    useAppStore.getState().applyBeamInputs();
    const state = useAppStore.getState();
    const applied = state.assembly;
    if (applied === null) throw new Error('組立が無い');
    expect(state.beamSession?.result ?? null).toBeNull();
    expect(state.assemblyOpenedAnalysisResults).toBeNull();
    expect(analysisResultsToSave(state, applied)?.get(definition.id)).toBeUndefined();
    expect(state.fileMessage?.key).toBe('beam.applyDroppedResult');
  });
});
