import type { BeamAnalysisResult } from '@pointercad/model/beam-analysis';
import { afterEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { createBeamSession, type BeamSession } from './beamSession.js';
import { canExportBeamReport, exportBeamReport } from './exportBeamReport.js';

const initial = useAppStore.getState();
afterEach(() => { useAppStore.setState(initial, true); });

const result: BeamAnalysisResult = {
  kind: 'oofem-linear-beam-3d', model: 'linear-timoshenko-isotropic', analysisId: 'S1', analysisRevision: 1,
  source: { documentId: 'assembly', documentRevision: 1, geometryRevision: 'assembly:1' },
  inputSha256: 'a'.repeat(64),
  nodes: [
    { nodeId: 'a', solverNode: 1, displacementM: [0, 0, 0], rotationRad: [0, 0, 0], reactionN: [0, 0, 0], reactionNm: [0, 0, 0], constrained: true },
    { nodeId: 'b', solverNode: 2, displacementM: [0, 0, 0], rotationRad: [0, 0, 0], reactionN: [0, 0, 0], reactionNm: [0, 0, 0], constrained: false },
  ],
  elements: [{ memberId: 'm', componentId: 'c', occurrencePath: ['c'], solverElement: 1, nodeIds: ['a', 'b'],
    frame: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], lengthM: 1 }, start: [0, 0, 0, 0, 0, 0], end: [0, 0, 0, 0, 0, 0] }],
  balance: { referenceM: [0, 0, 0], forceN: [0, 0, 0], momentNm: [0, 0, 0], maximumFreeResidual: 0 },
  structuralCertification: false,
};

function session(change: Partial<Pick<BeamSession, 'result' | 'status'>> = {}): BeamSession {
  return { ...createBeamSession('assembly', 'S1'), result, ...change };
}

describe('梁の静解析の報告書の書き出し(釦の押せる条件と断り)', () => {
  it('検証した形のままの静解析の結果がある時だけ押せる', () => {
    expect(canExportBeamReport(session(), true)).toBe(true);
    expect(canExportBeamReport(session(), false)).toBe(false);
    expect(canExportBeamReport(session({ result: null }), true)).toBe(false);
    expect(canExportBeamReport(session({ status: 'running' }), true)).toBe(false);
  });

  it('梁の会話が無い時は何もしない', async () => {
    useAppStore.setState({ beamSession: null, fileMessage: null });
    await expect(exportBeamReport('1.0.3')).resolves.toBe(false);
    expect(useAppStore.getState().fileMessage).toBeNull();
  });

  it('検証した形が無い・結果が無い時は、書き出さずに理由を出す', async () => {
    for (const current of [session(), session({ result: null })]) {
      useAppStore.setState({ beamSession: current, fileMessage: null });
      await expect(exportBeamReport('1.0.3')).resolves.toBe(false);
      expect(useAppStore.getState().fileMessage).toEqual({ key: 'beam.report.unavailable', failed: true });
    }
  });
});
