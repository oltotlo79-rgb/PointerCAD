/**
 * 梁の静解析の結果の保存(J-03b 段 1)の店の側の判定。指紋の照合は io の側にあり、ここでは「開いた文書のまま」と「解析の id・revision」だけを見る。
 * 形を変える確定の後(文書が別の物)・会話の結果が消えた後は、保存した結果を出さない・戻さない事を確かめる。
 */
import { createAssemblyDocument, type AssemblyDocument } from '@pointercad/model';
import type { BeamAnalysisResult, SavedAnalysisResult, StandardBeamDefinition } from '@pointercad/model/beam-analysis';
import { describe, expect, it } from 'vitest';

import { createBeamSession, type BeamSession } from './beamSession.js';
import {
  appliedAnalysisResults, beamDefinitionFingerprint, keptResultOnApply, openedAnalysisResults, savedBeamResultDropped,
  savedBeamResults, shownSavedBeamResult, withOpenedBeamResult,
} from './savedBeamResults.js';

const ANALYSIS_ID = 'beam-1';

function definition(revision: number): StandardBeamDefinition {
  return { schema: 'pointercad-standard-beam/1', id: ANALYSIS_ID, revision, units: 'N-mm',
    source: { documentId: 'document-1', documentRevision: 1, geometryRevision: 'saved' },
    members: [], materials: [], sections: [], constraints: [], loads: [] };
}

function documentWith(revision: number): AssemblyDocument {
  return { ...createAssemblyDocument('結果'),
    beamAnalysisInputs: { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: definition(revision) }] } };
}

function result(analysisRevision: number): BeamAnalysisResult {
  return { kind: 'oofem-linear-beam-3d', model: 'linear-timoshenko-isotropic', analysisId: ANALYSIS_ID, analysisRevision,
    source: { documentId: 'document-1', documentRevision: 1, geometryRevision: 'saved' }, inputSha256: 'a'.repeat(64),
    nodes: [], elements: [], structuralCertification: false,
    balance: { referenceM: [0, 0, 0], forceN: [0, 0, 0], momentNm: [0, 0, 0], maximumFreeResidual: 0 } };
}

function saved(analysisRevision: number): SavedAnalysisResult {
  return { analysisId: ANALYSIS_ID, kind: 'oofem-linear-beam-3d', analysisRevision, bindingSha256: 'b'.repeat(64), appVersion: '1.0.4',
    result: result(analysisRevision) };
}

function session(revision: number, patch: Partial<BeamSession> = {}): BeamSession {
  return { ...createBeamSession('document-1', ANALYSIS_ID), revision, ...patch };
}

describe('保存の束へ入れる梁の結果', () => {
  it('流し終えた静解析の結果は、文書の定義と id・revision が同じ時だけ、版を添えて入れる', () => {
    const document = documentWith(3);
    const done = savedBeamResults(document, session(3, { status: 'complete', result: result(3) }), null, '1.0.4');
    expect([...(done?.values() ?? [])].map(item => [item.analysisId, item.analysisRevision, item.appVersion, item.result.analysisRevision]))
      .toEqual([[ANALYSIS_ID, 3, '1.0.4', 3]]);
    expect(savedBeamResults(document, session(3, { status: 'editing', result: result(3) }), null, '1.0.4')).toBeUndefined();
    expect(savedBeamResults(documentWith(4), session(3, { status: 'complete', result: result(3) }), null, '1.0.4')).toBeUndefined();
    expect(savedBeamResults(document, session(3, { status: 'complete', result: result(3) }), null, null)).toBeUndefined();
  });

  it('開いた時の結果は、開いた文書のまま(同じ物)の間だけ素通しし、形を変えた後の文書では入れない', () => {
    const document = documentWith(2);
    const opened = openedAnalysisResults(document, new Map([[ANALYSIS_ID, saved(2)]]));
    expect(savedBeamResults(document, null, opened, '1.0.4')?.get(ANALYSIS_ID)?.appVersion).toBe('1.0.4');
    expect(savedBeamResults({ ...document }, null, opened, '1.0.4')).toBeUndefined();
    expect(openedAnalysisResults(document, new Map())).toBeNull();
    expect(openedAnalysisResults(document, undefined)).toBeNull();
  });
});

