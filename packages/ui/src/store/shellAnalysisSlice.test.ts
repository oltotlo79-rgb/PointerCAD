import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readShellCadAnalysisInput } from '@pointercad/model/beam-analysis';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';
import type { ShellAnalysisRunner } from './shellAnalysisSlice.js';
import { literalShellResult } from '../shellAnalysis/shellAnalysis.testSupport.js';

/** Store-only checks with a mock runner (no FEM client, no Worker): ownership of edits, invalidation and display-only
 * view changes. The real FEM path is covered by attachShellAnalysis.test.ts. */
const face = '{"bodyFeatureId":"sheet","origin":{"identity":{"featureId":"sheet","kind":"box-face","role":"top"},"shapeKind":"face","version":1}}';
const geometry = readShellCadAnalysisInput({ schema: 'pointercad-shell-cad-analysis/1', id: 'shell-cad-analysis', source: { documentId: 'part' },
  geometry: { schema: 'pointercad-shell-cad-input/1', id: 'shell-cad', source: { documentId: 'part' }, bodyFeatureId: 'sheet',
    midsurfaceFaces: [face], thicknessMm: 2, offsetMm: 0 },
  material: { id: 'material', youngMPa: 1, poisson: 0, source: { kind: 'user-supplied', reference: 'r', condition: 'c' } },
  supports: [{ kind: 'edge', origin: { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'sheet', role: 'top-left' } },
    fixed: [true, false, false, false, false, false] }], edgeLoads: [],
  surface: { linearDeflection: 0.1, angularDeflection: 0.3, maximumNodes: 3, maximumTriangles: 1, minimumTriangleAreaMm2: 0,
    minimumAngleDeg: 0, maximumAspectRatio: 1 } }).geometry;
function mockRunner() {
  return { run: vi.fn(), cancel: vi.fn(), capture: vi.fn(), validate: vi.fn() } satisfies ShellAnalysisRunner;
}
const state = () => useAppStore.getState();
const session = () => { const value = state().shellAnalysisSession; if (!value) throw new Error('No session'); return value; };

beforeEach(() => { resetTestStore(); useAppStore.setState({ shellAnalysisSession: null, shellAnalysisRunner: null }); });
afterEach(() => { useAppStore.setState({ shellAnalysisSession: null, shellAnalysisRunner: null }); resetTestStore(); });

describe('shell analysis slice', () => {
  it('opens only under the strength parent of a part and never changes the document', () => {
    const before = state().document;
    state().openShellAnalysis();
    expect(state().shellAnalysisSession).toBeNull();
    state().toggleStrength(); state().openShellAnalysis();
    expect(session().ownerId).toBe(state().activeDocumentId);
    expect(state().document).toBe(before);
    expect(state().selectionKind).toBe('face');
  });

  it('a physical edit cancels the run, advances the revision and drops the result; the same text is no edit', () => {
    state().toggleStrength(); state().openShellAnalysis();
    const runner = mockRunner();
    useAppStore.setState({ shellAnalysisRunner: runner,
      shellAnalysisSession: { ...session(), status: 'complete', result: literalShellResult(geometry, face, 1) } });
    const revision = session().revision;
    state().editShellAnalysis('thickness', '3');
    expect(runner.cancel).toHaveBeenCalledTimes(1);
    expect(session()).toMatchObject({ revision: revision + 1, status: 'editing', result: null });
    state().editShellAnalysis('thickness', '3');
    expect(session().revision).toBe(revision + 1); expect(runner.cancel).toHaveBeenCalledTimes(1);
    state().editShellMaterialSource({ kind: 'measured' });
    expect(session()).toMatchObject({ revision: revision + 2, materialSource: { kind: 'measured', reference: '', condition: '' } });
  });

  it('the display component changes nothing but the view: no cancel, same revision, same result object', () => {
    state().toggleStrength(); state().openShellAnalysis();
    const runner = mockRunner(), result = literalShellResult(geometry, face, 1);
    useAppStore.setState({ shellAnalysisRunner: runner, shellAnalysisSession: { ...session(), status: 'complete', result } });
    const revision = session().revision;
    state().setShellAnalysisView('xy');
    expect(session().view.component).toBe('xy');
    expect(session().revision).toBe(revision); expect(session().result).toBe(result); expect(runner.cancel).not.toHaveBeenCalled();
  });

  it('cancel marks only a running analysis as cancelled; close cancels and drops the session', () => {
    state().toggleStrength(); state().openShellAnalysis();
    const runner = mockRunner();
    useAppStore.setState({ shellAnalysisRunner: runner, shellAnalysisSession: { ...session(), status: 'running' } });
    state().cancelShellAnalysis();
    expect(session()).toMatchObject({ status: 'cancelled', result: null });
    state().closeShellAnalysis();
    expect(state().shellAnalysisSession).toBeNull(); expect(runner.cancel).toHaveBeenCalledTimes(2);
  });

  it('ignores edits of a session owned by another document', () => {
    state().toggleStrength(); state().openShellAnalysis();
    const other = { ...session(), ownerId: 'another-document' };
    useAppStore.setState({ shellAnalysisSession: other });
    state().editShellAnalysis('young', '1'); state().removeShellSupport('x'); state().clearShellMidsurface();
    expect(state().shellAnalysisSession).toBe(other);
  });

  it('a support starts with no fixed direction and toggling one is a physical edit', () => {
    state().toggleStrength(); state().openShellAnalysis();
    const origin = { version: 1 as const, shapeKind: 'edge' as const, identity: { kind: 'box-edge' as const, featureId: 'sheet', role: 'top-left' as const } };
    useAppStore.setState({ shellAnalysisSession: { ...session(), bodyFeatureId: 'sheet', midsurfaceFaces: [face],
      supports: [{ key: 'k', kind: 'edge', origin, fixed: [false, false, false, false, false, false] }] } });
    const revision = session().revision;
    state().setShellSupportFixed('k', 'rz', true);
    expect(session().supports[0].fixed).toEqual([false, false, false, false, false, true]);
    expect(session().revision).toBe(revision + 1);
    state().clearShellMidsurface();
    expect(session()).toMatchObject({ bodyFeatureId: null, midsurfaceFaces: [], supports: [], edgeLoads: [] });
  });
});
