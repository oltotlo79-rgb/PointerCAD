import {
  decodeBeamTransient, transientInputSha256, transientLoadFactor, transientOutputSteps, translateBeamTransient,
  type AxialFatigueProvenance, type BeamTransientInput, type BeamTransientResult, type FemWorkerPort,
} from '@pointercad/fem';
import { readBeamAnalysisInputs, type FatigueSavedAxialProvenance } from '@pointercad/model/beam-analysis';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachBeamAnalysis, type BeamAttachment } from '../beam/attachBeamAnalysis.js';
import { requireBeamSession } from '../beam/beam.testSupport.js';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { editBeamSession, type BeamEdit, type BeamSession } from '../beam/beamSession.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachFatigue, fatigueLifecycle } from './attachFatigue.js';
import { FatiguePanel } from './FatiguePanel.js';
import { BASE_EDITS, edited } from './fatigue.testSupport.js';
import { axialSources, fatigueDraftIsSaved, fatigueInput, importAxialHistory, sameAxialSources, savedFatigueInput,
  type FatigueEdit, type FatigueSession } from './fatigueSession.js';

/* Hand derivation, fixed before execution. The beam fixture (beamBuckling.testSupport) has one member from
 * (25, 3, 0) to (25, 3, 2000) mm, so L = 2 m along +Z. The protocol fixture moves the end node by
 * u_z = -1e-6 * step / 200 m; with every 4th of 200 steps returned, sample k (0..50) is step 4k, so the member-mean
 * axial strain is u_z / L = -1e-8 * k and the stress is E * strain = -E[MPa] * 1e-8 * k MPa, where E[MPa] is the
 * fixture's youngModulus in N/mm2 (= MPa). The sample time is 1e-4 s * 4k. Nothing here comes from the adapter. */
type Vector3 = readonly [number, number, number];
class Port implements FemWorkerPort {
  onmessage: FemWorkerPort['onmessage'] = null;
  onerror: FemWorkerPort['onerror'] = null;
  onmessageerror: FemWorkerPort['onmessageerror'] = null;
  request: Parameters<FemWorkerPort['postMessage']>[0] | null = null;
  postMessage(request: Parameters<FemWorkerPort['postMessage']>[0]): void { this.request = request; }
  terminate(): void { /* owned by attachBeamAnalysis */ }
}
const TOLERANCE = 1e-12;
const near = (actual: number, expected: number): boolean =>
  Math.abs(actual - expected) <= TOLERANCE * Math.max(Math.abs(expected), Number.MIN_VALUE);

let beamAttachment: BeamAttachment | null = null;
let detachFatigue: (() => void) | null = null;
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => {
  detachFatigue?.(); detachFatigue = null;
  beamAttachment?.dispose(); beamAttachment = null;
  vi.restoreAllMocks();
  resetTestStore();
});

