import { collectMathCoefficients, expressionValueFromNumber } from '@pointercad/expression';
import { MathWorkerClient, type MathWorkerPort } from '@pointercad/expression/math/client';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { createMathBackend, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import {
  affectsShape,
  checkMathGeometryName,
  createAssemblyDocument,
  createDrawingDocument,
  createEmptyPartDocument,
  DEFAULT_MATH_GEOMETRY_TOLERANCE,
  mathGeometryParameterDraft,
  removeMathGeometryDefinition,
  setMathGeometryAngleUnit,
  synchronizeConfigurations,
  type MathGeometryDefinition,
  type MathGeometryOutcome,
  type MathGeometryQuantity,
  type MathGeometryTolerance,
  type Parameter,
  type PartDocument,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type MessageKey } from '../i18n/t.js';
import type { AppState } from '../store/appState.js';
import { bodyFor, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  changeMathGeometryAngleUnit,
  changeMathGeometryTolerance,
  createMathGeometryFromSelection,
  defaultMathGeometryName,
  removeMathGeometry,
  reselectMathGeometry,
  runMathGeometryRename,
  type MathGeometryCommandResult,
  type MathGeometryCommandState,
} from './mathGeometryCommands.js';
import { mathGeometrySelection } from './mathGeometrySelection.js';

const TOLERANCE = DEFAULT_MATH_GEOMETRY_TOLERANCE;
const LENGTH: MathGeometryQuantity = { kind: 'length', curve: { kind: 'sketch-curve', sketchId: 'sketch-1', featureId: 'line-1' } };
const ANGLE: MathGeometryQuantity = { kind: 'angle',
  first: { kind: 'sketch-curve', sketchId: 'sketch-1', featureId: 'line-1' },
  second: { kind: 'sketch-curve', sketchId: 'sketch-1', featureId: 'line-2' }, unit: 'degree' };
const backend = createMathBackend();
const clients: MathWorkerClient[] = [];
const originalApplyDocument = useAppStore.getState().applyDocument;
const originalContents = new WeakMap<PartDocument, string>();

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ drawing: null, requestedGeneration: 0, completedGeneration: 0,
    lastOutcome: 'idle', applyDocument: originalApplyDocument });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.restoreAllMocks();
});

function definition(id = 'g1', name = '長さ1', quantity: MathGeometryQuantity = LENGTH): MathGeometryDefinition {
  return { id, name, documentId: 'part-1', quantity, tolerance: TOLERANCE };
}

function part(definitions: readonly MathGeometryDefinition[] = [definition()]): PartDocument {
  return { ...createEmptyPartDocument(), mathGeometry: definitions };
}

/** A completed recomputation through the real store entry; the shape measurement itself is a fixture. */
function open(document: PartDocument = part()): PartDocument {
  originalContents.set(document, JSON.stringify(document));
  const state = useAppStore.getState();
  state.resetDocument(document);
  state.recordRecomputeRequest(1);
  state.applyRecompute(document, { ...resultFor(document), generation: 1,
    mathGeometry: (document.mathGeometry ?? []).map((item): MathGeometryOutcome => ({
      id: item.id, documentId: document.id, generation: 1, status: 'value', kind: 'real', value: 23.5,
      unit: 'mm', representation: 'geometry-double', tolerance: item.tolerance,
    })),
  });
  state.recordRecomputeCompletion(1, 'success');
  return document;
}

function commandState() {
  const state = useAppStore.getState();
  return { ...state, applyDocument: vi.fn(state.applyDocument) };
}

function expectUnchanged(before: AppState): void {
  const after = useAppStore.getState();
  expect(after.document).toBe(before.document);
  expect(JSON.stringify(after.document)).toBe(originalContents.get(before.document));
  expect(after.undoStack).toBe(before.undoStack);
}

function expectUndo(before: AppState): void {
  const after = useAppStore.getState();
  expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
  expect(after.undoStack.past.at(-1)).toBe(before.document);
  expect(affectsShape(before.document, after.document)).toBe(true);
  expect(after.isComputing).toBe(true);
  after.undo();
  expect(useAppStore.getState().document).toBe(before.document);
}

