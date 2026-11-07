import { appendSolid, createEmptyPartDocument, type AnalysisBoundarySource } from '@pointercad/model';
import { parseDocument, serializeDocument } from '@pointercad/io';
import { readSolidCadSavedInput, type AnalysisMaterialCapacity } from '@pointercad/model/beam-analysis';
import { decodeTetraMesh, tetraMeshInputSha256, decodeSolidAnalysis, solidInputSha256, summarizeSolidYield,
  type FemWorkerPort, type SolidVector3 } from '@pointercad/fem';
import { createSolidAnalysisSession, solidSavedInput, type SolidField } from './solidAnalysisSession.js';
import { attachSolidAnalysis } from './attachSolidAnalysis.js';
import { context, boundaryMesh } from './solidAnalysis.testSupport.js';
import { resultFor, extrudeFeature } from '../store/testing/createTestStore.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import React, { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import type * as ReactTypes from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { solidYieldEvidenceLabel, solidYieldBasisLabel, SolidYieldSummaryView, startSolidYieldSummary, currentSolidYieldSummary, SolidAnalysisPanel } from './SolidAnalysisPanel.js';
import { StrengthPropertyPanel } from '../strength/StrengthPropertyPanel.js';
import { SolidAnalysisMaterialFields } from './SolidAnalysisMaterialFields.js';
import { t } from '../i18n/t.js';
import { createSolidSupport } from './solidBoundaryDraft.js';

