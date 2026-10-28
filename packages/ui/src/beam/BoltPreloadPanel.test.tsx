import { t } from '../i18n/t.js';
import { testPlacement } from '../../../model/src/analysis/beamInputs.testSupport.js';
import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoltPreloadPanel, BoltPreloadAssociation } from './BoltPreloadPanel.js';
import { StrengthPropertyPanel } from '../strength/StrengthPropertyPanel.js';
import { BOLT_AUTHOR_NUMBERS, BOLT_AUTHOR_EVIDENCE, type BoltAuthorNumber } from '../store/beamSlice.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUndoStack, resolveAssembly, buildStandardPartFromSource } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import type { FemWorkerPort } from '@pointercad/fem';
import { savedBoltFixture } from '../../../model/src/analysis/cadNativeBoltPreloadInput.testSupport.js';
import { prepareNativeBoltPreload } from '../../../fem/src/nativeBoltPreload.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamUiFixture } from './beam.testSupport.js';
import { attachBeamAnalysis, type BeamAttachment } from './attachBeamAnalysis.js';
import { captureBeamSource } from './beamSource.js';

class Port implements FemWorkerPort {
  onmessage: FemWorkerPort['onmessage'] = null;
  onerror: FemWorkerPort['onerror'] = null;
  onmessageerror: FemWorkerPort['onmessageerror'] = null;
  request: Parameters<FemWorkerPort['postMessage']>[0] | null = null;
  terminated = 0;
  postMessage(request: Parameters<FemWorkerPort['postMessage']>[0]): void { this.request = request; }
  terminate(): void { this.terminated += 1; }
}
let attachment: BeamAttachment | null = null;
beforeEach(() => { resetTestStore(); vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot()); });
afterEach(() => { attachment?.dispose(); attachment = null; vi.restoreAllMocks(); resetTestStore(); });
function draft() { const d = useAppStore.getState().boltPreloadDraft; if (d === null) throw new Error('Draft missing'); return d; }
function setup() {
  const f = savedBoltFixture(), ui = beamUiFixture(), view = ui.state.assemblyView;
  if (view === null) throw new Error('Publication fixture missing');
  const source = { ...f.saved.source, geometryRevision: `${f.document.id}:1` }, bolts = f.saved.cadDefinition.axialBolts;
  if (bolts === undefined) throw new Error('Existing association missing');
  const saved = { ...f.saved, source, input: { ...f.saved.input, source }, cadDefinition: { ...f.saved.cadDefinition, source, axialBolts: { ...bolts, source } } };
  const document = withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1', analyses: [
    { kind: 'standard-members', definition: { ...f.definition, id: 'other-analysis', axialBolts: { ...bolts, analysisId: 'other-analysis' } } }, { kind: 'native-bolt-preload', definition: saved }] });
  const owner = { ...ui.owner, document, activeDocumentId: document.id, documentVersion: source.documentRevision, generation: 1 };
  const state = { ...ui.state, assembly: document, activeDocumentId: document.id, documentVersion: source.documentRevision,
    requestedGeneration: 1, completedGeneration: 1, assemblyUndoStack: createUndoStack({ document, library: ui.state.assemblyLibrary }),
    assemblyView: { ...view, sourceDocument: document, meshOwnership: owner, resolved: resolveAssembly(document, { library: ui.state.assemblyLibrary, standardPart: buildStandardPartFromSource }) } };
  useAppStore.setState(state);
  const ports: Port[] = [];
  attachment = attachBeamAnalysis(useAppStore, () => { const p = new Port(); ports.push(p); return p; });
  useAppStore.getState().openBoltPreload(saved.id);
  return { ...f, saved, document, state, ports };
}
async function review() {
  useAppStore.getState().confirmBoltPreload(true);
  await useAppStore.getState().reviewBoltPreload();
  expect(useAppStore.getState().boltPreloadError).toBeNull(); expect(draft().reviewed).not.toBeNull();
}
async function start(ports: Port[]) {
  const count = ports.length; useAppStore.getState().runBoltPreload();
  await vi.waitFor(() => { expect(ports).toHaveLength(count + 1); expect(ports[count].request?.kind).toBe('analyze-native-bolt-preload'); });
  return ports[count];
}
/** Independent, controlled two-spring oracle for the approved FB50x6 50+50mm CAD fixture.
 * No native execution. cm=100/(200000*300)mm/N=1/600000000m/N, cb=10nm/N.
 * All fixture loads are below separation: N=4000+P/7, Q=4000-6P/7.
 * u=[0,-Qcm/2,-Qcm/2,-Qcm] along +Z, R1=-P, U=cbN²/2+cmQ²/2. */
