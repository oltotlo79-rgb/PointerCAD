import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpressionValue } from '@pointercad/expression';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply, type MathNode } from '@pointercad/expression/math/contracts';
import { createMathBackend, executeMathWorkRequest } from '@pointercad/expression/math/worker';
import {
  absoluteCoordinate, appendFeature, appendSolid, assignBodyAppearance, createEmptyPartDocument,
  createPointFeature, DEFAULT_APPEARANCE, DEFAULT_MATH_GEOMETRY_TOLERANCE, evaluateDocumentMath,
  mathGeometryCoefficientId, replaceSketch, type DocumentMathContext, type MathGeometryOutcome, type PartDocument,
} from '@pointercad/model';
import { t } from '../i18n/t.js';
import { parameterRowsOf } from '../parameters/parameterCommands.js';
import { evaluateFieldSource, pendingFieldVariables } from '../shell/propertyFieldUnits.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import {
  createFakeRecompute, extrudeFeature, resetTestStore, resultFor, tick, type PendingRecompute,
} from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { PropertyMathField } from './PropertyMathField.js';
import { currentMathGeometry } from './mathGeometryResults.js';

const backend = createMathBackend();
const detachments: (() => void)[] = [];
const geometryId = 'measured-x';

function coefficient(id: string, label: string): MathNode {
  return { kind: 'symbol', reference: { role: 'coefficient', id, label } };
}

function formula(source: string, expression: MathNode): ExpressionValue {
  return { source, value: 999, display: '999', mathDefinition: {
    format: 'pointercad-math/1', source, expression, inputNotation: 'text', angleUnit: 'degree',
  } };
}

function fixture(geometry: boolean): PartDocument {
  const initial = createEmptyPartDocument();
  let sketch = initial.sketches[0];
  sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(3, 0, 0)));
  sketch = appendFeature(sketch, createPointFeature(sketch, { ...absoluteCoordinate(0, 0, 0),
    x: formula('coef("B")+1', { kind: 'operation', operation: 'add',
      operands: [coefficient('coefficient:2', 'B'), { kind: 'number', decimal: '1' }] }),
  }));
  return { ...appendSolid(replaceSketch(initial, sketch), extrudeFeature('solid-1')), parameters: [
    { name: 'A', mathId: 'coefficient:1', unit: 'mm', description: '',
      value: geometry ? formula('coef("Measured")', coefficient(mathGeometryCoefficientId(geometryId), 'Measured'))
        : formula('3', { kind: 'number', decimal: '3' }) },
    { name: 'B', mathId: 'coefficient:2', unit: 'mm', description: '', value: { source: 'A*2', value: 999, display: '999' } },
    { name: 'Unused', mathId: 'coefficient:3', unit: 'none', description: '',
      value: { source: '5', value: 999, display: '999' } },
  ], ...(geometry ? { mathGeometry: [{ id: geometryId, documentId: initial.id, name: 'Measured',
    quantity: { kind: 'coordinate' as const, component: 'X' as const,
      point: { kind: 'sketch-point' as const, sketchId: sketch.id,
        reference: { kind: 'point' as const, pointId: sketch.features[0].id } } },
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE,
  }] } : {}) };
}

function fieldValue(document = useAppStore.getState().document): ExpressionValue {
  const point = document.sketches[0].features[1];
  if (point.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('Expected an absolute point');
  return point.at.x;
}

function renderField(): string {
  const storedValue = fieldValue();
  const field = { ...createNumericInput('point', 'point', 'absolute').fields[0], source: storedValue.source };
  // Read the live Zustand snapshot, as the browser does, while rendering the real field in Node.
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try {
    return renderToStaticMarkup(React.createElement(PropertyMathField, {
      storedValue, replaceValue: document => document, field, result: { key: field.key, value: storedValue, error: null },
      focused: false, onChange: () => undefined, onFocus: () => undefined,
    }));
  } finally { snapshot.mockRestore(); }
}

function legacyField() {
  const state = useAppStore.getState();
  return evaluateFieldSource('B+1', 'mm', false, { ...state.parameterAnalysis,
    pendingVariables: pendingFieldVariables(state), lengthUnit: 'mm' });
}

function channel() {
  const evaluate = vi.fn<DocumentMathContext['client']['evaluate']>(request => {
    const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
    const reply = decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(request.coefficients.map(entry => entry.id)), declaredIds: new Set() });
    return Promise.resolve({ status: 'result', identity: request.identity, result: reply.result });
  });
  return { evaluate };
}