/** All requests use the real math engine/protocol, including delayed replies after cancellation. */
function transport(hold = false) {
  let terminated = 0;
  const sent: { readonly port: MathWorkerPort; readonly value: unknown }[] = [];
  const client = new MathWorkerClient({
    createWorker: () => {
      const port: MathWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
        terminate: () => { terminated += 1; },
        postMessage: value => {
          sent.push({ port, value });
          if (!hold) queueMicrotask(() => port.onmessage?.({ data: executeMathWorkRequest(value, backend) }));
        },
      };
      return port;
    },
    decodeReply: (value, request) => decodeMathWorkReply(value, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }),
  });
  clients.push(client);
  return { client, sent, terminated: () => terminated,
    reply: () => { for (const item of sent) item.port.onmessage?.({ data: executeMathWorkRequest(item.value, backend) }); } };
}

function referencedPart(): PartDocument {
  const document = part();
  const draft = mathGeometryParameterDraft(document, 'g1', { name: 'P', value: 999, unit: 'mm', description: '' });
  if (!draft.ok) throw new Error(draft.message);
  const parameter: Parameter = { ...draft.parameter, mathId: 'coefficient:1' };
  const formula = parameter.value.mathDefinition;
  if (formula === undefined) throw new Error('Expected a stored formula');
  const configured = synchronizeConfigurations({ ...document, parameters: [parameter] });
  return { ...configured, configurations: [...configured.configurations,
    { id: 'alternative', name: '別案', values: { P: formula.source }, mathDefinitions: { P: formula } }],
  unresolvedMathProblems: [{ id: 'problem-1', name: '残した式', status: 'unresolved', definition: formula }] };
}

