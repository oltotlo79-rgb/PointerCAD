import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeSolidAnalysis, solidInputSha256, type SolidAnalysisInput, type CadSolidOutcome } from '@pointercad/fem';
import { createBrowserFileGateway } from '../file/fileGateway.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createSolidAnalysisSession, type SolidAnalysisSession } from './solidAnalysisSession.js';
import { exportSolidResultCsv } from './exportSolidResultCsv.js';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SolidResultExport } from './SolidResultExport.js';
import { t } from '../i18n/t.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => { resetTestStore(); });

/** Capture the actual rendered button closure, including its useRef guard; no exporter mock. */
function saveButtonOf(session: SolidAnalysisSession): () => void {
  let click: (() => void) | null = null;
  function walk(node: ReactNode): void {
    Children.forEach(node, child => {
      if (!isValidElement<{ readonly children?: ReactNode; readonly title?: string; readonly onClick?: () => void }>(child)) return;
      if (child.type === 'button' && child.props.title === t('solidAnalysis.exportCsvHelp')) click = child.props.onClick ?? null;
      walk(child.props.children);
    });
  }
  function Probe(): null { walk(SolidResultExport({ session })); return null; }
  renderToStaticMarkup(createElement(Probe));
  if (click === null) throw new Error('Missing result export button');
  return click;
}

async function fixture(stage: 'picker' | 'create' | 'write' | 'close') {
  const state = useAppStore.getState(), source = { documentId: state.document.id, revision: 7, meshKey: 'tet' };
  const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1', source, units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }],
    materials: [{ id: 'm', youngMPa: 210000, poisson: 0 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [1, 0, 0] }], surfaceLoads: [] };
  const hash = await solidInputSha256(input);
  const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source,
    displacementMm: [[0, 0, 0], [6 / 210000, 0, 0], [0, 0, 0], [0, 0, 0]],
    elementForcesN: [[-1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]], reservedNumericBytes: 50000, minimumScaledPivot: 1 }, input, hash);
  const coordinates = input.nodes.flat(), triangles = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
  const outcome: Extract<CadSolidOutcome, { kind: 'result' }> = { kind: 'result', result,
    prepared: { input, loadedAreaMm2: 0, totalForceN: [1, 0, 0] }, mesh: { kind: 'netgen-tetra-mesh',
      input: { schema: 'pointercad-convex-plc/1', source: { documentId: source.documentId, revision: 7, featureId: 'tet', bodyKey: 'tet' },
        units: 'mm', coordinates, triangles, tags: [0, 1, 2, 3], tagCount: 4 }, inputSha256: hash,
      coordinates, tetrahedra: [0, 1, 2, 3], boundaryTriangles: triangles, boundaryTags: [0, 1, 2, 3],
      volumeMm3: 1 / 6, minTetVolumeMm3: 1 / 6 } };
  const session: SolidAnalysisSession = { ...createSolidAnalysisSession(state.activeDocumentId), status: 'complete', result: outcome };
  const calls: string[] = [], writes: Uint8Array[] = [], entered = deferred(), gate = deferred();
  const pause = async (name: typeof stage): Promise<void> => {
    calls.push(name); if (stage === name) { entered.resolve(); await gate.promise; }
  };
  const writable = { write: async (bytes: Uint8Array) => { writes.push(bytes); await pause('write'); },
    close: async () => pause('close'), abort: () => { calls.push('abort'); return Promise.resolve(); } };
  const handle = { name: 'solid-analysis.csv', createWritable: async () => { await pause('create'); return writable; } };
  const gateway = createBrowserFileGateway({ showSaveFilePicker: async () => { await pause('picker'); return handle; } });
  useAppStore.setState({ solidAnalysisSession: session, fileGateway: gateway, requestedGeneration: 7, completedGeneration: 7,
    isComputing: false, recomputeCancelled: false, lastOutcome: 'success', timelineIndex: null,
    mathGeometryResult: { document: state.document, generation: 7, evaluated: true, outcomes: new Map() } });
  return { session, calls, writes, gate, entered, controller: new AbortController() };
}