/** The same explicit transient form and protocol fixture as attachBeamAnalysis.transient.test.ts. */
async function completedTransient(order: 'beam-first' | 'fatigue-first' = 'beam-first'):
  Promise<{ readonly input: BeamTransientInput; readonly result: BeamTransientResult }> {
  const fixture = bucklingUiFixture(), ports: Port[] = [];
  let session: BeamSession = { ...fixture.session, analysisType: 'transient' };
  const edits: readonly BeamEdit[] = [
    { kind: 'transient-value', field: 'timeStep', source: '0.1 ms' }, { kind: 'transient-value', field: 'stepCount', source: '200' },
    { kind: 'transient-value', field: 'outputEvery', source: '4' }, { kind: 'transient-sample', index: 0, field: 'factor', source: '0' },
    { kind: 'transient-sample', index: 1, field: 'time', source: '2 ms' }, { kind: 'transient-sample', index: 1, field: 'factor', source: '1' },
    { kind: 'transient-sample-add' }, { kind: 'transient-sample', index: 2, field: 'time', source: '20 ms' },
    { kind: 'transient-sample', index: 2, field: 'factor', source: '1' },
  ];
  for (const edit of edits) session = editBeamSession(session, edit);
  const assembly = fixture.state.assembly;
  if (assembly === null) throw new Error('Fixture without assembly');
  // The real action creates the Undo stack applyAssembly needs (it silently does nothing without one); the published
  // fixture state (view, ownership, strength session) is then restored with that stack.
  useAppStore.getState().openAssembly(assembly, fixture.state.assemblyLibrary);
  const assemblyUndoStack = useAppStore.getState().assemblyUndoStack;
  useAppStore.setState({ ...fixture.state, assemblyUndoStack, beamSession: session });
  // Zustand notifies listeners synchronously in registration order; both orders must give the same states.
  if (order === 'fatigue-first') detachFatigue = attachFatigue();
  beamAttachment = attachBeamAnalysis(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
  if (order === 'beam-first') detachFatigue = attachFatigue();
  useAppStore.getState().reviewBeam();
  useAppStore.getState().runBeam();
  await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
  const port = ports[0], request = port?.request;
  if (port === undefined || request?.kind !== 'analyze-beam-transient-3d') throw new Error('Expected a transient request');
  const input = request.input;
  const { plan } = translateBeamTransient(input);
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  const last = input.history.loadFactor[input.history.loadFactor.length - 1].timeS;
  const zero: Vector3 = [0, 0, 0];
  const end = (step: number): Vector3 => [0, 0, -1e-6 * step / 200];
  let peak = 0, peakStep = 0, peakNode = plan.nodes[0].number;
  const samples = transientOutputSteps(input.history).map(step => {
    const timeS = step === 0 ? 0 : input.history.timeStepS * step;
    return { timeS, loadFactor: transientLoadFactor(input.history.loadFactor, Math.min(timeS, last)),
      nodes: original.map(node => {
        const displacementM = node.id === 'beam-member-1-end' ? end(step) : zero;
        if (Math.hypot(...displacementM) > peak) { peak = Math.hypot(...displacementM); peakStep = step; peakNode = node.number; }
        return { number: node.number, displacementM, rotationRad: zero, velocityMPerS: zero,
          angularVelocityRadPerS: zero, accelerationMPerS2: zero, angularAccelerationRadPerS2: zero };
      }) };
  });
  const result = decodeBeamTransient({ schema: 'pointercad-oofem-transient-result/1',
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    maximumEquilibriumResidual: 0, maximumEnergyBalanceError: 0, peakDisplacementM: peak,
    peakDisplacementTimeS: peakStep === 0 ? 0 : input.history.timeStepS * peakStep, peakDisplacementSolverNode: peakNode,
    peakRotationRad: 0, peakRotationTimeS: 0, peakRotationSolverNode: plan.nodes[0].number, samples },
  input, await transientInputSha256(input));
  port.onmessage?.(new MessageEvent('message', { data: { protocol: request.protocol, identity: request.identity, kind: 'result', result } }));
  await vi.waitFor(() => expect(requireBeamSession().status).toBe('complete'));
  return { input, result };
}
function fatigue(): FatigueSession {
  const value = useAppStore.getState().fatigueSession;
  if (value === null) throw new Error('No fatigue session');
  return value;
}
function chooseMember(memberId: string, extra: readonly FatigueEdit[] = []): void {
  for (const edit of [{ kind: 'axial-member', memberId } as const, { kind: 'axial-sequence', value: 'once' } as const,
    { kind: 'axial-reference', source: 'Load case A' } as const, ...extra]) useAppStore.getState().editFatigue(edit);
}

describe('member-mean axial stress import into the fatigue records', () => {
  it('keeps the accepted transient result after the beam panel closes and imports the chosen member exactly', async () => {
    const { input, result } = await completedTransient();
    const kept = useAppStore.getState().fatigueAxialSource;
    // The client decodes the posted result again, so the kept result is equal to (not the same object as) the fixture.
    expect(kept?.result).toEqual(result);
    expect(kept?.result).toBe(requireBeamSession().result);
    useAppStore.getState().closeBeam();
    expect(useAppStore.getState().beamSession).toBeNull();
    expect(useAppStore.getState().fatigueAxialSource).toBe(kept);
    useAppStore.getState().openFatigue();
    for (const edit of BASE_EDITS) useAppStore.getState().editFatigue(edit);
    await useAppStore.getState().runFatigue();
    expect(fatigue().analyzed).not.toBeNull();
    const memberId = kept?.axial.members[0]?.memberId ?? '';
    chooseMember(memberId);
    // The form is not an analysis input: the current result stays until something is imported.
    expect(fatigue().analyzed).not.toBeNull();
    useAppStore.getState().importFatigueAxial();
    const session = fatigue();
    expect(session.errorKey).toBeNull();
    expect(session.analyzed).toBeNull();
    expect(session.draft.histories).toHaveLength(2);
    const row = session.draft.histories[1];
    const youngMpa = input.geometry.materials[0].youngModulus;
    expect(row?.imported?.stressMpa).toHaveLength(51);
    row?.imported?.stressMpa.forEach((stress, k) => {
      expect(near(stress, -youngMpa * 1e-8 * k) || (k === 0 && stress === 0), `sample ${k}: ${stress}`).toBe(true);
      expect(near(row.imported?.provenance.sampleTimesS[k] ?? Number.NaN, 4e-4 * k) || k === 0).toBe(true);
    });
    expect(row?.imported?.provenance).toMatchObject({ measure: 'member-mean-linear-axial-from-sampled-end-translations/1',
      stress: 'member-mean-linear-axial', excluded: 'bending-shear-torsion-local-combined-multiaxial', memberId,
      analysisId: result.analysisId, analysisRevision: result.analysisRevision, inputSha256: result.inputSha256,
      startNodeId: 'beam-member-1-start', endNodeId: 'beam-member-1-end', lengthM: 2, conversion: 'MPa = Pa / 1e6' });
    expect(row?.source.reference).toBe('Load case A');
    expect(row?.source.condition).toContain('member-mean linear axial stress');
    expect(session.draft.axialImport).toEqual({ memberId: '', sequence: '', repeats: '', reference: '' });
    // The analysis input uses the exact imported doubles.
    const built = fatigueInput(session, []);
    expect(built.ok ? built.input.histories[1]?.stressMpa : null).toEqual(row?.imported?.stressMpa);
  });

  it('keeps the provenance through save, a strict reload, reopen and Undo; edits that would falsify it are refused', async () => {
    await completedTransient();
    useAppStore.getState().closeBeam();
    useAppStore.getState().openFatigue();
    for (const edit of BASE_EDITS) useAppStore.getState().editFatigue(edit);
    chooseMember(useAppStore.getState().fatigueAxialSource?.axial.members[0]?.memberId ?? '');
    useAppStore.getState().importFatigueAxial();
    const imported = fatigue();
    // The stress list and condition of an imported history cannot be edited; the label can.
    expect(useAppStore.getState().fatigueSession).toBe(imported);
    useAppStore.getState().editFatigue({ kind: 'history-stress', index: 1, source: '1, 2, 3' });
    useAppStore.getState().editFatigue({ kind: 'history-source', index: 1, field: 'condition', source: 'edited' });
    expect(useAppStore.getState().fatigueSession).toBe(imported);
    useAppStore.getState().saveFatigue();
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('Assembly closed');
    const saved = savedFatigueInput(assembly);
    expect(saved?.schema).toBe('pointercad-fatigue-saved/2');
    expect(saved?.axial).toHaveLength(1);
    expect(saved?.axial[0]?.historyId).toBe(imported.draft.histories[1]?.key);
    // A JSON round trip through the strict document reader keeps every provenance field.
    const reread = readBeamAnalysisInputs(JSON.parse(JSON.stringify(assembly.beamAnalysisInputs)), assembly.id);
    const definition = reread.ok ? reread.value.analyses.find(input => input.kind === 'fatigue') : undefined;
    expect(definition?.kind === 'fatigue' && saved !== null && sameAxialSources(definition.definition.axial, saved.axial)).toBe(true);
    useAppStore.getState().closeFatigue();
    useAppStore.getState().openFatigue();
    expect(fatigue().draft.histories[1]?.imported?.provenance).toEqual(imported.draft.histories[1]?.imported?.provenance);
    expect(fatigueDraftIsSaved(fatigue(), assembly.parameters, saved)).toBe(true);
    // Detaching keeps the values but ends the provenance: an edit (result cleared) that differs from the saved file.
    useAppStore.getState().editFatigue({ kind: 'history-detach', index: 1 });
    expect(fatigue().draft.histories[1]?.imported).toBeNull();
    expect(axialSources(fatigue().draft)).toEqual([]);
    expect(fatigueDraftIsSaved(fatigue(), assembly.parameters, saved)).toBe(false);
    useAppStore.getState().undoAssembly();
    expect(savedFatigueInput(useAppStore.getState().assembly ?? assembly)).toBeNull();
    useAppStore.getState().redoAssembly();
    expect(savedFatigueInput(useAppStore.getState().assembly ?? assembly)?.axial[0]?.provenance)
      .toEqual(saved?.axial[0]?.provenance);
  });

  it('refuses a stale analysis after the CAD model changed, and drops the kept result after a beam input edit', async () => {
    await completedTransient();
    expect(useAppStore.getState().fatigueAxialSource).not.toBeNull();
    // A beam input edit moves the open beam session past the kept result's revision.
    const member = requireBeamSession().members[0];
    if (member === undefined) throw new Error('Fixture without member');
    useAppStore.getState().editBeam({ kind: 'value', id: member.id, field: 'endFz', source: '-2' });
    expect(useAppStore.getState().fatigueAxialSource).toBeNull();
  });

  it('refuses an import once the reviewed CAD source is no longer current', async () => {
    await completedTransient();
    useAppStore.getState().closeBeam();
    useAppStore.getState().openFatigue();
    chooseMember(useAppStore.getState().fatigueAxialSource?.axial.members[0]?.memberId ?? '');
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('Assembly closed');
    // A replaced assembly document is a different CAD source (beamSourceIsCurrent compares the document itself).
    useAppStore.setState({ assembly: { ...assembly } });
    const before = fatigue();
    useAppStore.getState().importFatigueAxial();
    expect(fatigue().errorKey).toBe('fatigue.error.axialStale');
    expect(fatigue().draft.histories).toBe(before.draft.histories);
  });

  it('refuses a measure of another result and every incomplete choice with its own message', async () => {
    const { result } = await completedTransient();
    const kept = useAppStore.getState().fatigueAxialSource;
    if (kept === null) throw new Error('Nothing kept');
    const memberId = kept.axial.members[0]?.memberId ?? '';
    const form = (axialImport: FatigueSession['draft']['axialImport']): FatigueSession =>
      ({ ...edited([]), draft: { ...edited([]).draft, axialImport } });
    const refused = (session: FatigueSession, axial = kept.axial) => {
      const checked = importAxialHistory(session, { result, axial }, []);
      return checked.ok ? null : [checked.key, checked.field];
    };
    const complete = { memberId, sequence: 'once', repeats: '', reference: 'Load case A' } as const;
    expect(refused(form(complete), { ...kept.axial, inputSha256: '0'.repeat(64) })).toEqual(['fatigue.error.axialStale', 'axial:member']);
    expect(refused(form({ ...complete, memberId: '' }))).toEqual(['fatigue.error.axialMember', 'axial:member']);
    expect(refused(form({ ...complete, memberId: 'no-such-member' }))).toEqual(['fatigue.error.axialMember', 'axial:member']);
    expect(refused(form({ ...complete, sequence: '' }))).toEqual(['fatigue.error.sequence', 'axial:sequence']);
    expect(refused(form({ ...complete, reference: '  ' }))).toEqual(['fatigue.error.axialReference', 'axial:reference']);
    expect(refused(form({ ...complete, sequence: 'repeated-periodic', repeats: '1.5' })))
      .toEqual(['fatigue.error.axialSelection', 'axial:repeats']);
    // The untouched starting row is replaced by the first import (no empty history is left behind).
    const accepted = importAxialHistory(form(complete), { result, axial: kept.axial }, []);
    expect(accepted.ok ? accepted.session.draft.histories.map(row => row.imported?.provenance.memberId) : null).toEqual([memberId]);
  });

  it('shows the measure limits, the unavailable state and imported rows as read-only', async () => {
    const empty = renderToStaticMarkup(<FatiguePanel session={edited(BASE_EDITS)} />);
    expect(empty).toContain(t('fatigue.axialMeasure'));
    expect(empty).toContain('data-testid="fatigue-axial-unavailable"');
    await completedTransient();
    useAppStore.getState().closeBeam();
    useAppStore.getState().openFatigue();
    chooseMember(useAppStore.getState().fatigueAxialSource?.axial.members[0]?.memberId ?? '');
    useAppStore.getState().importFatigueAxial();
    const html = renderToStaticMarkup(<FatiguePanel session={fatigue()} />);
    expect(html).toContain(t('fatigue.importedNote'));
    const stressFields = html.match(/<textarea\b[^>]*data-fatigue-field="history:0:stress"[^>]*>/gu);
    expect(stressFields).toHaveLength(1);
    expect(stressFields?.[0]).toMatch(/\sreadonly=""(?:\s|>)/iu);
    expect(html).toContain('data-fatigue-detach="0"');
  });
});

/* Regression for the fatigue-ui-r2 reentrancy (Sol attach-order-review.json ae7f2f18): closeStrength
 * (measureSlice.ts:133) writes only strengthSession: null and keeps the complete beam; r2 captured that beam with the
 * strength panel closed, cleared it on the synchronous nested notification, captured again, and so on. */
describe.each(['fatigue-first', 'beam-first'] as const)('fatigue source lifecycle with %s listener registration', order => {
  it('never captures with the strength panel closed, and the decision is a fixed point', async () => {
    await completedTransient(order);
    const state = useAppStore.getState();
    expect(state.fatigueAxialSource).not.toBeNull();
    // The exact r2 state: strength closed, the complete matched beam still present, nothing kept yet.
    const closed = fatigueLifecycle({ ...state, strengthSession: null, fatigueAxialSource: null });
    expect(closed).toEqual({ fatigueSession: null, fatigueAxialSource: null });
    const once = fatigueLifecycle(state), twice = fatigueLifecycle({ ...state, ...once });
    expect(twice.fatigueAxialSource).toBe(once.fatigueAxialSource);
    expect(twice.fatigueSession).toBe(once.fatigueSession);
  });

  it('closing the strength panel clears the kept source with a bounded number of store writes', async () => {
    await completedTransient(order);
    useAppStore.getState().openFatigue();
    let notifications = 0;
    const count = useAppStore.subscribe(() => { notifications += 1; });
    try {
      useAppStore.getState().closeStrength();
    } finally {
      count();
    }
    expect([useAppStore.getState().fatigueAxialSource, useAppStore.getState().fatigueSession]).toEqual([null, null]);
    // closeStrength itself, one fatigue write and one beam-panel close; r2 never stopped (stack overflow).
    expect(notifications).toBeLessThanOrEqual(4);
  });

  it('closing the document clears the kept source and the fatigue panel', async () => {
    await completedTransient(order);
    useAppStore.getState().openFatigue();
    const owner = useAppStore.getState().activeDocumentId;
    useAppStore.getState().closeAssembly();
    expect(useAppStore.getState().activeDocumentId).not.toBe(owner);
    expect([useAppStore.getState().fatigueAxialSource, useAppStore.getState().fatigueSession]).toEqual([null, null]);
  });

  it('a beam input edit (revision drift past the kept result) clears the kept source', async () => {
    await completedTransient(order);
    const member = requireBeamSession().members[0];
    if (member === undefined) throw new Error('Fixture without member');
    useAppStore.getState().editBeam({ kind: 'value', id: member.id, field: 'endFz', source: '-2' });
    expect(useAppStore.getState().fatigueAxialSource).toBeNull();
  });

  it('closing only the beam panel keeps the kept source (the deliberate preservation case)', async () => {
    await completedTransient(order);
    const kept = useAppStore.getState().fatigueAxialSource;
    expect(kept).not.toBeNull();
    useAppStore.getState().closeBeam();
    expect(useAppStore.getState().beamSession).toBeNull();
    expect(useAppStore.getState().fatigueAxialSource).toBe(kept);
  });
});

describe('focus after a refused calculation (same cause as the contact gap focus repair)', () => {
  it('a pure focus change keeps inputs, revision and result; a refusal after leaving the field names it again', async () => {
    useAppStore.setState({ fatigueSession: edited(BASE_EDITS, useAppStore.getState().activeDocumentId),
      strengthSession: bucklingUiFixture().state.strengthSession });
    await useAppStore.getState().runFatigue();
    const analyzed = fatigue();
    useAppStore.getState().editFatigue({ kind: 'focus', field: 'slope' });
    useAppStore.getState().editFatigue({ kind: 'focus', field: null });
    expect([fatigue().revision, fatigue().analyzed, fatigue().draft]).toEqual([analyzed.revision, analyzed.analyzed, analyzed.draft]);
    // The user types an invalid slope while the field is focused, then leaves it for the Calculate button.
    useAppStore.getState().editFatigue({ kind: 'focus', field: 'slope' });
    useAppStore.getState().editFatigue({ kind: 'value', field: 'slope', source: '0' });
    useAppStore.getState().editFatigue({ kind: 'focus', field: null });
    expect(fatigue().focusedField).toBeNull();
    await useAppStore.getState().runFatigue();
    // null -> 'slope' is a change, so ExpressionField receives focused=true again and moves the keyboard back.
    expect([fatigue().errorKey, fatigue().focusedField]).toEqual(['fatigue.error.field', 'slope']);
  });
});

describe('saved axial provenance (model reader, cross-layer)', () => {
  const provenance: FatigueSavedAxialProvenance = { measure: 'member-mean-linear-axial-from-sampled-end-translations/1',
    stress: 'member-mean-linear-axial', excluded: 'bending-shear-torsion-local-combined-multiaxial', analysisId: 'analysis-1',
    analysisRevision: 3, inputSha256: 'f'.repeat(64), memberId: 'beam-member-1', startNodeId: 'beam-member-1-start',
    endNodeId: 'beam-member-1-end', lengthM: 2, youngPa: 2.05e11, sampleTimesS: [0, 0.001, 0.002], conversion: 'MPa = Pa / 1e6' };
  // Compile-time: the core and the saved provenance describe the same shape in both directions.
  const fromCore = (value: AxialFatigueProvenance): FatigueSavedAxialProvenance => value;
  const toCore = (value: FatigueSavedAxialProvenance): AxialFatigueProvenance => value;
  const base = (() => {
    const checked = fatigueInput(edited(BASE_EDITS), []);
    if (!checked.ok) throw new Error('Draft refused');
    return checked.input;
  })();
  const attachment = (definition: unknown) => ({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'fatigue', definition }] });
  const accepts = (definition: unknown): boolean => readBeamAnalysisInputs(attachment(definition), 'document-a').ok;
  const v2 = (axial: unknown, extra: object = {}) => ({ schema: 'pointercad-fatigue-saved/2', id: 'fatigue',
    source: { documentId: 'document-a' }, input: base, axial, ...extra });

  it('reads version 1 as version 2 without sources, so the read value saves back into an accepted value', () => {
    expect(toCore(fromCore(toCore(provenance)))).toBe(provenance);
    const v1 = { schema: 'pointercad-fatigue-saved/1', id: 'fatigue', source: { documentId: 'document-a' }, input: base };
    const read = readBeamAnalysisInputs(attachment(v1), 'document-a');
    const definition = read.ok ? read.value.analyses[0] : undefined;
    expect(definition?.kind === 'fatigue' ? [definition.definition.schema, definition.definition.axial] : null)
      .toEqual(['pointercad-fatigue-saved/2', []]);
    expect(read.ok && readBeamAnalysisInputs(JSON.parse(JSON.stringify(read.value)), 'document-a').ok).toBe(true);
    expect(accepts({ ...v1, axial: [] })).toBe(false);
  });

  it('accepts exact provenance and refuses every inconsistent or unknown form', () => {
    const one = (change: object) => [{ historyId: 'history-1', provenance: { ...provenance, ...change } }];
    expect(accepts(v2([]))).toBe(true);
    expect(accepts(v2(one({})))).toBe(true);
    const refusals: readonly unknown[] = [
      v2(one({ sampleTimesS: [0, 0.001] })), v2(one({ sampleTimesS: [0, 0.002, 0.002] })), v2(one({ measure: 'bending' })),
      v2(one({ stress: 'combined' })), v2(one({ excluded: 'none' })), v2(one({ conversion: 'MPa' })), v2(one({ lengthM: 0 })),
      v2(one({ youngPa: -1 })), v2(one({ analysisRevision: 1.5 })), v2(one({ memberId: '' })), v2(one({ extra: 1 })),
      v2([{ historyId: 'history-9', provenance }]), v2([...one({}), ...one({})]), v2([{ historyId: 'history-1' }]),
      v2(one({}), { extra: true }), { ...v2([]), schema: 'pointercad-fatigue-saved/3' },
    ];
    refusals.forEach((definition, index) => expect(accepts(definition), `case ${index}`).toBe(false));
  });
});