async function response(port: Port) {
  const request = port.request;
  if (request?.kind !== 'analyze-native-bolt-preload') throw new Error('Dedicated request missing');
  const prepared = await prepareNativeBoltPreload(request.input.plan), cm = 1 / 600000000, cb = 1e-8, s = 7 / 150000;
  expect(prepared.cm).toBeCloseTo(cm, 18); expect(prepared.cb).toBeCloseTo(cb, 18); expect(prepared.plan.shorteningM).toBeCloseTo(s, 16);
  const forceRows = [0, 1000, 0].map((p, i) => {
    const n = 4000 + p / 7, q = 4000 - 6 * p / 7;
    return { stage: i === 0 ? 'tightening' : 'external', externalLoadN: p, boltId: 'tie', extensionM: -q * cm,
      elasticExtensionM: cb * n, boltTensionN: n, memberCompressionN: q, gapM: 0,
      boltEnergyJ: cb * n * n / 2, memberEnergyJ: cm * q * q / 2,
      supportReactions: [1, 2, 3, 4].map(number => ({ number, forceN: [0, 0, number === 1 ? -p : 0] })) };
  });
  return { kind: 'native-bolt-preload-stages', source: request.input.source,
    schema: 'pointercad-native-bolt-preload-result/1', method: 'native-beam3d-plus-series-bolt-and-existing-lcp',
    nativeContactSolver: false, structuralCertification: false, lockedShorteningM: prepared.plan.shorteningM, lockAfterState: 0,
    boltComplianceMPerN: cb, memberComplianceMPerN: cm, planSha256: prepared.inputSha256, states: forceRows,
    contact: { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
      freeDofs: 3, meshNodes: 4, meshElements: 2, momentLengthM: .05, pivotLimit: 20,
      states: forceRows.map(row => ({ loadFactor: row.externalLoadN, pivots: 1,
        nodes: [0, -row.memberCompressionN * cm / 2, -row.memberCompressionN * cm / 2, -row.memberCompressionN * cm]
          .map((u, i) => ({ number: i + 1, displacementM: [0, 0, u], rotationRad: [0, 0, 0] })),
        contacts: [{ id: 'interface', state: 'closed', normalReactionN: row.memberCompressionN, gapM: 0 }],
        forceScaleN: 4000, gapScaleM: s, equilibriumResidual: 0, penetration: 0, tension: 0, complementarity: 0 })) } };
}
function reply(port: Port, result: unknown) {
  const request = port.request; if (request === null) throw new Error('Request missing');
  port.onmessage?.(new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } }));
}
async function completed(port: Port) {
  reply(port, await response(port)); await vi.waitFor(() => expect(useAppStore.getState().boltPreloadStatus).toBe('complete'));
}

interface Control { readonly children?: ReactNode; readonly 'data-testid'?: string; readonly 'data-preload-number'?: string;
 readonly 'data-preload-new'?: string; readonly disabled?: boolean;
 readonly onClick?: () => void; readonly onChange?: (event: { target: { value: string; checked: boolean } }) => void; }
function controls(author = false): Control[] {
  const found: Control[] = [];
  function walk(node: ReactNode): void { Children.forEach(node, child => {
    if (!isValidElement<Control>(child)) return; found.push(child.props); walk(child.props.children);
  }); }
  function Probe(): null { const form = useAppStore.getState().boltPreloadAuthor;
    walk(author && form !== null ? BoltPreloadAssociation({ form }) : BoltPreloadPanel()); return null; }
  renderToStaticMarkup(<Probe />); return found;
}
function one(key: string, author = false): Control { const found = controls(author).filter(row => row['data-testid'] === key);
  expect(found, key).toHaveLength(1); return found[0]; }
