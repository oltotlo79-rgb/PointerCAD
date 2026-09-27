import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { MathWorkerClient, type MathWorkerPort } from '@pointercad/expression/math/client';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply, type MathNode } from '@pointercad/expression/math/contracts';
import { createMathBackend, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import {
  absoluteCoordinate, appendFeature, createDefaultConfigurations, createPointFeature,
  DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId, replaceSketch,
  type MathGeometryOutcome, type Parameter, type PartDocument,
} from '@pointercad/model';
import { t } from '../i18n/t.js';
import { runMathConfigurationAction } from '../parameters/mathConfigurationActions.js';
import { runMathParameterRename } from '../parameters/mathParameterActions.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import type { MathExpressionDialogProps } from './MathExpressionDialog.js';
import { PropertyMathField, replacePropertySketchFeature } from './PropertyMathField.js';

// Seed only the open-dialog UI state. The field's actual onApply, store, model and math engine run unchanged.
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useState: vi.fn(react.useState) };
});
const view = vi.hoisted(() => ({ dialog: null as MathExpressionDialogProps | null }));
vi.mock('./MathExpressionDialog.js', () => ({
  MathExpressionDialog: (props: MathExpressionDialogProps) => { view.dialog = props; return null; },
}));

const backend = createMathBackend();
const clients: MathWorkerClient[] = [];
const geometryId = 'measured-x';
const geometryName = '測定X';

function coefficient(id: string, label: string): MathNode {
  return { kind: 'symbol', reference: { role: 'coefficient', id, label } };
}

function formula(source: string, expression: MathNode): ExpressionValue {
  return { source, value: 999, display: '999', mathDefinition: {
    format: 'pointercad-math/1', source, expression, inputNotation: 'text', angleUnit: 'degree',
  } };
}

function multiplied(label: string, id: string, factor: number): ExpressionValue {
  return formula(`coef("${label}")*${String(factor)}`, {
    kind: 'operation', operation: 'multiply', operands: [coefficient(id, label), { kind: 'number', decimal: String(factor) }],
  });
}

function fixture(): PartDocument {
  const initial = useAppStore.getState().document;
  let sketch = initial.sketches[0];
  sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(7.5, 0, 0)));
  sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(1, 0, 0)));
  const parameters: readonly Parameter[] = [
    { name: 'P', mathId: 'coefficient:1', unit: 'mm', description: '',
      value: formula(`coef("${geometryName}")`, coefficient(mathGeometryCoefficientId(geometryId), geometryName)) },
    { name: 'Q', mathId: 'coefficient:2', unit: 'mm', description: '', value: multiplied('P', 'coefficient:1', 2) },
  ];
  const alternative = parameters.map(parameter => parameter.name === 'Q'
    ? { ...parameter, value: multiplied('P', 'coefficient:1', 3) } : parameter);
  const configurations = [...createDefaultConfigurations(parameters), {
    ...createDefaultConfigurations(alternative)[0], id: 'triple', name: '3倍',
  }];
  return { ...replaceSketch(initial, sketch), parameters, configurations, activeConfigurationId: configurations[0].id,
    mathGeometry: [{ id: geometryId, documentId: initial.id, name: geometryName,
      quantity: { kind: 'coordinate', component: 'X',
        point: { kind: 'sketch-point', sketchId: sketch.id, reference: { kind: 'point', pointId: sketch.features[0].id } } },
      tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE }],
  };
}

function publishMeasurement(document = useAppStore.getState().document, value = 7.5, generation = 1): void {
  const outcome: MathGeometryOutcome = { id: geometryId, documentId: document.id, generation,
    status: 'value', kind: 'real', value, unit: 'mm', representation: 'geometry-double',
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
  useAppStore.setState({ requestedGeneration: generation, completedGeneration: generation, lastOutcome: 'success',
    recomputeCancelled: false, mathGeometryResult: { document, generation, evaluated: true,
      outcomes: new Map([[geometryId, outcome]]) } });
}

beforeEach(() => {
  useAppStore.setState({ ...createInitialDocumentState(), requestedGeneration: 0, completedGeneration: 0, lastOutcome: 'idle' });
  useAppStore.getState().applyDocument(fixture());
  publishMeasurement();
  view.dialog = null;
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.clearAllMocks();
});

function transport(hold = false) {
  const queued: { readonly port: MathWorkerPort; readonly value: unknown }[] = [];
  let firstSent: () => void = () => undefined;
  const firstRequest = new Promise<void>(resolve => { firstSent = resolve; });
  let terminated = 0;
  const reply = (item: typeof queued[number]): void => {
    item.port.onmessage?.({ data: executeMathWorkRequest(item.value, backend) });
  };
  const client = new MathWorkerClient({
    createWorker: () => {
      const port: MathWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
        terminate: () => { terminated += 1; },
        postMessage: value => {
          firstSent();
          if (hold) queued.push({ port, value });
          else queueMicrotask(() => reply({ port, value }));
        },
      };
      return port;
    },
    decodeReply: (value, request) => decodeMathWorkReply(value, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(request.coefficients.map(entry => entry.id)), declaredIds: new Set() }),
  });
  clients.push(client);
  return { client, firstRequest, terminated: () => terminated, release: () => {
    hold = false;
    for (const item of queued.splice(0)) reply(item);
  } };
}