type SolidAnalysisMaterialFieldsProps = Parameters<typeof SolidAnalysisMaterialFields>[0];

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof ReactTypes>();
  return { ...actual, useState: vi.fn(actual.useState), useEffect: vi.fn(actual.useEffect), useRef: vi.fn(actual.useRef) };
});
interface Props {
  readonly children?: ReactNode;
  readonly 'data-testid'?: string;
  readonly type?: string;
  readonly onClick?: () => void;
  readonly onCompositionStart?: () => void;
  readonly onCompositionEnd?: () => void;
  readonly onSubmit?: (event: { preventDefault(): void }) => void;
  readonly onKeyDown?: (event: { key: string; nativeEvent: { isComposing: boolean; keyCode: number };
    preventDefault(): void; stopPropagation(): void }) => void;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly field?: { readonly key: string };
  readonly onChange?: (value: string) => void;
}
function elements(): Props[] {
  const rows: Props[] = [];
  function walk(node: ReactNode): void { Children.forEach(node, child => {
    if (isValidElement<Props>(child)) { rows.push(child.props); walk(child.props.children); }
  }); }
  function Probe(): null {
    const session = useAppStore.getState().solidAnalysisSession;
    if (!session) throw new Error('Missing session');
    walk(SolidAnalysisPanel({ session })); return null;
  }
  renderToStaticMarkup(<Probe />); return rows;
}
function materialProps(): SolidAnalysisMaterialFieldsProps {
  let found: SolidAnalysisMaterialFieldsProps | null = null;
  function Probe(): null {
    const session = useAppStore.getState().solidAnalysisSession;
    if (!session) throw new Error('Missing session');
    const panel: ReactNode = SolidAnalysisPanel({ session });
    if (!isValidElement<{ readonly children?: ReactNode }>(panel)) throw new Error('Panel missing');
    Children.forEach(panel.props.children, child => {
      if (isValidElement<SolidAnalysisMaterialFieldsProps>(child) && child.type === SolidAnalysisMaterialFields) found = child.props;
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!found) throw new Error('Material controls missing');
  return found;
}
beforeEach(() => {
  resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null });
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
});
afterEach(async () => {
  const actual = await vi.importActual<typeof ReactTypes>('react');
  vi.mocked(useState).mockImplementation(actual.useState); vi.mocked(useEffect).mockImplementation(actual.useEffect);
  vi.mocked(useRef).mockImplementation(actual.useRef);
  vi.restoreAllMocks(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); resetTestStore();
});
describe('solid strength panel real handlers (Node, not browser acceptance)', () => {
  it('blocks calculation and save handlers for all-free or invalid gravity drafts', () => {
    useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidAnalysis();
    const session = useAppStore.getState().solidAnalysisSession;
    if (!session) throw new Error('Missing session');
    const runner = { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() };
    useAppStore.setState({ solidAnalysisRunner: runner, solidAnalysisSession: { ...session,
      supports: [{ ...createSolidSupport('face'), fixed: [false, false, false] }] } });
    const controls = elements(), run = controls.find(row => row['data-testid'] === 'solid-run'), save = controls.find(row => row['data-testid'] === 'solid-save');
    expect(run?.disabled).toBe(true); expect(save?.disabled).toBe(true);
    run?.onClick?.(); save?.onClick?.(); expect(runner.run).not.toHaveBeenCalled(); expect(runner.validate).not.toHaveBeenCalled();
    useAppStore.setState({ solidAnalysisSession: { ...session, gravity: { enabled: true, acceleration: ['0', '0', '-9.81'], density: '' } } });
    expect(elements().find(row => row['data-testid'] === 'solid-run')?.disabled).toBe(true);
    useAppStore.getState().editSolidGravity('density', '7800');
    expect(elements().find(row => row['data-testid'] === 'solid-run')?.disabled).toBe(false);
  });
  it('is reachable in the existing panel and does not run on implicit submit or IME confirmation', () => {
    useAppStore.getState().toggleStrength();
    expect(renderToStaticMarkup(<StrengthPropertyPanel />)).toContain('solid-analysis-open');
    const runner = { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() };
    useAppStore.setState({ solidAnalysisRunner: runner }); useAppStore.getState().openSolidAnalysis();
    expect(renderToStaticMarkup(<StrengthPropertyPanel />)).toContain('solid-analysis-panel');
    const rows = elements(), form = rows[0], run = rows.find(row => row['data-testid'] === 'solid-run');
    expect(run?.type).toBe('button');
    form.onSubmit?.({ preventDefault: vi.fn() }); expect(runner.run).not.toHaveBeenCalled();
    const before = useAppStore.getState().solidAnalysisSession;
    for (const key of ['Enter', 'Escape']) form.onKeyDown?.({ key, nativeEvent: { isComposing: true, keyCode: 229 },
      preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(useAppStore.getState().solidAnalysisSession).toBe(before);
    form.onCompositionStart?.(); run?.onClick?.(); expect(runner.run).not.toHaveBeenCalled();
    form.onCompositionEnd?.(); run?.onClick?.(); expect(runner.run).toHaveBeenCalledOnce();
    rows.find(row => row['data-testid'] === 'solid-fixed')?.onClick?.();
    expect(runner.captureFaces).toHaveBeenCalledWith('fixed');
    form.onKeyDown?.({ key: 'Escape', nativeEvent: { isComposing: false, keyCode: 27 },
      preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(useAppStore.getState().solidAnalysisSession).toBeNull();
  });
  it('shows exactly one load mode, its fields and the signed pressure explanation through the real handlers', () => {
    useAppStore.getState().toggleStrength();
    const runner = { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() };
    useAppStore.setState({ solidAnalysisRunner: runner }); useAppStore.getState().openSolidAnalysis();
    const fieldKeys = (): string[] => elements().flatMap(row => row.field ? [row.field.key] : []);
    const radio = (mode: 'traction' | 'pressure'): Props | undefined =>
      elements().find(row => row['data-testid'] === `solid-load-${mode}`);
    expect(radio('traction')?.checked).toBe(true); expect(radio('pressure')?.checked).toBe(false);
    expect(fieldKeys()).toEqual(['young', 'poisson', 'tx', 'ty', 'tz', 'linear', 'angular', 'chord', 'volume']);
    expect(renderToStaticMarkup(<StrengthPropertyPanel />)).not.toContain(t('solidAnalysis.pressureHelp'));
    runner.cancel.mockClear();
    radio('pressure')?.onChange?.('pressure');
    expect(runner.cancel).toHaveBeenCalledOnce();
    expect(useAppStore.getState().solidAnalysisSession?.loadMode).toBe('pressure');
    expect(radio('pressure')?.checked).toBe(true);
    expect(fieldKeys()).toEqual(['young', 'poisson', 'pressure', 'linear', 'angular', 'chord', 'volume']);
    const markup = renderToStaticMarkup(<StrengthPropertyPanel />);
    for (const key of ['solidAnalysis.loadMode', 'solidAnalysis.loadTraction', 'solidAnalysis.loadPressure',
      'solidAnalysis.pressure', 'solidAnalysis.pressureHelp'] as const) expect(markup).toContain(t(key));
    elements().find(row => row.field?.key === 'pressure')?.onChange?.('-3');
    expect(useAppStore.getState().solidAnalysisSession?.values.pressure).toBe('-3');
    radio('traction')?.onChange?.('traction');
    expect(useAppStore.getState().solidAnalysisSession).toMatchObject({ loadMode: 'traction', values: { pressure: '-3' } });
  });
});

type Request = Parameters<FemWorkerPort['postMessage']>[0];
function port() {
  let request: Request | null = null;
  const worker: FemWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage: value => { request = value; }, terminate: vi.fn() };
  return { worker, request: () => request, reply: async () => {
    if (!request) throw new Error('No request');
    const message = request;
    if (message.kind === 'mesh-cad-convex-tetra') {
      const input = message.input;
      const result = decodeTetraMesh({ coordinates: [...input.coordinates, 1, 1.5, 2],
        tetrahedra: input.triangles.flatMap((_, i, all) => i % 3 === 0 ? [8, all[i], all[i + 1], all[i + 2]] : []),
        boundaryTriangles: input.triangles, boundaryTags: input.tags }, input, await tetraMeshInputSha256(input));
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: message.protocol, kind: 'result', identity: message.identity, result } }));
    } else if (message.kind === 'analyze-solid-tet4') {
      const input = message.input, stress = 2, young = input.materials[0].youngMPa;
      const sub = (a: SolidVector3, b: SolidVector3): SolidVector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const cross = (a: SolidVector3, b: SolidVector3): SolidVector3 =>
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      // Independent uniform zz stress: force at node i = sigma_zz * oriented opposite-face area_z / 3.
      const elementForcesN = input.elements.map(element => {
        const [a, b, c, d] = element.nodes.map(index => input.nodes[index]);
        const gradientsTimesDet = [cross(sub(c, b), sub(d, b)).map(value => -value),
          cross(sub(c, a), sub(d, a)), cross(sub(d, a), sub(b, a)), cross(sub(b, a), sub(c, a))];
        return gradientsTimesDet.flatMap(vector => [0, 0, stress * vector[2] / 6]);
      });
      const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
        displacementMm: input.nodes.map(node => [0, 0, stress * node[2] / young]), elementForcesN,
        reservedNumericBytes: 1000000, minimumScaledPivot: 1 }, input, await solidInputSha256(input));
      worker.onmessage?.(new MessageEvent<unknown>('message', { data: { protocol: message.protocol, kind: 'result', identity: message.identity, result } }));
    } else throw new Error('Unexpected beam route');
  } };
}
function installYieldFixture() {
  const body = context().body, document = appendSolid(createEmptyPartDocument(), extrudeFeature('box'));
  useAppStore.getState().resetDocument(document);
  useAppStore.getState().recordRecomputeRequest(7);
  useAppStore.getState().applyRecompute(document, { ...resultFor(document), generation: 7, bodies: [body] });
  useAppStore.getState().recordRecomputeCompletion(7, 'success');
  const ports: ReturnType<typeof port>[] = [];
  const kernel: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request =>
    Promise.resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh: boundaryMesh() }) };
  const attachment = attachSolidAnalysis(kernel, useAppStore, () => { const value = port(); ports.push(value); return value.worker; });
  attachment.captureResolved(document, 7, { errors: [], steps: [{ featureId: 'box', key: 'box:7' }] });
  useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidAnalysis();
  const pick = (index: number, role: 'fixed' | 'loaded') => {
    useAppStore.getState().setSelection([subShapeElementId('box', 'face', index)], { kind: 'pick' });
    useAppStore.getState().solidAnalysisRunner?.captureFaces(role);
  };
  pick(0, 'fixed'); pick(1, 'loaded');
  const fields: [SolidField, string][] = [['young', '210000'], ['poisson', '0'], ['tz', '2'], ['volume', '0.1']];
  for (const [name, value] of fields) useAppStore.getState().editSolidAnalysis(name, value);
  return { attachment, ports, document, pick };
}

