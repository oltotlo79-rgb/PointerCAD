import { expressionValueFromNumber } from '@pointercad/expression';
import type { FemWorkerPort, PlasticBarInput } from '@pointercad/fem';
import { createEmptyPartDocument } from '@pointercad/model';
import { withBeamAnalysisInputs, type PlasticBarSavedInput } from '@pointercad/model/beam-analysis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { commitAddParameter, commitReplaceParameter } from '../parameters/parameterCommands.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachPlasticBar } from './attachPlasticBar.js';
import { BENCHMARK_EDITS, benchmarkResult } from './plasticBar.testSupport.js';
import { createPlasticBarSession, editPlasticBarSession, plasticBarDraftIsSaved, plasticBarResultIsCurrent,
  plasticBarSavedInput, savedPlasticBarInput, type PlasticBarEdit, type PlasticBarSession } from './plasticBarSession.js';

class Port implements FemWorkerPort {
  onmessage: FemWorkerPort['onmessage'] = null;
  onerror: FemWorkerPort['onerror'] = null;
  onmessageerror: FemWorkerPort['onmessageerror'] = null;
  request: Parameters<FemWorkerPort['postMessage']>[0] | null = null;
  terminated = 0;
  postMessage(request: Parameters<FemWorkerPort['postMessage']>[0]): void { this.request = request; }
  terminate(): void { this.terminated += 1; }
}
let attachment: ReturnType<typeof attachPlasticBar> | null = null;
beforeEach(resetTestStore);
afterEach(() => { attachment?.dispose(); attachment = null; resetTestStore(); });

function session(): PlasticBarSession {
  const value = useAppStore.getState().plasticBarSession;
  if (value === null) throw new Error('No plastic-bar session');
  return value;
}
/** The actual ParameterPanel route: a parameter command result applied with applyDocument (part document). */
function applyParameter(name: string, value: number): void {
  const document = useAppStore.getState().document;
  const outcome = document.parameters.some(parameter => parameter.name === name)
    ? commitReplaceParameter(document, name, { value: expressionValueFromNumber(value) })
    : commitAddParameter(document, { name, value: expressionValueFromNumber(value), unit: 'mm', description: '' });
  if (!outcome.ok) throw new Error(outcome.message);
  useAppStore.getState().applyDocument(outcome.document);
}
/** Benchmark draft whose first end-displacement knot is the document parameter `u` (2.5 mm initially). */
async function runningWithParameter(): Promise<{ port: Port; ports: Port[]; input: PlasticBarInput }> {
  useAppStore.setState({ strengthSession: bucklingUiFixture().state.strengthSession, assembly: null });
  applyParameter('u', 2.5);
  applyParameter('w', 7);
  const ports: Port[] = [];
  attachment = attachPlasticBar(useAppStore, () => { const port = new Port(); ports.push(port); return port; });
  useAppStore.getState().openPlasticBar();
  for (const edit of BENCHMARK_EDITS) useAppStore.getState().editPlasticBar(edit);
  useAppStore.getState().editPlasticBar({ kind: 'knot', index: 0, source: 'u' });
  useAppStore.getState().runPlasticBar();
  await vi.waitFor(() => expect(ports[0]?.request).toBeTruthy());
  const port = ports[0], request = port.request;
  if (request?.kind !== 'analyze-plastic-bar-1d') throw new Error(`Expected a plastic-bar request, got ${session().errorKey}`);
  expect(request.input.plan.endDisplacementM[1]).toBe(2.5e-3);
  return { port, ports, input: request.input };
}
function message(port: Port, data: unknown): void {
  const callback = port.onmessage;
  if (callback === null) throw new Error('Worker callback already released');
  callback(new MessageEvent('message', { data }));
}
async function completed(): Promise<Port[]> {
  const { port, ports, input } = await runningWithParameter();
  message(port, { protocol: 'pointercad-fem/1', kind: 'result', identity: port.request?.identity, result: await benchmarkResult(input) });
  await vi.waitFor(() => expect(session().status).toBe('complete'));
  expect(plasticBarResultIsCurrent(session())).toBe(true);
  return ports;
}