function propertyDialog(): MathExpressionDialogProps {
  const state = useAppStore.getState(), document = state.document;
  const point = document.sketches[0].features[1];
  if (point.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('Expected the editable point');
  const at = point.at;
  const replaceValue = (part: PartDocument, value: ExpressionValue): PartDocument =>
    replacePropertySketchFeature(part, point.id, { ...point, at: { ...at, x: value } });
  vi.mocked(useState).mockReturnValueOnce([
    { document, documentVersion: state.documentVersion, initialValue: at.x, replaceValue }, () => undefined,
  ]);
  const field = createNumericInput('point', 'point', 'absolute').fields[0];
  renderToStaticMarkup(createElement(PropertyMathField, {
    storedValue: at.x, replaceValue, field, result: { key: field.key, value: at.x, error: null }, focused: false,
    onChange: () => undefined, onFocus: () => undefined,
  }));
  if (view.dialog === null) throw new Error('The property math dialog did not open');
  return view.dialog;
}

function applyProperty(dialog: MathExpressionDialogProps, channel: ReturnType<typeof transport>, signal = new AbortController().signal) {
  // Preparing identities may produce a different object: inputs still belong to dialog.document.
  return dialog.onApply(multiplied('Q', 'coefficient:2', 2), { ...dialog.document }, signal, channel.client, []);
}

function pointX(document: PartDocument): ExpressionValue {
  const point = document.sketches[0].features[1];
  if (point.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('Expected the editable point');
  return point.at.x;
}

const unavailable = ['pending', 'generation', 'timeline', 'cancelled', 'foreign', 'notEvaluated'] as const;
function invalidate(kind: typeof unavailable[number]): void {
  const state = useAppStore.getState(), snapshot = state.mathGeometryResult;
  if (snapshot === null) throw new Error('Expected a measurement snapshot');
  switch (kind) {
    case 'pending': useAppStore.setState({ mathGeometryResult: null }); break;
    case 'generation': useAppStore.getState().recordRecomputeRequest(2); break;
    case 'timeline': useAppStore.setState({ timelineIndex: 0 }); break;
    case 'cancelled': useAppStore.setState({ recomputeCancelled: true }); break;
    case 'foreign': useAppStore.setState({ mathGeometryResult: { ...snapshot,
      document: { ...state.document, sketches: [...state.document.sketches] } } }); break;
    case 'notEvaluated': useAppStore.setState({ mathGeometryResult: { ...snapshot, evaluated: false } }); break;
  }
}

describe('図形値を使う既存の評価入口（GR-18）', () => {
  it('欄の数式を現在の図形値で適用し、元文書へUndo1回で戻す', async () => {
    const before = useAppStore.getState(), dialog = propertyDialog(), channel = transport();
    const evaluate = vi.spyOn(channel.client, 'evaluate');
    expect(await applyProperty(dialog, channel)).toEqual({ ok: true });
    const after = useAppStore.getState();
    expect(pointX(after.document)).toMatchObject({ source: 'coef("Q")*2', value: 30 });
    expect(after.document.parameters.map(parameter => parameter.value.value)).toEqual([7.5, 15]);
    const measured = evaluate.mock.calls.flatMap(([request]) => request.coefficients)
      .find(entry => entry.id === mathGeometryCoefficientId(geometryId));
    expect(measured).toEqual({ id: mathGeometryCoefficientId(geometryId), label: geometryName, decimal: '7.5' });
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(before.document);
  });

  it.each(unavailable)('欄の適用時に%sなら理由を返して文書とUndoを変えない', async kind => {
    const dialog = propertyDialog(), channel = transport();
    invalidate(kind);
    const before = useAppStore.getState(), evaluate = vi.spyOn(channel.client, 'evaluate');
    expect(await applyProperty(dialog, channel)).toEqual({ ok: false, message: t('mathGeometry.editor.pending') });
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('構成切替でも現在の図形値を渡して係数を計算し、Undo1回で戻す', async () => {
    const before = useAppStore.getState(), channel = transport();
    expect(await runMathConfigurationAction({ kind: 'activate', id: 'triple' }, { createClient: () => channel.client })).toEqual({ ok: true });
    const after = useAppStore.getState();
    expect(after.document.activeConfigurationId).toBe('triple');
    expect(after.document.parameters.map(parameter => parameter.value.value)).toEqual([7.5, 22.5]);
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(channel.terminated()).toBe(1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(before.document);
  });

  it('構成切替は形の計算中に文書を変えず、新しい世代の値が届いてから評価する', async () => {
    useAppStore.getState().recordRecomputeRequest(2);
    const before = useAppStore.getState(), channel = transport(), createClient = vi.fn(() => channel.client);
    const pending = runMathConfigurationAction({ kind: 'activate', id: 'triple' }, { createClient });
    expect(createClient).not.toHaveBeenCalled();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    publishMeasurement(before.document, 9, 2);
    expect(await pending).toEqual({ ok: true });
    expect(useAppStore.getState().document.parameters.map(parameter => parameter.value.value)).toEqual([9, 27]);
  });

  it.each(['abort', 'document', 'version'] as const)('構成切替の計算待ち中の%sは文書を公開せず待機を解放する', async kind => {
    invalidate('pending');
    const original = useAppStore.getState(), controller = new AbortController();
    const createClient = vi.fn(() => transport().client);
    const pending = runMathConfigurationAction({ kind: 'activate', id: 'triple' }, { signal: controller.signal, createClient });
    if (kind === 'abort') controller.abort();
    else if (kind === 'version') useAppStore.setState({ documentVersion: original.documentVersion + 1 });
    else useAppStore.getState().applyDocument({ ...original.document, name: '別の編集' });
    const before = useAppStore.getState();
    expect((await pending).ok).toBe(false);
    publishMeasurement(before.document, 11, 2);
    expect(createClient).not.toHaveBeenCalled();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it.each(['cancelled', 'notEvaluated'] as const)('構成切替は形が%sならWorkerを起こさず文書を変えない', async kind => {
    invalidate(kind);
    const before = useAppStore.getState(), createClient = vi.fn(() => transport().client);
    expect((await runMathConfigurationAction({ kind: 'activate', id: 'triple' }, { createClient })).ok).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it('図形由来の係数を改名し、識別番号を保って各構成の参照も書き換える', async () => {
    const before = useAppStore.getState(), channel = transport();
    expect(await runMathParameterRename('P', '幅', { createClient: () => channel.client })).toEqual({ ok: true });
    const after = useAppStore.getState();
    expect(after.document.parameters[0]).toMatchObject({ name: '幅', mathId: 'coefficient:1', value: { value: 7.5 } });
    expect(after.document.parameters[1].value.value).toBe(15);
    expect(after.document.parameters[1].value.source).toContain('coef("幅")');
    expect(after.document.parameters[1].value.source).not.toContain('coef("P")');
    for (const configuration of after.document.configurations) {
      expect(configuration.values).toHaveProperty('幅');
      expect(configuration.values).not.toHaveProperty('P');
      expect(configuration.mathDefinitions?.Q.expression).toMatchObject({ operands: [
        coefficient('coefficient:1', '幅'), { kind: 'number' },
      ] });
    }
    expect(after.document.mathGeometry).toBe(before.document.mathGeometry);
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(channel.terminated()).toBe(1);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(before.document);
  });

  it.each(unavailable)('改名時に%sなら理由を返して文書とUndoを変えない', async kind => {
    invalidate(kind);
    const before = useAppStore.getState(), createClient = vi.fn(() => transport().client);
    expect(await runMathParameterRename('P', '幅', { createClient })).toEqual({ ok: false, message: t('mathGeometry.editor.pending') });
    expect(createClient).not.toHaveBeenCalled();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it.each(['property', 'configuration', 'rename'] as const)('%sの評価中に図形の世代が変われば古い値で公開しない', async entry => {
    const before = useAppStore.getState(), channel = transport(true);
    const pending = entry === 'property' ? applyProperty(propertyDialog(), channel)
      : entry === 'configuration' ? runMathConfigurationAction({ kind: 'activate', id: 'triple' }, { createClient: () => channel.client })
        : runMathParameterRename('P', '幅', { createClient: () => channel.client });
    await channel.firstRequest;
    useAppStore.getState().recordRecomputeRequest(2);
    publishMeasurement(before.document, 9, 2);
    channel.release();
    expect((await pending).ok).toBe(false);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it.each(['abort', 'document', 'version'] as const)('図形値を渡した改名も%s後の遅い返信では文書を変えない', async kind => {
    const original = useAppStore.getState(), channel = transport(true), controller = new AbortController();
    const pending = runMathParameterRename('P', '幅', { signal: controller.signal, createClient: () => channel.client });
    await channel.firstRequest;
    if (kind === 'abort') controller.abort();
    else if (kind === 'version') useAppStore.setState({ documentVersion: original.documentVersion + 1 });
    else useAppStore.getState().applyDocument({ ...original.document, name: '別の編集' });
    const before = useAppStore.getState();
    expect(await pending).toEqual({ ok: false, message: t('math.operation.cancelled') });
    channel.release();
    expect(channel.terminated()).toBe(1);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });

  it('図形の定義がない文書の欄は計算待ちを増やさない', async () => {
    const before = useAppStore.getState().document;
    const parameters = before.parameters.map(parameter => ({ ...parameter, value: expressionValueFromNumber(4) }));
    useAppStore.getState().applyDocument({ ...before, mathGeometry: undefined, parameters,
      configurations: createDefaultConfigurations(parameters) });
    useAppStore.setState({ mathGeometryResult: null });
    expect(await applyProperty(propertyDialog(), transport())).toEqual({ ok: true });
    expect(pointX(useAppStore.getState().document).value).toBe(8);
  });
});