describe('GR-16: each edit is exactly one Undo step', () => {
  it('creates the selected GR-15 quantity with a UUID and default tolerance/name, then restores the original object', () => {
    const owner = open(part([]));
    useAppStore.setState({ selection: ['box-1'], bodies: [{ ...bodyFor('box-1'), bodyKind: 'solid' }] });
    const state = commandState();
    const candidate = mathGeometrySelection(state.selection, state.sketch.id, state.resolvedSketch, state.bodies).candidates[0];
    expect(candidate.kind).toBe('volume');
    expect(createMathGeometryFromSelection(state, owner, candidate)).toEqual({ ok: true });
    const added = useAppStore.getState().document.mathGeometry?.[0];
    if (added === undefined) throw new Error('Missing created definition');
    expect(added.id).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
    expect(added).toEqual({ id: added.id,
      documentId: owner.id, name: '体積1', quantity: candidate, tolerance: TOLERANCE });
    expect(state.applyDocument).toHaveBeenCalledTimes(1);
    expect(state.applyDocument.mock.calls[0]).toHaveLength(1);
    expectUndo(state);
  });

  it('reselects targets while preserving identity, name and tolerance', () => {
    const owner = open(), state = commandState();
    const next: MathGeometryQuantity = { kind: 'length', curve: { kind: 'sketch-curve', sketchId: 'sketch-1', featureId: 'line-3' } };
    expect(reselectMathGeometry(state, owner, 'g1', next)).toEqual({ ok: true });
    expect(useAppStore.getState().document.mathGeometry).toEqual([{ ...definition(), quantity: next }]);
    expect(state.applyDocument).toHaveBeenCalledTimes(1);
    expectUndo(state);
  });

  it('changes the angle unit with one publication', () => {
    const owner = open(part([definition('g1', '角度1', ANGLE)])), state = commandState();
    expect(changeMathGeometryAngleUnit(state, owner, 'g1', 'radian')).toEqual({ ok: true });
    expect(useAppStore.getState().document.mathGeometry?.[0].quantity).toEqual({ ...ANGLE, unit: 'radian' });
    expect(state.applyDocument).toHaveBeenCalledTimes(1);
    expectUndo(state);
  });

  it('changes both comparison margins with one publication', () => {
    const owner = open(), state = commandState(), tolerance = { linearMm: 0.2, angularRadians: 0.1 };
    expect(changeMathGeometryTolerance(state, owner, 'g1', tolerance)).toEqual({ ok: true });
    expect(useAppStore.getState().document.mathGeometry).toEqual([{ ...definition(), tolerance }]);
    expect(state.applyDocument).toHaveBeenCalledTimes(1);
    expectUndo(state);
  });

  it('deletes an unused definition with one publication', () => {
    const owner = open(), state = commandState();
    expect(removeMathGeometry(state, owner, 'g1')).toEqual({ ok: true });
    expect(useAppStore.getState().document.mathGeometry).toEqual([]);
    expect(state.applyDocument).toHaveBeenCalledTimes(1);
    expectUndo(state);
  });

  it('renames the row and every formula label using current measured values, with one Undo for the entire edit', async () => {
    const owner = open(referencedPart()), channel = transport();
    const apply = vi.fn(originalApplyDocument);
    useAppStore.setState({ applyDocument: apply });
    const before = useAppStore.getState(), serialized = JSON.stringify(owner);
    expect(await runMathGeometryRename('g1', '新しい長さ', { createClient: () => channel.client, owner })).toEqual({ ok: true });
    const after = useAppStore.getState().document;
    expect(after.mathGeometry?.[0]).toEqual({ ...definition(), name: '新しい長さ' });
    expect(after.parameters[0].value.value).toBe(23.5); // The saved 999 is never used as current geometry.
    const formulas = [after.parameters[0].value.mathDefinition,
      ...after.configurations.map(configuration => configuration.mathDefinitions?.P),
      after.unresolvedMathProblems?.[0].definition];
    expect(formulas).toHaveLength(4);
    for (const formula of formulas) {
      if (formula === undefined) throw new Error('Missing renamed formula');
      expect(collectMathCoefficients(formula.expression)).toEqual([
        { role: 'coefficient', id: 'math-geometry:g1', label: '新しい長さ' },
      ] satisfies ReturnType<typeof collectMathCoefficients>);
      expect(formula.source).toContain('新しい長さ');
      expect(formula.source).not.toContain('長さ1');
    }
    expect(after.parameters[0].value.source).toBe(formulas[0]?.source);
    for (const configuration of after.configurations) expect(configuration.values.P).toBe(configuration.mathDefinitions?.P.source);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]).toHaveLength(1);
    expect(channel.terminated()).toBe(1);
    expect(JSON.stringify(owner)).toBe(serialized);
    expectUndo(before);
  });
});