describe('current linear result CSV through the actual browser save gateway', () => {
  it('a double activation of the real panel button opens one picker and writes once', async () => {
    const f = await fixture('picker'), click = saveButtonOf(f.session);
    click(); click();
    await f.entered.promise;
    expect(f.calls).toEqual(['picker']);
    click();
    expect(f.calls).toEqual(['picker']);
    f.gate.resolve();
    await vi.waitFor(() => { expect(f.calls).toEqual(['picker', 'create', 'write', 'close']); });
    expect(f.writes).toHaveLength(1);
  });
  it('an input edit while the real panel button awaits its picker prevents the old write', async () => {
    const f = await fixture('picker'), click = saveButtonOf(f.session);
    const finished = deferred(), subscribe = useAppStore.subscribe.bind(useAppStore);
    const subscription = vi.spyOn(useAppStore, 'subscribe').mockImplementation(listener => {
      const unsubscribe = subscribe(listener);
      return () => { unsubscribe(); finished.resolve(); };
    });
    try {
      click();
      await f.entered.promise;
      useAppStore.setState({ solidAnalysisSession: { ...f.session, revision: f.session.revision + 1,
        status: 'editing', result: null } });
      f.gate.resolve();
      // Wait for the real action's finally/unsubscribe, not a delay or an early negative assertion.
      await finished.promise;
      expect(f.calls).toEqual(['picker']); expect(f.writes).toEqual([]);
    } finally { subscription.mockRestore(); }
  });
  for (const stage of ['picker', 'create', 'write', 'close'] as const) {
    for (const loss of ['input', 'document', 'cancel'] as const) {
      it(`${loss} during ${stage} suppresses success and further writes`, async () => {
        const f = await fixture(stage), pending = exportSolidResultCsv(f.session, f.controller.signal);
        await f.entered.promise;
        if (loss === 'input') useAppStore.setState({ solidAnalysisSession: { ...f.session, revision: f.session.revision + 1,
          status: 'editing', result: null } });
        else if (loss === 'document') useAppStore.setState({ document: { ...useAppStore.getState().document } });
        else f.controller.abort();
        f.gate.resolve();
        expect(await pending).toBeNull();
        expect(f.calls).toEqual(stage === 'picker' ? ['picker'] : stage === 'create'
          ? ['picker', 'create', 'abort'] : stage === 'write' ? ['picker', 'create', 'write', 'abort']
            : ['picker', 'create', 'write', 'close']);
      });
    }
  }
  it('saves identical bytes twice and keeps full displacement precision', async () => {
    const f = await fixture('picker'); f.gate.resolve();
    expect(await exportSolidResultCsv(f.session, f.controller.signal)).toBe(true);
    expect(await exportSolidResultCsv(f.session, f.controller.signal)).toBe(true);
    expect(f.writes).toHaveLength(2); expect(f.writes[0]).toEqual(f.writes[1]);
    const csv = new TextDecoder().decode(f.writes[0]);
    expect(csv).toContain(`node,1,ux_mm,${6 / 210000}\r\n`);
    expect(csv).toContain('metadata,,coordinates,global-XYZ-undeformed\r\n');
  });
  it.each(['generation', 'gateway', 'owner'] as const)('rejects %s replacement before the asynchronous digest completes', async loss => {
    const f = await fixture('picker'), pending = exportSolidResultCsv(f.session, f.controller.signal);
    if (loss === 'generation') useAppStore.setState({ requestedGeneration: 8, isComputing: true });
    else if (loss === 'gateway') useAppStore.setState({ fileGateway: createBrowserFileGateway({}) });
    else useAppStore.setState({ activeDocumentId: 'different-owner' });
    expect(await pending).toBeNull(); expect(f.calls).toEqual([]);
  });
  it('refuses a corrupt result before opening any save dialog', async () => {
    const f = await fixture('picker');
    if (f.session.result === null) throw new Error('Missing fixture');
    const corrupt: SolidAnalysisSession = { ...f.session, result: { ...f.session.result,
      result: { ...f.session.result.result, inputSha256: '0'.repeat(64) } } };
    useAppStore.setState({ solidAnalysisSession: corrupt });
    await expect(exportSolidResultCsv(corrupt, f.controller.signal)).rejects.toThrow('does not match');
    expect(f.calls).toEqual([]);
  });
  it('offers the ordinary panel action and disables it for non-success states', async () => {
    const f = await fixture('picker');
    const html = renderToStaticMarkup(createElement(SolidResultExport, { session: f.session }));
    expect(html).toContain(t('solidAnalysis.exportCsv'));
    expect(html).toContain(t('solidAnalysis.exportCsvHelp'));
    expect(html).not.toContain('disabled');
    const invalid = renderToStaticMarkup(createElement(SolidResultExport,
      { session: { ...f.session, status: 'cancelled', result: null } }));
    expect(invalid).toContain('disabled');
  });
  it('reports user dialog cancellation as cancelled and preserves current save errors', async () => {
    const f = await fixture('picker');
    useAppStore.setState({ fileGateway: createBrowserFileGateway({ showSaveFilePicker: () => Promise.reject(new DOMException('cancel', 'AbortError')) }) });
    expect(await exportSolidResultCsv(f.session, f.controller.signal)).toBe(false);
    useAppStore.setState({ fileGateway: createBrowserFileGateway({ showSaveFilePicker: () => Promise.reject(new Error('disk failure')) }) });
    await expect(exportSolidResultCsv(f.session, f.controller.signal)).rejects.toThrow('disk failure');
  });
});