function click(key: string, author = false): void { const control = one(key, author); expect(control.disabled).not.toBe(true); control.onClick?.(); }
function change(key: string, value: string, author = false, checked = false): void { one(key, author).onChange?.({ target: { value, checked } }); }
function explicitForm(reassociate = true) {
  if (reassociate) click('preload-reassociate');
  else { useAppStore.getState().closeBoltPreload(); const button = controls().find(row => row['data-preload-new'] === 'saved:axial');
    expect(button).toBeDefined(); button?.onClick?.(); change('preload-analysis-id', 'new-axial', true); }
  const form = useAppStore.getState().boltPreloadAuthor; if (form === null) throw new Error('Missing form');
  expect(Object.values(form.values).every(value => value === '')).toBe(true);
  change('preload-member-0', '["a"]', true); change('preload-member-1', '["b"]', true);
  change('preload-bolt', 'selected-bolt', true); change('preload-contact', 'interface', true);
  const values: Readonly<Record<BoltAuthorNumber, string>> = {
    young0: '200000', shear0: String(200000 / 2.6), density0: '7850', area0: '300', iy0: '900', iz0: '62500', torsion0: '3300', factor0: String(5 / 6),
    young1: '200000', shear1: String(200000 / 2.6), density1: '7850', area1: '300', iy1: '900', iz1: '62500', torsion1: '3300', factor1: String(5 / 6),
    boltYoung: '200000', boltArea: '100', preloadN: '4000', threadCompliance: '2e-9', headCompliance: '1e-9', bearingCompliance: '2e-9', memberCompliance: String(1 / 600000000) };
  for (const field of BOLT_AUTHOR_NUMBERS) {
    const control = controls(true).find(row => row['data-preload-number'] === field); expect(control).toBeDefined();
    control?.onChange?.({ target: { value: values[field], checked: false } });
  }
  for (const field of BOLT_AUTHOR_EVIDENCE) useAppStore.getState().editBoltPreloadAuthor({ kind: 'evidence', field,
    value: { kind: 'user-supplied', reference: 'Independent FB50x6 50+50mm fixture', condition: 'Explicit elastic axial model; no strength certification' } });
  change('preload-author-loads', '1000\n0', true); change('preload-geometry-confirm', '', true, true);
}
async function preview() {
  click('preload-preview', true);
  await vi.waitFor(() => { expect(useAppStore.getState().boltPreloadError).toBeNull(); expect(useAppStore.getState().boltPreloadAuthor?.proposal).not.toBeNull(); });
}
describe('bolt preload panel/current association with real store and CAD adapter; controlled reply only', () => {
  it('does not invent missing properties, and new creation requires distinct identity and current selections', async () => {
    const f = setup(); useAppStore.getState().beginBoltPreloadAuthor('saved:axial', false);
    await useAppStore.getState().previewBoltPreloadAuthor(); expect(useAppStore.getState().boltPreloadAuthor?.proposal).toBeNull();
    expect(useAppStore.getState().boltPreloadError).not.toBeNull(); expect(useAppStore.getState().assembly).toBe(f.document);
    explicitForm(false); await preview(); click('preload-adopt', true);
    expect(draft().saved.id).toBe('new-axial'); expect(draft().confirmed).toBe(false); expect(draft().reviewed).toBeNull(); expect(draft().result).toBeNull();
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(0);
  });
  it('keeps no-consent and cancelled reassociation at zero saves; does not carry old confirmation', async () => {
    const f = setup(); await review(); explicitForm(); await preview();
    expect(draft().confirmed).toBe(false); expect(draft().reviewed).toBeNull();
    click('preload-author-cancel', true); expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(0); expect(draft().saved).toEqual(f.saved);
  });
  it('uses panel confirmation/review/run/result/save, preserving independent force and one Undo', async () => {
    const f = setup(); explicitForm(); await preview(); click('preload-adopt', true);
    change('preload-confirm', '', false, true); click('preload-review');
    await vi.waitFor(() => expect(draft().reviewed).not.toBeNull()); click('preload-run');
    await vi.waitFor(() => expect(f.ports[0]?.request?.kind).toBe('analyze-native-bolt-preload'));
    await completed(f.ports[0]); expect(draft().result?.states[1].boltTensionN).toBeCloseTo(29000 / 7, 8);
    expect(draft().result?.states[1].memberCompressionN).toBeCloseTo(22000 / 7, 8);
    expect(renderToStaticMarkup(<BoltPreloadPanel />)).toContain(t('beam.preload.resultScope')); click('preload-save');
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    expect(useAppStore.getState().assembly?.beamAnalysisInputs?.analyses[0]).toEqual(f.document.beamAnalysisInputs?.analyses[0]);
    expect(captureBeamSource(useAppStore.getState())).toBeNull(); expect(draft().confirmed).toBe(false); expect(draft().reviewed).toBeNull();
  });
  it.each(['document', 'generation', 'strength-owner'] as const)('refuses an awaited proposal after %s changes', async reason => {
    const f = setup(); explicitForm(); const work = useAppStore.getState().previewBoltPreloadAuthor();
    if (reason === 'document') useAppStore.setState({ assembly: { ...f.document, id: 'foreign-document' } });
    else if (reason === 'generation') useAppStore.setState({ requestedGeneration: 2 });
    else useAppStore.setState({ strengthSession: null });
    await work; expect(useAppStore.getState().boltPreloadAuthor?.proposal ?? null).toBeNull();
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(0); expect(f.ports).toHaveLength(0);
  });
  it.each(['duplicate-id', 'wrong-member', 'missing-evidence', 'wrong-compliance'] as const)('rejects %s before consent or worker', async reason => {
    const f = setup(); explicitForm(false);
    if (reason === 'duplicate-id') change('preload-analysis-id', 'axial', true);
    else if (reason === 'wrong-member') change('preload-member-1', '["a"]', true);
    else if (reason === 'missing-evidence') useAppStore.getState().editBoltPreloadAuthor({ kind: 'evidence', field: 'preloadN', value: { kind: 'user-supplied', reference: '', condition: '' } });
    else useAppStore.getState().editBoltPreloadAuthor({ kind: 'number', field: 'memberCompliance', text: '2.5e-9' });
    await useAppStore.getState().previewBoltPreloadAuthor(); expect(useAppStore.getState().boltPreloadAuthor?.proposal).toBeNull();
    expect(useAppStore.getState().boltPreloadError).not.toBeNull(); expect(f.ports).toHaveLength(0);
  });
  it('requires fresh explicit definition and consent for a newer current publication', async () => {
    const f = setup(), view = useAppStore.getState().assemblyView;
    if (view?.meshOwnership === undefined) throw new Error('Missing ownership');
    useAppStore.setState({ documentVersion: f.state.documentVersion + 1, requestedGeneration: 2, completedGeneration: 2,
      assemblyView: { ...view, meshOwnership: { ...view.meshOwnership, documentVersion: f.state.documentVersion + 1, generation: 2 } } });
    useAppStore.getState().confirmBoltPreload(true); await useAppStore.getState().reviewBoltPreload();
    expect(draft().reviewed).toBeNull(); expect(draft().saved.source).toEqual(f.saved.source);
    explicitForm(); await preview(); expect(draft().saved.source).toEqual(f.saved.source); click('preload-adopt', true);
    expect(draft().saved.source).toEqual({ documentId: f.document.id, documentRevision: f.state.documentVersion + 1, geometryRevision: `${f.document.id}:2` });
    expect(draft().saved.revision).toBe(f.saved.revision + 1); expect(draft().confirmed).toBe(false); expect(draft().result).toBeNull();
    expect(useAppStore.getState().assembly).toBe(f.document); expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(0);
  });
  it('rejects a physical 0.1mm bolt-axis offset despite explicit selections and consent', async () => {
    const f = setup(), view = useAppStore.getState().assemblyView;
    if (view?.meshOwnership === undefined) throw new Error('Missing ownership');
    const document = { ...f.document, components: f.document.components.map(component => component.id !== 'selected-bolt' ? component :
      { ...component, placement: testPlacement([25.1, 3, 0]) }) };
    useAppStore.setState({ assembly: document, assemblyView: { ...view, sourceDocument: document,
      meshOwnership: { ...view.meshOwnership, document }, resolved: resolveAssembly(document, { standardPart: buildStandardPartFromSource }) } });
    explicitForm(); await useAppStore.getState().previewBoltPreloadAuthor();
    expect(useAppStore.getState().boltPreloadAuthor?.proposal).toBeNull(); expect(useAppStore.getState().boltPreloadError).not.toBeNull();
    expect(f.ports).toHaveLength(0); expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(0);
  });
  it('drops late completion when the strength owner closes and keeps standard panel behavior', async () => {
    const f = setup(); await review(); const port = await start(f.ports), result = await response(port), callback = port.onmessage, request = port.request;
    if (request === null) throw new Error('Request missing'); useAppStore.setState({ strengthSession: null });
    callback?.(new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } }));
    expect(useAppStore.getState().boltPreloadDraft).toBeNull(); expect(port.terminated).toBe(1);
    expect(renderToStaticMarkup(<StrengthPropertyPanel />)).toBe('');
    const standard = beamUiFixture(); useAppStore.setState({ ...standard.state, beamSession: standard.session });
    expect(renderToStaticMarkup(<StrengthPropertyPanel />)).toContain('pcad-beam');
    expect(useAppStore.getState().beamSession).toBe(standard.session);
  });
});