async function complete(call: PendingRecompute, client: ReturnType<typeof channel>, measured = 3): Promise<void> {
  const document = call.document, generation = call.options.generation ?? 0;
  const outcomes: MathGeometryOutcome[] = document.mathGeometry === undefined ? [] : [{
    id: geometryId, documentId: document.id, generation, status: 'value', kind: 'real', value: measured,
    unit: 'mm', representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE,
  }];
  const result = await evaluateDocumentMath(document, { client,
    identity: { documentId: document.id, documentVersion: generation }, isCurrent: () => true,
    geometry: new Map(outcomes.map(outcome => [outcome.id, outcome])),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.failures));
  expect(fieldValue(result.document).value).toBe(measured * 2 + 1);
  call.settle({ ...resultFor(result.document), generation, parameterAnalysis: result.analysis, mathGeometry: outcomes });
  await tick();
}

async function opened(geometry = false) {
  useAppStore.getState().resetDocument(fixture(geometry));
  const fake = createFakeRecompute(), client = channel();
  detachments.push(attachPartRecompute(fake.recompute));
  await complete(fake.calls[0], client);
  expect(renderField()).toContain('= 7');
  expect(useAppStore.getState().document.parameters[0].value.value).toBe(999);
  return { fake, client };
}

function changeAppearance(): void {
  useAppStore.getState().applyDocument(assignBodyAppearance(useAppStore.getState().document, 'solid-1', DEFAULT_APPEARANCE));
}

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ requestedGeneration: 0, completedGeneration: 0, lastOutcome: 'idle' });
});
afterEach(() => { for (const detach of detachments.splice(0)) detach(); });