describe('梁の窓へ戻す・出す保存した結果', () => {
  it('開いた文書のまま・会話の id と revision が合う時だけ会話へ戻し、窓に「保存した結果」と出す', () => {
    const document = documentWith(2);
    const opened = openedAnalysisResults(document, new Map([[ANALYSIS_ID, saved(2)]]));
    const restored = withOpenedBeamResult(session(2), document, opened);
    expect(restored.result).toBe(opened?.results.get(ANALYSIS_ID)?.result);
    expect(shownSavedBeamResult(restored, document, opened)?.appVersion).toBe('1.0.4');
    expect(withOpenedBeamResult(session(5), document, opened).result).toBeNull();
    expect(withOpenedBeamResult(session(2), null, opened).result).toBeNull();
  });

  it('形を変える確定の後(別の文書)と、会話の結果が消えた後は「保存した結果」を出さない', () => {
    const document = documentWith(2);
    const opened = openedAnalysisResults(document, new Map([[ANALYSIS_ID, saved(2)]]));
    const restored = withOpenedBeamResult(session(2), document, opened);
    expect(shownSavedBeamResult(restored, { ...document }, opened)).toBeNull();
    expect(shownSavedBeamResult({ ...restored, result: null }, document, opened)).toBeNull();
    expect(shownSavedBeamResult({ ...restored, result: result(2) }, document, opened)).toBeNull();
  });

  it('保存してあった結果を io が出さなかった時は、開いた文書のままの間だけ窓に理由を出し、結果は戻さない', () => {
    const document = documentWith(2);
    const dropped = openedAnalysisResults(document, undefined, true);
    expect(dropped?.results.size).toBe(0);
    expect(savedBeamResultDropped(document, dropped)).toBe(true);
    expect(savedBeamResultDropped({ ...document }, dropped)).toBe(false);
    expect(savedBeamResultDropped(null, dropped)).toBe(false);
    expect(withOpenedBeamResult(session(2), document, dropped).result).toBeNull();
    expect(savedBeamResults(document, null, dropped, '1.0.4')).toBeUndefined();
    expect(savedBeamResultDropped(document, openedAnalysisResults(document, new Map([[ANALYSIS_ID, saved(2)]])))).toBe(false);
  });
});

describe('「入力を文書に反映」でも残す静解析の結果(J-03d)', () => {
  it('計算した時と中身の指紋・id・revision が同じ定義を反映する時だけ、その結果を残す', () => {
    const computed = result(2);
    const done = session(2, { status: 'complete', result: computed });
    const recorded = { result: computed, definitionSha256: beamDefinitionFingerprint(definition(2)) };
    const kept = keptResultOnApply(done, definition(2), recorded, '1.0.4');
    expect(kept?.result).toBe(computed);
    expect([kept?.analysisId, kept?.analysisRevision, kept?.appVersion]).toEqual([ANALYSIS_ID, 2, '1.0.4']);
  });

  it('中身・revision・計算した結果のどれかが違う時と、流し終えていない時・版が分からない時は残さない', () => {
    const computed = result(2);
    const done = session(2, { status: 'complete', result: computed });
    const recorded = { result: computed, definitionSha256: beamDefinitionFingerprint(definition(2)) };
    const changed: StandardBeamDefinition = { ...definition(2), source: { ...definition(2).source, geometryRevision: 'changed' } };
    expect(beamDefinitionFingerprint(changed)).not.toBe(recorded.definitionSha256);
    expect(keptResultOnApply(done, changed, recorded, '1.0.4')).toBeNull();
    expect(keptResultOnApply(done, definition(3), { ...recorded, definitionSha256: beamDefinitionFingerprint(definition(3)) }, '1.0.4')).toBeNull();
    expect(keptResultOnApply(done, definition(2), { ...recorded, result: result(2) }, '1.0.4')).toBeNull();
    expect(keptResultOnApply(done, definition(2), null, '1.0.4')).toBeNull();
    expect(keptResultOnApply({ ...done, status: 'editing' }, definition(2), recorded, '1.0.4')).toBeNull();
    expect(keptResultOnApply(done, definition(2), recorded, null)).toBeNull();
  });

  it('残した結果は反映した後の文書と組になり、その文書のままの間だけ保存の束へ入る', () => {
    const document = documentWith(2);
    const applied = appliedAnalysisResults(document, saved(2));
    expect(applied.origin).toBe('applied');
    expect(openedAnalysisResults(document, new Map([[ANALYSIS_ID, saved(2)]]))?.origin).toBe('file');
    expect(savedBeamResults(document, null, applied, '1.0.4')?.get(ANALYSIS_ID)?.result).toBe(applied.results.get(ANALYSIS_ID)?.result);
    expect(savedBeamResults({ ...document }, null, applied, '1.0.4')).toBeUndefined();
  });
});
