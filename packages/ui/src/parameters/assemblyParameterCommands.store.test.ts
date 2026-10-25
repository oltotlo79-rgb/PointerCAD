import { expressionValueFromNumber } from '@pointercad/expression';
import type { FemWorkerPort, PlasticBarInput } from '@pointercad/fem';
import { createAssemblyDocument, type AssemblyDocument, type Parameter } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachPlasticBar } from '../plasticBar/attachPlasticBar.js';
import { BENCHMARK_EDITS, benchmarkResult } from '../plasticBar/plasticBar.testSupport.js';
import { plasticBarResultIsCurrent, type PlasticBarSession } from '../plasticBar/plasticBarSession.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitRenameAssemblyParameter, commitReplaceAssemblyParameter,
  type AssemblyParameterCommandOutcome } from './assemblyParameterCommands.js';

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

const row = (name: string, value: number): Parameter => ({ name, value: expressionValueFromNumber(value), unit: 'mm', description: '' });
function assembly(): AssemblyDocument {
  return { ...createAssemblyDocument('組立'), parameters: [row('u', 2.5), row('w', 7)] };
}
function ok(outcome: AssemblyParameterCommandOutcome): AssemblyDocument {
  if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.message}`);
  return outcome.document;
}
function open(): AssemblyDocument {
  const state = useAppStore.getState();
  if (state.assembly === null) throw new Error('No assembly is open');
  return state.assembly;
}
/** The panel route: an assembly command result committed with the real applyAssembly (assembly Undo stack). */
function replaceValue(name: string, value: number): void {
  useAppStore.getState().applyAssembly(ok(commitReplaceAssemblyParameter(open(), name, { value: expressionValueFromNumber(value) })));
}
function rename(from: string, to: string): void {
  useAppStore.getState().applyAssembly(ok(commitRenameAssemblyParameter(open(), from, to)));
}

describe('assembly parameter commands on the real store', () => {
  it('commit into the history created by openAssembly; Undo/Redo restore the table and the hidden part is untouched', () => {
    const opened = assembly();
    useAppStore.getState().openAssembly(opened);
    const before = useAppStore.getState();
    const hidden = before.document, partHistory = before.undoStack;
    // The real history exists before the edit (the earlier shallow fixture had no assemblyUndoStack at all).
    expect(before.assemblyUndoStack).not.toBeNull();
    expect(before.assemblyUndoStack?.present.document).toBe(opened);
    expect(before.assemblyUndoStack?.past).toHaveLength(0);
    expect(before.canUndo).toBe(false);

    rename('u', 'stroke');
    const renamed = open();
    expect(renamed.parameters.map(parameter => parameter.name)).toEqual(['stroke', 'w']);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    expect(useAppStore.getState().canUndo).toBe(true);

    useAppStore.getState().undo();
    expect(open()).toBe(opened);
    expect(useAppStore.getState().canRedo).toBe(true);
    useAppStore.getState().redo();
    expect(open()).toBe(renamed);

    const after = useAppStore.getState();
    expect(after.document).toBe(hidden);
    expect(after.undoStack).toBe(partHistory);
  });
});

function session(): PlasticBarSession {
  const value = useAppStore.getState().plasticBarSession;
  if (value === null) throw new Error('No plastic-bar session');
  return value;
}
function message(port: Port, data: unknown): void {
  const callback = port.onmessage;
  if (callback === null) throw new Error('Worker callback already released');
  callback(new MessageEvent('message', { data }));
}
/** Assembly open through the real actions, strength opened, first knot = assembly parameter `u` (2.5 mm). */
async function runningInAssembly(): Promise<{ port: Port; ports: Port[]; input: PlasticBarInput }> {
  useAppStore.getState().openAssembly(assembly());
  expect(useAppStore.getState().assemblyUndoStack).not.toBeNull();
  useAppStore.getState().toggleStrength();
  expect(useAppStore.getState().strengthSession).not.toBeNull();
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
async function completedInAssembly(): Promise<Port[]> {
  const { port, ports, input } = await runningInAssembly();
  message(port, { protocol: 'pointercad-fem/1', kind: 'result', identity: port.request?.identity, result: await benchmarkResult(input) });
  await vi.waitFor(() => expect(session().status).toBe('complete'));
  expect(plasticBarResultIsCurrent(session())).toBe(true);
  return ports;
}

describe('plastic-bar results follow assembly parameter commands', () => {
  it('a used assembly parameter edited while solving cancels the Worker', async () => {
    const { port } = await runningInAssembly();
    replaceValue('u', 2);
    expect(port.terminated).toBe(1);
    expect(port.onmessage).toBeNull();
    expect(session()).toMatchObject({ result: null, status: 'editing', errorKey: 'beam.error.changed' });
  });

  it('a used assembly parameter edited or renamed after completion removes the result; Undo does not revive it', async () => {
    await completedInAssembly();
    const hidden = useAppStore.getState().document;
    replaceValue('u', 2);
    expect(session()).toMatchObject({ result: null, status: 'editing', errorKey: 'beam.error.changed' });
    useAppStore.getState().undo();
    expect(open().parameters[0]?.value.value).toBe(2.5);
    expect(session().result).toBeNull();
    expect(useAppStore.getState().document).toBe(hidden);
  });

  it('renaming the used assembly parameter invalidates the result (the draft still names `u`)', async () => {
    await completedInAssembly();
    rename('u', 'stroke');
    expect(session()).toMatchObject({ result: null, errorKey: 'beam.error.changed' });
    expect(session().draft.knots[0]).toBe('u');
  });

  it('unrelated assembly parameter edits, renames and their Undo keep the result', async () => {
    const ports = await completedInAssembly();
    const result = session().result;
    replaceValue('w', 8);
    rename('w', 'width');
    useAppStore.getState().undo();
    replaceValue('u', 2.5);
    expect(session().result).toBe(result);
    expect(session().status).toBe('complete');
    expect(session().errorKey).toBeNull();
    expect(ports[0]?.terminated).toBe(1);
    expect(attachment?.statistics().live).toBe(0);
  });
});