describe('GR-16: default names and refusals', () => {
  it('fills the smallest gap across geometry and parameter names', () => {
    const owner = open({ ...part([definition('g1', '長さ1'), definition('g4', '長さ4')]),
      parameters: [{ name: '長さ2', value: expressionValueFromNumber(1), unit: 'mm', description: '' }] });
    const state = commandState();
    expect(defaultMathGeometryName(owner, LENGTH)).toBe('長さ3');
    expect(checkMathGeometryName(owner, defaultMathGeometryName(owner, LENGTH))).toBeNull();
    expect(createMathGeometryFromSelection(state, owner, LENGTH)).toEqual({ ok: true });
    expect(useAppStore.getState().document.mathGeometry?.at(-1)?.name).toBe('長さ3');
  });

  it.each(['X', 'Y', 'Z'] as const)('uses the localized %s coordinate prefix', component => {
    const owner = open(part([]));
    const quantity: MathGeometryQuantity = { kind: 'coordinate', component,
      point: { kind: 'sketch-point', sketchId: 'sketch-1', reference: { kind: 'point', pointId: 'point-1' } } };
    const name = defaultMathGeometryName(owner, quantity);
    expect(name).toBe(`${component}座標1`);
    expect(checkMathGeometryName(owner, name)).toBeNull();
  });

  it.each(['', '2bad', 'sqrt', 'bad name', '長さ1'])('rejects the name %j without publishing', name => {
    const owner = open(), state = commandState();
    expect(createMathGeometryFromSelection(state, owner, LENGTH, name).ok).toBe(false);
    expect(state.applyDocument).not.toHaveBeenCalled();
    expectUnchanged(state);
  });

  it('shows the existing localized duplicate-name reason for a parameter collision', () => {
    const owner = open({ ...part(), parameters: [{ name: 'P', unit: 'mm', description: '', value: expressionValueFromNumber(1) }] });
    const state = commandState();
    expect(createMathGeometryFromSelection(state, owner, LENGTH, 'P')).toEqual({
      ok: false, reason: 'duplicateName', message: t('parameter.error.duplicateName'),
    });
    expectUnchanged(state);
  });

  it.each(['kind', 'unit'] as const)('refuses reselect %s mismatches', mode => {
    const owner = open(part([definition('g1', '角度1', ANGLE)])), state = commandState();
    const quantity = mode === 'kind' ? LENGTH : { ...ANGLE, unit: 'radian' as const };
    expect(reselectMathGeometry(state, owner, 'g1', quantity)).toMatchObject({ ok: false, reason: `${mode}Mismatch` });
    expect(state.applyDocument).not.toHaveBeenCalled();
    expectUnchanged(state);
  });

  it('keeps the model refusal for angle-unit edits of non-angle definitions', () => {
    const owner = open(), state = commandState();
    expect(changeMathGeometryAngleUnit(state, owner, 'g1', 'radian')).toEqual(setMathGeometryAngleUnit(owner, 'g1', 'radian'));
    expect(state.applyDocument).not.toHaveBeenCalled();
    expectUnchanged(state);
  });

  it('does not apply a document for an unchanged angle unit', () => {
    const owner = open(part([definition('g1', '角度1', ANGLE)])), state = commandState();
    expect(changeMathGeometryAngleUnit(state, owner, 'g1', 'degree')).toEqual({ ok: true });
    expect(state.applyDocument).not.toHaveBeenCalled();
    expectUnchanged(state);
  });

  const invalidTolerances: readonly { readonly field: 'linear' | 'angular'; readonly tolerance: MathGeometryTolerance }[] = [
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
      .map(linearMm => ({ field: 'linear' as const, tolerance: { ...TOLERANCE, linearMm } })),
    ...[0, -1, Math.PI / 4, Math.PI / 2, Number.NaN, Number.POSITIVE_INFINITY]
      .map(angularRadians => ({ field: 'angular' as const, tolerance: { ...TOLERANCE, angularRadians } })),
  ];
  it.each(invalidTolerances)('refuses $field outside its range: $tolerance', ({ field, tolerance }) => {
    const owner = open(), state = commandState();
    expect(changeMathGeometryTolerance(state, owner, 'g1', tolerance)).toEqual({ ok: false, reason: 'invalidTolerance',
      message: t(`mathGeometry.tolerance.error.${field}`) });
    expect(state.applyDocument).not.toHaveBeenCalled();
    expectUnchanged(state);
  });

  it('validates tolerance before looking up the definition, reporting the linear field first', () => {
    const owner = open(), state = commandState();
    expect(changeMathGeometryTolerance(state, owner, 'missing', { linearMm: 0, angularRadians: 0 })).toEqual({
      ok: false, reason: 'invalidTolerance', message: t('mathGeometry.tolerance.error.linear'),
    });
    expect(state.applyDocument).not.toHaveBeenCalled();
    expectUnchanged(state);
  });

  it('does not call applyDocument or grow Undo when both tolerance numbers are unchanged', () => {
    const owner = open(), state = commandState();
    expect(changeMathGeometryTolerance(state, owner, 'g1', { ...TOLERANCE })).toEqual({ ok: true });
    expect(state.applyDocument).not.toHaveBeenCalled();
    expectUnchanged(state);
  });

  it('refuses deletion and names all referencing parameters, configurations and unresolved problems', () => {
    const owner = open(referencedPart()), state = commandState();
    const result = removeMathGeometry(state, owner, 'g1');
    expect(result).toEqual(removeMathGeometryDefinition(owner, 'g1'));
    if (result.ok) throw new Error('Expected in-use refusal');
    expect(result.reason).toBe('inUse');
    for (const name of ['P', '別案', '残した式']) expect(result.message).toContain(name);
    expect(state.applyDocument).not.toHaveBeenCalled();
    expectUnchanged(state);
  });

  const byIdCommands = [
    { name: 'reselect', run: (state: MathGeometryCommandState, owner: PartDocument, id: string) => reselectMathGeometry(state, owner, id, LENGTH) },
    { name: 'unit', run: (state: MathGeometryCommandState, owner: PartDocument, id: string) => changeMathGeometryAngleUnit(state, owner, id, 'radian') },
    { name: 'tolerance', run: (state: MathGeometryCommandState, owner: PartDocument, id: string) => changeMathGeometryTolerance(state, owner, id, { linearMm: 0.1, angularRadians: 0.1 }) },
    { name: 'delete', run: (state: MathGeometryCommandState, owner: PartDocument, id: string) => removeMathGeometry(state, owner, id) },
  ];
  it.each(byIdCommands)('$name refuses an unknown definition without publishing', ({ run }) => {
    const owner = open(), state = commandState();
    expect(run(state, owner, 'missing')).toMatchObject({ ok: false, reason: 'notFound' });
    expect(state.applyDocument).not.toHaveBeenCalled();
    expectUnchanged(state);
  });

  const allCommands: readonly { readonly name: string;
    readonly run: (state: MathGeometryCommandState, owner: PartDocument) => MathGeometryCommandResult }[] = [
    { name: 'create', run: (state, owner) => createMathGeometryFromSelection(state, owner, LENGTH) },
    ...byIdCommands.map(command => ({ name: command.name,
      run: (state: MathGeometryCommandState, owner: PartDocument) => command.run(state, owner, 'g1') })),
  ];
  it.each(allCommands)('$name rejects a different owner object with the same document ID', ({ run }) => {
    const owner = open(), state = commandState();
    expect(run(state, { ...owner })).toMatchObject({ ok: false, reason: 'staleDocument' });
    expect(state.applyDocument).not.toHaveBeenCalled();
    expectUnchanged(state);
  });

  it.each(['assembly', 'drawing'] as const)('all six commands leave %s untouched', async kind => {
    const owner = open();
    if (kind === 'assembly') useAppStore.getState().openAssembly(createAssemblyDocument('assembly-1'));
    else useAppStore.getState().openDrawing(createDrawingDocument('drawing-1', {
      sourceRef: 'part-1', sourceKind: 'part', fileName: '', path: '', contentHash: '', importedAt: '',
    }));
    const state = commandState(), before = useAppStore.getState();
    const createClient = vi.fn(() => transport().client);
    for (const { run } of allCommands) expect(run(state, owner)).toMatchObject({ ok: false, reason: 'notPart' });
    expect(await runMathGeometryRename('g1', '新しい長さ', { createClient })).toMatchObject({ ok: false, reason: 'notPart' });
    expect(createClient).not.toHaveBeenCalled();
    expect(state.applyDocument).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toBe(before);
  });
});