describe('plastic-bar results stay bound to the parameters they were computed with', () => {
  it('a used parameter edited while solving cancels the Worker and drops the captured late result', async () => {
    const { port, input } = await runningWithParameter();
    const callback = port.onmessage, identity = port.request?.identity, revision = session().revision;
    message(port, { protocol: 'pointercad-fem/1', kind: 'phase', identity, phase: 'solving' });
    applyParameter('u', 2);
    expect(port.terminated).toBe(1);
    expect(port.onmessage).toBeNull();
    callback?.(new MessageEvent('message', { data: { protocol: 'pointercad-fem/1', kind: 'result', identity,
      result: await benchmarkResult(input) } }));
    await Promise.resolve();
    expect(session().result).toBeNull();
    expect(session().status).toBe('editing');
    expect(session().errorKey).toBe('beam.error.changed');
    // The draft itself is unchanged: same revision and the expression `u` is kept.
    expect(session().revision).toBe(revision);
    expect(session().draft.knots[0]).toBe('u');
  });

  it('a used parameter edited after completion removes the result', async () => {
    await completed();
    applyParameter('u', 2);
    expect(session().result).toBeNull();
    expect(plasticBarResultIsCurrent(session())).toBe(false);
    expect(session().errorKey).toBe('beam.error.changed');
  });

  it('an unrelated parameter, an unchanged value and view-only state keep the result', async () => {
    const ports = await completed();
    const result = session().result;
    applyParameter('w', 8);
    applyParameter('u', 2.5);
    useAppStore.setState({ viewportSize: [640, 480] });
    useAppStore.getState().editPlasticBar({ kind: 'focus', field: 'knot:0' });
    expect(session().result).toBe(result);
    expect(session().status).toBe('complete');
    expect(session().errorKey).toBeNull();
    expect(ports[0]?.terminated).toBe(1);
    expect(attachment?.statistics().live).toBe(0);
  });

  it('a fresh run after the change uses the new parameter value and is not cancelled by unrelated changes', async () => {
    const ports = await completed();
    applyParameter('u', 2);
    useAppStore.getState().runPlasticBar();
    await vi.waitFor(() => expect(ports[1]?.request).toBeTruthy());
    const request = ports[1]?.request;
    if (request?.kind !== 'analyze-plastic-bar-1d') throw new Error('Expected a second plastic-bar request');
    expect(request.input.plan.endDisplacementM[1]).toBe(2e-3);
    expect(session().status).toBe('running');
    applyParameter('w', 9);
    useAppStore.getState().editPlasticBar({ kind: 'focus', field: 'young' });
    expect(ports[1]?.terminated).toBe(0);
    expect(session().status).toBe('running');
  });
});

describe('saved status compares values, not key insertion order', () => {
  it('reports saved for a configuration normalized by the real document reader', () => {
    let draft = createPlasticBarSession('owner');
    for (const edit of BENCHMARK_EDITS) draft = editPlasticBarSession(draft, edit);
    const part = createEmptyPartDocument();
    const built = plasticBarSavedInput(draft, [], part.id);
    if (!built.ok) throw new Error(built.key);
    const document = withBeamAnalysisInputs(part, { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'plastic-bar', definition: built.saved }] });
    const normalized = savedPlasticBarInput(document);
    if (normalized === null) throw new Error('Saved configuration missing');
    // The old JSON comparison failed exactly here: same values, different key order.
    expect(JSON.stringify(normalized)).not.toBe(JSON.stringify(built.saved));
    expect(plasticBarDraftIsSaved(draft, [], normalized)).toBe(true);
    // Deliberately another insertion order of the same typed values.
    const reversed: PlasticBarSavedInput = { stepsPerSegment: normalized.stepsPerSegment,
      endDisplacementMm: [...normalized.endDisplacementMm], materialSource: { ...normalized.materialSource },
      hardeningModulusMPa: normalized.hardeningModulusMPa, yieldStressMPa: normalized.yieldStressMPa,
      poisson: normalized.poisson, youngModulusMPa: normalized.youngModulusMPa, areaMm2: normalized.areaMm2,
      lengthMm: normalized.lengthMm, units: normalized.units, source: { ...normalized.source }, id: normalized.id,
      schema: normalized.schema };
    expect(plasticBarDraftIsSaved(draft, [], reversed)).toBe(true);
    const edits: readonly PlasticBarEdit[] = [{ kind: 'knot', index: 3, source: '0.1' },
      { kind: 'reference', source: 'Another source' }, { kind: 'value', field: 'hardening', source: '2000.0000001' }];
    for (const edit of edits) {
      expect(plasticBarDraftIsSaved(editPlasticBarSession(draft, edit), [], normalized), edit.kind).toBe(false);
    }
  });
});