function yieldCapacity(): AnalysisMaterialCapacity {
  return { materialConditionId: 'ss400-plate-0-16', yieldMPa: 245, sourceId: 'jisf-g3101-draft', thicknessMm: 16,
    condition: '圧延鋼板（熱処理の指定なし）', evidence: 'standard-draft', basis: 'minimum' };
}
function savedYieldInput() {
  return readSolidCadSavedInput({ schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: 'part' },
    bodyFeatureId: 'box', fixedFaces: ['fixed'], loadedFaces: ['loaded'], youngMPa: 210000, poisson: 0,
    tractionMPa: [0, 0, 2], capacity: yieldCapacity(), linearDeflectionMm: .1, angularDeflectionRad: .3,
    maximumChordDeviationMm: .2, maximumVolumeDeviationMm3: .1 });
}
describe('reachable source-bound solid yield display', () => {
  it('preserves the invalid thickness text through the real store parent null echo', async () => {
    const rig = installYieldFixture();
    try {
      useAppStore.getState().setSolidAnalysisMaterial(yieldCapacity(), true);
      const actual = await vi.importActual<typeof ReactTypes>('react'), values: unknown[] = [], refs: React.RefObject<unknown>[] = [];
      const effects: React.EffectCallback[] = [];
      let slot = 0, refSlot = 0;
      vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, React.Dispatch<React.SetStateAction<unknown>>] => {
        const index = slot++, [own] = actual.useState(initial);
        if (index >= values.length) values[index] = own;
        return [values[index], next => { values[index] = next; }];
      });
      vi.mocked(useRef).mockImplementation((initial: unknown): React.RefObject<unknown> => {
        const index = refSlot++, own = actual.useRef(initial);
        if (index >= refs.length) refs[index] = own;
        return refs[index];
      });
      vi.mocked(useEffect).mockImplementation(effect => { effects.push(effect); });
      interface Row { readonly children?: ReactNode; readonly 'data-testid'?: string; readonly value?: string;
        readonly onChange?: (event: { readonly target: { readonly value: string } }) => void }
      const render = (): Row[] => {
        slot = 0; refSlot = 0; effects.length = 0; const rows: Row[] = [];
        const walk = (node: ReactNode): void => { Children.forEach(node, child => {
          if (isValidElement<Row>(child)) { rows.push(child.props); walk(child.props.children); }
        }); };
        function Probe(): null {
          const session = useAppStore.getState().solidAnalysisSession;
          if (!session) throw new Error('Missing session');
          const panel: ReactNode = SolidAnalysisPanel({ session });
          if (!isValidElement<{ readonly children?: ReactNode }>(panel)) throw new Error('Missing panel');
          Children.forEach(panel.props.children, child => {
            if (isValidElement<SolidAnalysisMaterialFieldsProps>(child) && child.type === SolidAnalysisMaterialFields) {
              const outer = SolidAnalysisMaterialFields(child.props);
              const element: React.ReactElement<SolidAnalysisMaterialFieldsProps, (props: SolidAnalysisMaterialFieldsProps) => React.JSX.Element> = outer;
              walk(element.type(element.props));
            }
          });
          return null;
        }
        renderToStaticMarkup(<Probe />); for (const effect of [...effects]) effect(); return rows;
      };
      const field = (): Row => {
        const value = render().find(row => row['data-testid'] === 'solid-material-thickness');
        if (!value) throw new Error('Missing thickness field'); return value;
      };
      expect(field().value).toBe('16');
      field().onChange?.({ target: { value: '17' } });
      expect(useAppStore.getState().solidAnalysisSession).toMatchObject({ materialInputValid: false });
      expect(useAppStore.getState().solidAnalysisSession?.capacity).toBeUndefined();
      expect(field().value).toBe('17');
    } finally { rig.attachment.dispose(); }
  });
  it('routes an actual panel edit through saved input, reopen and the real Worker request', async () => {
    const rig = installYieldFixture();
    try {
      const initial = materialProps(); initial.onChange(yieldCapacity(), true);
      expect(materialProps().selectionKey).toBe(initial.selectionKey);
      const before = useAppStore.getState().undoStack.past.length;
      useAppStore.getState().saveSolidAnalysis();
      expect(useAppStore.getState().undoStack.past.length).toBe(before + 1);
      const saved = useAppStore.getState().document.beamAnalysisInputs?.analyses.find(row => row.kind === 'solid-cad');
      expect(saved?.definition.capacity).toEqual(yieldCapacity());
      const parsed = parseDocument(serializeDocument(useAppStore.getState().document, { savedAt: '2026-10-19T00:00:00.000Z' }));
      if (!parsed.ok) throw new Error(parsed.error.message);
      useAppStore.getState().closeSolidAnalysis(); useAppStore.getState().resetDocument(parsed.document);
      useAppStore.getState().recordRecomputeRequest(8);
      useAppStore.getState().applyRecompute(parsed.document, { ...resultFor(parsed.document), generation: 8, bodies: [context().body] });
      useAppStore.getState().recordRecomputeCompletion(8, 'success');
      rig.attachment.captureResolved(parsed.document, 8, { errors: [], steps: [{ featureId: 'box', key: 'box:8' }] });
      if (useAppStore.getState().strengthSession === null) useAppStore.getState().toggleStrength();
      useAppStore.getState().openSolidAnalysis();
      expect(materialProps().selectionKey).not.toBe(initial.selectionKey);
      expect(materialProps().value).toEqual(yieldCapacity());
      useAppStore.getState().solidAnalysisRunner?.run();
      await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
      await rig.ports[0].reply();
      await vi.waitFor(() => expect(rig.ports[1]?.request()?.kind).toBe('analyze-solid-tet4'));
      const request = rig.ports[1].request();
      if (request?.kind !== 'analyze-solid-tet4') throw new Error('Worker request missing');
      expect(request.input.materials[0].capacity).toEqual(yieldCapacity());
    } finally { rig.attachment.dispose(); }
  });
  it('keeps its opening key after a null parent echo and blocks invalid run and save', () => {
    const rig = installYieldFixture();
    try {
      const initial = materialProps(); initial.onChange(yieldCapacity(), true);
      const active = materialProps(); active.onChange(null, false);
      const echo = materialProps(); expect(echo.selectionKey).toBe(active.selectionKey); expect(echo.value).toBeNull();
      const rows = elements(), run = rows.find(row => row['data-testid'] === 'solid-run');
      const save = rows.find(row => row['data-testid'] === 'solid-save');
      expect(run?.disabled).toBe(true); expect(save?.disabled).toBe(true);
      const before = useAppStore.getState().document;
      run?.onClick?.(); save?.onClick?.(); expect(useAppStore.getState().document).toBe(before); expect(rig.ports).toHaveLength(0);
      echo.onChange(null, true);
      expect(elements().find(row => row['data-testid'] === 'solid-run')?.disabled).toBe(false);
    } finally { rig.attachment.dispose(); }
  });
  it('preserves authored capacity through actual session save/open and rejects invalid evidence', () => {
    const saved = savedYieldInput(), session = createSolidAnalysisSession('owner', saved);
    expect(solidSavedInput(session, 'part', []).capacity).toEqual(yieldCapacity());
    expect(session.capacity).not.toBe(saved.capacity);
    const reopened = createSolidAnalysisSession('new-owner', solidSavedInput(session, 'part', []));
    expect(reopened.capacity).toEqual(yieldCapacity());
    expect(() => solidSavedInput({ ...session, capacity: { ...yieldCapacity(), thicknessMm: 17 } }, 'part', [])).toThrow();
    const legacy = { ...saved }; delete legacy.capacity;
    expect(createSolidAnalysisSession('owner', legacy)).not.toHaveProperty('capacity');
  });
  it('routes saved evidence through actual CAD producer and public Worker input, then displays independent 245/2', async () => {
    const rig = installYieldFixture();
    try {
      const state = useAppStore.getState(), session = state.solidAnalysisSession;
      if (!session) throw new Error('Session required');
      useAppStore.setState({ solidAnalysisSession: { ...session, capacity: yieldCapacity() } });
      useAppStore.getState().solidAnalysisRunner?.run();
      await vi.waitFor(() => expect(rig.ports[0]?.request()?.kind).toBe('mesh-cad-convex-tetra'));
      await rig.ports[0].reply();
      await vi.waitFor(() => expect(rig.ports[1]?.request()?.kind).toBe('analyze-solid-tet4'));
      const request = rig.ports[1].request();
      if (request?.kind !== 'analyze-solid-tet4') throw new Error('Actual solid Worker request missing');
      expect(request.input.materials[0].capacity).toEqual(yieldCapacity());
      await rig.ports[1].reply();
      await vi.waitFor(() => expect(useAppStore.getState().solidAnalysisSession?.status).toBe('complete'));
      const outcome = useAppStore.getState().solidAnalysisSession?.result;
      if (!outcome) throw new Error('Result required');
      const summary = await summarizeSolidYield(outcome.prepared.input, outcome.result);
      expect(summary.minimumYieldRatio).toBeCloseTo(122.5, 12);
      const viewRequest = { input: outcome.prepared.input, result: outcome.result, owner: 'current' };
      const markup = renderToStaticMarkup(<SolidYieldSummaryView request={viewRequest} completion={{ ...viewRequest, summary }} />);
      const displayed = markup.match(/data-testid="solid-yield-minimum" data-unit="1" data-value="([^"]+)"/u)?.[1];
      expect(displayed).toBeDefined(); expect(Number(displayed)).toBeCloseTo(122.5, 12);
      expect(markup).toContain('jisf-g3101-draft');
      expect(markup).toContain('16 mm'); expect(markup).toContain(t('solidAnalysis.yieldScope'));
      expect(markup).toContain('data-structural-certification="false"');
      const full = renderToStaticMarkup(<StrengthPropertyPanel />);
      for (const key of ['solidAnalysis.displacement', 'solidAnalysis.reaction', 'solidAnalysis.energy'] as const) expect(full).toContain(t(key));
      expect(full).toContain(t('solidAnalysis.yieldPending'));
      expect(full).toContain('data-solid-nodes="9"');
      expect(full).toContain('data-solid-dof-total="27"');
      expect(full).toContain('data-solid-node-limit="10000"');
      const published: NonNullable<Parameters<typeof currentSolidYieldSummary>[0]>[] = [];
      startSolidYieldSummary(viewRequest, value => published.push(value));
      await vi.waitFor(() => expect(published).toHaveLength(1));
      for (const changed of [{ ...viewRequest, owner: 'other' }, { ...viewRequest, input: structuredClone(viewRequest.input) },
        { ...viewRequest, result: structuredClone(viewRequest.result) }]) {
        expect(currentSolidYieldSummary(published[0], changed)).toBeNull();
        expect(renderToStaticMarkup(<SolidYieldSummaryView request={changed} completion={published[0]} />)).not.toContain('data-value=');
      }
      useAppStore.getState().editSolidAnalysis('tz', '3');
      expect(useAppStore.getState().solidAnalysisSession?.result).toBeNull();
      expect(renderToStaticMarkup(<StrengthPropertyPanel />)).not.toContain('data-solid-dof-total=');
    } finally { rig.attachment.dispose(); }
  });
  it('drops completion after cleanup and shows a rejection as recheck rather than zero', async () => {
    const saved = savedYieldInput();
    // Use a real, independently prescribed zero-load unit-tet, not a fabricated summary or native run.
    const input = { schema: 'pointercad-solid-tet4/1', source: { documentId: 'd', revision: 1, meshKey: 'm' }, units: 'N-mm-MPa',
      numericBudgetBytes: 1000000, nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
      elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }], materials: [{ id: 'm', youngMPa: 210000, poisson: 0, capacity: saved.capacity }],
      constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
        { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }], nodalLoads: [], surfaceLoads: [] } as const;
    const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
      displacementMm: input.nodes.map(() => [0, 0, 0]), elementForcesN: [Array.from({ length: 12 }, () => 0)],
      reservedNumericBytes: 50000, minimumScaledPivot: 1 }, input, await solidInputSha256(input));
    const summary = await summarizeSolidYield(input, result), request = { input, result, owner: 'o' };
    const markup = renderToStaticMarkup(<SolidYieldSummaryView request={request} completion={{ ...request, summary }} />);
    expect(markup).toContain(t('solidAnalysis.yieldZero')); expect(markup).not.toContain('Infinity');
    const publish = vi.fn(), stop = startSolidYieldSummary(request, publish, () => Promise.resolve(summary));
    stop(); await Promise.resolve(); expect(publish).not.toHaveBeenCalled();
    const failed = renderToStaticMarkup(<SolidYieldSummaryView request={request} completion={{ ...request, summary: null }} />);
    expect(failed).toContain('role="alert"'); expect(failed).toContain(t('solidAnalysis.changed')); expect(failed).not.toContain('data-value=');
  });
});