describe('GR-16: rename freshness and cancellation', () => {
  it.each(['長さ1', 'P', 'sqrt', '2bad', 'bad name'] as const)('rename to %s is a no-op or refusal without Undo', async name => {
    open(referencedPart());
    const before = useAppStore.getState(), channel = transport();
    const result = await runMathGeometryRename('g1', name, { createClient: () => channel.client });
    expect(result.ok).toBe(name === '長さ1');
    expectUnchanged(before);
    expect(channel.sent).toHaveLength(0);
  });

  it('rejects an unknown definition without publishing', async () => {
    open();
    const before = useAppStore.getState(), channel = transport();
    expect(await runMathGeometryRename('missing', '新しい長さ', { createClient: () => channel.client }))
      .toMatchObject({ ok: false, reason: 'notFound' });
    expectUnchanged(before);
  });

  const unavailable: readonly { readonly name: string; readonly patch: Partial<AppState>; readonly key: MessageKey }[] = [
    { name: 'no snapshot', patch: { mathGeometryResult: null }, key: 'mathGeometry.editor.pending' },
    { name: 'new generation', patch: { requestedGeneration: 2 }, key: 'mathGeometry.editor.pending' },
    { name: 'cancelled recompute', patch: { recomputeCancelled: true }, key: 'mathGeometry.status.cancelled' },
    { name: 'timeline preview', patch: { timelineIndex: 0 }, key: 'mathGeometry.status.timeline' },
  ];
  it.each(unavailable)('rejects rename with $name before creating a worker', async ({ patch, key }) => {
    open(referencedPart());
    useAppStore.setState(patch);
    const before = useAppStore.getState(), createClient = vi.fn(() => transport().client);
    expect(await runMathGeometryRename('g1', '新しい長さ', { createClient })).toMatchObject({ ok: false, message: t(key) });
    expect(createClient).not.toHaveBeenCalled();
    expectUnchanged(before);
  });

  it('rejects a stale editor owner even when the current document has the same ID', async () => {
    const owner = open(), createClient = vi.fn(() => transport().client), before = useAppStore.getState();
    expect(await runMathGeometryRename('g1', '新しい長さ', { owner: { ...owner }, createClient }))
      .toMatchObject({ ok: false, reason: 'staleDocument' });
    expect(createClient).not.toHaveBeenCalled();
    expectUnchanged(before);
  });

  it('does not start a worker when already aborted', async () => {
    open(referencedPart());
    const before = useAppStore.getState(), controller = new AbortController(), createClient = vi.fn(() => transport().client);
    controller.abort();
    expect(await runMathGeometryRename('g1', '新しい長さ', { signal: controller.signal, createClient }))
      .toMatchObject({ ok: false, reason: 'cancelled' });
    expect(createClient).not.toHaveBeenCalled();
    expectUnchanged(before);
  });

  it.each(['abort', 'edit', 'version', 'undo', 'generation', 'timeline', 'assembly'] as const)(
    '%s during rename publishes no partial document and ignores late replies', async mode => {
      const owner = open(referencedPart());
      if (mode === 'undo') {
        useAppStore.getState().applyDocument({ ...owner, name: '同じ形の文書' });
      }
      const before = useAppStore.getState(), channel = transport(true), controller = new AbortController();
      const pending = runMathGeometryRename('g1', '新しい長さ', { createClient: () => channel.client, signal: controller.signal });
      await Promise.resolve();
      expect(channel.sent.length).toBeGreaterThan(0);
      if (mode === 'abort') controller.abort();
      else if (mode === 'edit') before.applyDocument({ ...before.document, name: '別の編集' });
      else if (mode === 'version') useAppStore.setState({ documentVersion: before.documentVersion + 1 });
      else if (mode === 'undo') before.undo();
      else if (mode === 'generation') before.recordRecomputeRequest(2);
      else if (mode === 'timeline') useAppStore.setState({ timelineIndex: 0 });
      else before.openAssembly(createAssemblyDocument('assembly-1'));
      const current = useAppStore.getState();
      expect(await pending).toEqual({ ok: false, reason: 'cancelled', message: t('math.operation.cancelled') });
      expect(useAppStore.getState()).toBe(current);
      channel.reply();
      expect(useAppStore.getState()).toBe(current);
      expect(channel.terminated()).toBe(1);
      if (mode === 'abort') expectUnchanged(before);
    },
  );

  it('reports worker creation failure without modifying the document', async () => {
    open(referencedPart());
    const before = useAppStore.getState();
    expect(await runMathGeometryRename('g1', '新しい長さ', { createClient: () => { throw new Error('Unavailable'); } }))
      .toEqual({ ok: false, reason: 'rewriteFailed', message: t('math.rename.failed') });
    expectUnchanged(before);
  });
});