describe('BUG-01 appearance changes preserve evaluated values', () => {
  it.each([false, true])('keeps coefficient rows and legacy fields without another calculation (geometry=%s)', async geometry => {
    const { fake, client } = await opened(geometry);
    expect(client.evaluate).toHaveBeenCalledTimes(2);
    const before = useAppStore.getState();
    changeAppearance();
    const state = useAppStore.getState();
    expect(state.document.parameters).toBe(before.document.parameters);
    expect(fake.calls).toHaveLength(1);
    expect(client.evaluate).toHaveBeenCalledTimes(2);
    expect(state.parameterAnalysis.variables.get('A')).toBe(3);
    expect(state.parameterAnalysis.variables.get('B')).toBe(6);
    expect(state.parameterAnalysis.exactVariables).toBe(before.parameterAnalysis.exactVariables);
    expect(state.parameterAnalysis.mathCoefficients).toBe(before.parameterAnalysis.mathCoefficients);
    expect(parameterRowsOf(state.document, state.parameterAnalysis, currentMathGeometry(state)))
      .toMatchObject([{ value: 3, failureMessage: null }, { value: 6, failureMessage: null }, { value: 5, failureMessage: null }]);
    expect(legacyField()).toMatchObject({ ok: true, value: { value: 7 } });
  });

  it.each([false, true])('keeps the verified structured field after appearance changes (geometry=%s)', async geometry => {
    const { fake, client } = await opened(geometry);
    changeAppearance();
    expect(renderField()).toContain('= 7');
    expect(renderField()).not.toContain(t('math.calculating'));
    expect(fake.calls).toHaveLength(1);
    expect(client.evaluate).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('hides structured values throughout partial history (H1, geometry=%s)', async geometry => {
    const { fake, client } = await opened(geometry);
    useAppStore.getState().setTimelineIndex(0);
    expect(renderField()).not.toContain('= 7');
    await complete(fake.calls[1], client);
    expect(renderField()).not.toContain('= 7');
    expect(renderField()).toContain(t('math.calculating'));
  });
});

describe('BUG-01 reuse boundaries and recomputation', () => {
  it.each([false, true])('keeps values through appearance Undo/Redo (geometry=%s)', async geometry => {
    const { fake, client } = await opened(geometry);
    changeAppearance();
    useAppStore.getState().undo();
    expect(renderField()).toContain('= 7');
    expect(legacyField()).toMatchObject({ ok: true, value: { value: 7 } });
    useAppStore.getState().redo();
    expect(renderField()).toContain('= 7');
    expect(legacyField()).toMatchObject({ ok: true, value: { value: 7 } });
    expect(fake.calls).toHaveLength(1);
    expect(client.evaluate).toHaveBeenCalledTimes(2);
  });

  it('refreshes unused names after a presentation-only saved-problem change', async () => {
    const { fake, client } = await opened();
    const before = useAppStore.getState();
    expect(before.parameterAnalysis.unused).toContain('Unused');
    const definition = formula('coef("Unused")', coefficient('coefficient:3', 'Unused')).mathDefinition;
    if (definition === undefined) throw new Error('Expected math definition');
    useAppStore.getState().applyDocument({ ...before.document, unresolvedMathProblems: [
      { id: 'math-problem:1', name: 'Saved', status: 'unresolved', definition },
    ] });
    const after = useAppStore.getState();
    expect(after.parameterAnalysis.unused).not.toContain('Unused');
    expect(after.parameterAnalysis.variables).toBe(before.parameterAnalysis.variables);
    expect(fake.calls).toHaveLength(1);
    expect(client.evaluate).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('invalidates shape edits and accepts fresh results after an in-flight appearance change (geometry=%s)', async geometry => {
    const { fake, client } = await opened(geometry);
    changeAppearance();
    const before = useAppStore.getState().document;
    useAppStore.getState().applyDocument(geometry ? { ...before, sketches: [...before.sketches] }
      : { ...before, parameters: before.parameters.map(parameter => parameter.name === 'A'
        ? { ...parameter, value: formula('4', { kind: 'number', decimal: '4' }) } : parameter) });
    expect(fake.calls).toHaveLength(2);
    expect(useAppStore.getState().parameterAnalysis.variables.has('A')).toBe(false);
    expect(renderField()).not.toContain('= 7');
    useAppStore.getState().applyDocument({ ...useAppStore.getState().document, name: 'Presentation edit during recomputation' });
    expect(fake.calls).toHaveLength(2);
    await complete(fake.calls[1], client, 4);
    expect(renderField()).toContain('= 9');
    expect(legacyField()).toMatchObject({ ok: true, value: { value: 9 } });
    expect(client.evaluate).toHaveBeenCalledTimes(4);
    expect(useAppStore.getState().document.parameters[0].value.value).toBe(999);
  });

  it.each(['reset', 'open'] as const)('does not carry evaluated values into a freshly read document (%s)', async action => {
    const { fake, client } = await opened(true);
    changeAppearance();
    const reloaded = structuredClone(useAppStore.getState().document);
    if (action === 'reset') useAppStore.getState().resetDocument(reloaded);
    else useAppStore.getState().applyDocument(reloaded, { replacesDocument: true });
    expect(fake.calls).toHaveLength(2);
    expect(useAppStore.getState().parameterAnalysis.variables.has('A')).toBe(false);
    expect(renderField()).not.toContain('= 7');
    await complete(fake.calls[1], client, 4);
    expect(renderField()).toContain('= 9');
    expect(client.evaluate).toHaveBeenCalledTimes(4);
  });

  it.each(['generation', 'cancelled', 'failed', 'notEvaluated'] as const)('hides structured geometry values when %s, like legacy fields', async kind => {
    await opened(true);
    if (kind === 'generation') useAppStore.getState().recordRecomputeRequest(2);
    else if (kind === 'cancelled') useAppStore.setState({ recomputeCancelled: true });
    else if (kind === 'failed') useAppStore.setState({ requestedGeneration: 2, completedGeneration: 2, lastOutcome: 'failed' });
    else {
      const snapshot = useAppStore.getState().mathGeometryResult;
      if (snapshot === null) throw new Error('Expected a completed snapshot');
      useAppStore.setState({ mathGeometryResult: { ...snapshot, evaluated: false } });
    }
    expect(legacyField().ok).toBe(false);
    expect(renderField()).not.toContain('= 7');
    expect(renderField()).toContain(t('math.calculating'));
  });

  it('keeps history values hidden until full recomputation finishes, including cancellation', async () => {
    const { fake, client } = await opened(true);
    useAppStore.getState().setTimelineIndex(-1);
    await complete(fake.calls[1], client, 4);
    expect(renderField()).not.toContain('= 9');
    useAppStore.getState().setTimelineIndex(null);
    expect(renderField()).not.toContain('= 9');
    fake.calls[2].settle({ ...resultFor(fake.calls[2].document), generation: fake.calls[2].options.generation ?? 0, cancelled: true });
    await tick();
    expect(renderField()).not.toContain('= 9');
    expect(legacyField().ok).toBe(false);
    useAppStore.getState().applyDocument({ ...useAppStore.getState().document, sketches: [...useAppStore.getState().document.sketches] });
    await complete(fake.calls[3], client, 5);
    expect(renderField()).toContain('= 11');
    expect(legacyField()).toMatchObject({ ok: true, value: { value: 11 } });
    expect(client.evaluate).toHaveBeenCalledTimes(6);
  });
});