it('uses exhaustive Japanese evidence and basis labels while preserving source IDs', () => {
  expect(solidYieldEvidenceLabel('supplier-excerpt')).toBe('供給元資料の抜粋');
  expect(solidYieldEvidenceLabel('manufacturer-reference')).toBe('製造元の参考資料');
  expect(solidYieldEvidenceLabel('measured-reference')).toBe('測定資料');
  expect(solidYieldEvidenceLabel('standard-draft')).toBe('規格の原案');
  expect(solidYieldBasisLabel('minimum')).toBe('最小値');
  expect(solidYieldBasisLabel('reference')).toBe('参考値');
});

describe('transient solid pipeline stage display', () => {
  it.each([
    ['preparing', '形状の準備'], ['meshing', 'メッシュの作成'], ['solving', '変形と応力の計算'],
  ] as const)('shows the actual %s stage in the existing status row', (stage, label) => {
    const session = { ...createSolidAnalysisSession('progress-owner'), status: 'running' as const, stage };
    const html = renderToStaticMarkup(<SolidAnalysisPanel session={session} />);
    expect(html).toContain('data-testid="solid-analysis-progress"');
    expect(html).toContain(`data-stage="${stage}"`); expect(html).toContain(label);
    expect(html.match(/role="status"/gu)).toHaveLength(1);
    const complete = renderToStaticMarkup(<SolidAnalysisPanel session={{ ...session, status: 'complete' }} />);
    expect(complete).not.toContain('solid-analysis-progress');
  });
});
