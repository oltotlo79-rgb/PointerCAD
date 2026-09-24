import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { collectMathCoefficients, expressionValueFromNumber } from '@pointercad/expression';
import { analyzeParameters, createAssemblyDocument, createDrawingDocument, createEmptyPartDocument,
  DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryDerivedParameters, mathGeometryParameterDraft,
  prepareDocumentMathIdentity, type MathGeometryDefinition, type MathGeometryOutcome, type MathGeometryQuantity,
  type MathGeometryValueUnit, type Parameter, type ParameterAnalysis, type ParameterUnit, type PartDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { ParameterPanel } from '../parameters/ParameterPanel.js';
import { parameterRowsOf } from '../parameters/parameterCommands.js';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createParameterFromMathGeometryCommand, type MathGeometryParameterCommandReason } from './mathGeometryParameterCommands.js';
import { currentMathGeometry, type CurrentMathGeometry } from './mathGeometryResults.js';

const CURVE = { kind: 'sketch-curve', sketchId: 'sketch-1', featureId: 'line-1' } as const;
const LENGTH: MathGeometryQuantity = { kind: 'length', curve: CURVE };

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ drawing: null, requestedGeneration: 0, completedGeneration: 0, lastOutcome: 'idle' });
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

function parameter(name = '板厚', value = 3): Parameter {
  return { name, value: expressionValueFromNumber(value), unit: 'mm', description: '' };
}

function definition(quantity: MathGeometryQuantity = LENGTH, name = '測定1', id = 'g1'): MathGeometryDefinition {
  return { id, documentId: 'part-1', name, quantity, tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}

function part(item = definition(), parameters: readonly Parameter[] = []): PartDocument {
  return { ...createEmptyPartDocument(), parameters, mathGeometry: [item] };
}

function measured(document: PartDocument, unit: MathGeometryValueUnit = 'mm', value = 23.5): MathGeometryOutcome {
  return { id: 'g1', documentId: document.id, generation: 1, status: 'value', kind: 'real', value, unit,
    representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}

/** Use the actual store publication path, with only the shape measurement supplied as fixture data. */
function open(document = part(), outcomes: readonly MathGeometryOutcome[] = [measured(document)], analysis?: ParameterAnalysis): PartDocument {
  const state = useAppStore.getState();
  state.resetDocument(document);
  state.recordRecomputeRequest(1);
  state.applyRecompute(document, { ...resultFor(document), generation: 1, mathGeometry: outcomes,
    ...(analysis === undefined ? {} : { parameterAnalysis: analysis }) });
  state.recordRecomputeCompletion(1, 'success');
  return document;
}

function commandState() {
  const state = useAppStore.getState();
  return { ...state, applyDocument: vi.fn(state.applyDocument) };
}

function refused(reason: MathGeometryParameterCommandReason = 'noValue', owner = useAppStore.getState().document, id = 'g1'): void {
  const before = useAppStore.getState(), contents = JSON.stringify(before.document);
  const state = commandState();
  const result = createParameterFromMathGeometryCommand(state, owner, id);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected refusal');
  expect(result.reason).toBe(reason);
  expect(result.message).toBe(t(result.key));
  if (reason === 'noValue') expect(result.key).toBe('mathGeometry.createParameter.disabled.noValue');
  expect(state.applyDocument).not.toHaveBeenCalled();
  expect(useAppStore.getState()).toBe(before);
  expect(JSON.stringify(before.document)).toBe(contents);
}

describe('createParameterFromMathGeometryCommand（GR-31）', () => {
  it('係数参照と既存係数の番号を一緒に公開し、Undo一回で元文書へ戻す', () => {
    const owner = open(part(definition(), [parameter()]));
    const contents = JSON.stringify(owner), before = useAppStore.getState(), state = commandState();
    const result = createParameterFromMathGeometryCommand(state, owner, 'g1');
    expect(result).toEqual({ ok: true, name: '測定1の値', key: 'mathGeometry.createParameter.notice', message: '係数「測定1の値」を作りました。' });
    const after = useAppStore.getState(), created = after.document.parameters[1];
    expect(state.applyDocument).toHaveBeenCalledExactlyOnceWith(after.document);
    expect(after.document.mathGeometry).toBe(owner.mathGeometry);
    expect(after.document.parameters.map(item => item.mathId)).toEqual(['coefficient:1', 'coefficient:2']);
    expect(after.document.mathParameterSerial).toBe(2);
    expect(created.value.source).toBe('coef("測定1")');
    expect(created.value.value).toBe(23.5);
    expect(created.value.mathDefinition?.source).toBe(created.value.source);
    expect(created.value.mathDefinition?.expression).toEqual({ kind: 'symbol',
      reference: { role: 'coefficient', id: 'math-geometry:g1', label: '測定1' } });
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(after.undoStack.past.at(-1)).toBe(owner);
    expect(after.isComputing).toBe(true);
    expect(currentMathGeometry(after).status).toBe('computing');
    expect(JSON.stringify(owner)).toBe(contents);
    after.undo();
    expect(useAppStore.getState().document).toBe(owner);
    expect(useAppStore.getState().document.mathParameterSerial).toBeUndefined();
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toBe(after.document);
  });

  it.each([undefined, 0, 40])('係数のない文書でもserial=%sから番号を割り当てる', serial => {
    const owner = open({ ...part(), ...(serial === undefined ? {} : { mathParameterSerial: serial }) });
    expect(createParameterFromMathGeometryCommand(commandState(), owner, 'g1').ok).toBe(true);
    expect(useAppStore.getState().document.parameters[0].mathId).toBe(`coefficient:${(serial ?? 0) + 1}`);
    expect(useAppStore.getState().document.mathParameterSerial).toBe((serial ?? 0) + 1);
  });

  it('既存の識別番号を保ち、削除済み番号を再利用しない', () => {
    const owner = open({ ...part(definition(), [{ ...parameter(), mathId: 'coefficient:7' }]), mathParameterSerial: 42 });
    expect(createParameterFromMathGeometryCommand(commandState(), owner, 'g1').ok).toBe(true);
    expect(useAppStore.getState().document.parameters.map(item => item.mathId)).toEqual(['coefficient:7', 'coefficient:43']);
    expect(useAppStore.getState().document.mathParameterSerial).toBe(43);
  });

  const units: readonly { readonly unit: MathGeometryValueUnit; readonly quantity: MathGeometryQuantity;
    readonly parameterUnit: ParameterUnit; readonly description: string }[] = [
    { unit: 'mm', quantity: LENGTH, parameterUnit: 'mm', description: '図形の測定値「測定1」（長さ、mm）から作った係数' },
    { unit: 'mm2', quantity: { kind: 'area', shape: { kind: 'body', featureId: 'box' } }, parameterUnit: 'none',
      description: '図形の測定値「測定1」（面積、mm²）から作った係数' },
    { unit: 'mm3', quantity: { kind: 'volume', body: { kind: 'body', featureId: 'box' } }, parameterUnit: 'none',
      description: '図形の測定値「測定1」（体積、mm³）から作った係数' },
    { unit: 'degree', quantity: { kind: 'angle', first: CURVE, second: CURVE, unit: 'degree' }, parameterUnit: 'degree',
      description: '図形の測定値「測定1」（2直線の角度、度）から作った係数' },
    { unit: 'radian', quantity: { kind: 'angle', first: CURVE, second: CURVE, unit: 'radian' }, parameterUnit: 'none',
      description: '図形の測定値「測定1」（2直線の角度、ラジアン）から作った係数' },
  ];
  it.each(units)('$unitの単位・説明を保ち、表示単位inchでも測定値を換算しない', ({ unit, quantity, parameterUnit, description }) => {
    const document = part(definition(quantity)), value = 1.2345678901234567;
    const owner = open(document, [measured(document, unit, value)]);
    useAppStore.setState({ displaySettings: { ...useAppStore.getState().displaySettings, lengthUnit: 'inch' } });
    expect(createParameterFromMathGeometryCommand(commandState(), owner, 'g1').ok).toBe(true);
    const created = useAppStore.getState().document.parameters[0];
    expect(created.unit).toBe(parameterUnit);
    expect(created.description).toBe(description);
    expect(created.value.value).toBe(value);
  });

  it('座標の説明には成分の見出しを使う', () => {
    const owner = open(part(definition({ kind: 'coordinate', component: 'Z',
      point: { kind: 'sketch-point', sketchId: 'sketch-1', reference: { kind: 'point', pointId: 'p1' } } })));
    expect(createParameterFromMathGeometryCommand(commandState(), owner, 'g1').ok).toBe(true);
    expect(useAppStore.getState().document.parameters[0].description).toBe('図形の測定値「測定1」（Z座標、mm）から作った係数');
  });

  it('追加した式を各構成へ同期し、他の係数の構成別の値は保つ', () => {
    const owner = open({ ...part(definition(), [parameter()]), activeConfigurationId: 'c1', configurations: [
      { id: 'c1', name: '構成1', values: { 板厚: '3' } }, { id: 'c2', name: '構成2', values: { 板厚: '9' } },
    ] });
    expect(createParameterFromMathGeometryCommand(commandState(), owner, 'g1').ok).toBe(true);
    const document = useAppStore.getState().document;
    expect(document.configurations.map(item => item.values)).toEqual([
      { 板厚: '3', 測定1の値: 'coef("測定1")' }, { 板厚: '9', 測定1の値: 'coef("測定1")' },
    ]);
    for (const configuration of document.configurations) {
      expect(configuration.mathDefinitions?.['測定1の値']).toEqual(document.parameters[1].value.mathDefinition);
    }
  });

  it.each(['parameter', 'geometry'] as const)('%sに追加先の名前があれば重複として断る', kind => {
    const document = part();
    open(kind === 'parameter' ? { ...document, parameters: [parameter('測定1の値')] }
      : { ...document, mathGeometry: [...document.mathGeometry ?? [], definition(LENGTH, '測定1の値', 'g2')] });
    refused('duplicateName');
  });

  it.each(['1測定', '測 定', '測定!'])('係数名に使えない測定名%sを断る', name => {
    open(part(definition(LENGTH, name)));
    refused('invalidName');
  });

  it.each(['snapshot', 'generation', 'shape', 'cancelled', 'timeline', 'notEvaluated'] as const)('%sで現在の測定値がない間は文書を変えない', kind => {
    const owner = open(), state = useAppStore.getState();
    switch (kind) {
      case 'snapshot': useAppStore.setState({ mathGeometryResult: null }); break;
      case 'generation': state.recordRecomputeRequest(2); break;
      case 'shape': state.applyDocument({ ...owner, solids: [...owner.solids] }); break;
      case 'cancelled': useAppStore.setState({ recomputeCancelled: true }); break;
      case 'timeline': useAppStore.setState({ timelineIndex: 0 }); break;
      case 'notEvaluated': state.applyRecompute(owner, { ...resultFor(owner), generation: 1 }); break;
    }
    refused();
  });

  it.each(['missing', 'unresolved', 'boolean'] as const)('%sの結果では係数を作らない', kind => {
    const document = part();
    const common = { id: 'g1', documentId: document.id, generation: 1 };
    const outcomes: readonly MathGeometryOutcome[] = kind === 'missing' ? [] : kind === 'unresolved'
      ? [{ ...common, status: 'unresolved', reason: 'missing-reference', message: '参照先が見つかりません。' }]
      : [{ ...common, status: 'value', kind: 'boolean', value: true, representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE }];
    open(document, outcomes);
    refused();
  });

  it.each([NaN, Infinity, -Infinity])('非有限の測定値%sは文書を変えない', value => {
    const document = part();
    open(document, [measured(document, 'mm', value)]);
    refused();
  });

  it('存在しない定義では値なしの鍵を返す', () => { open(); refused('notFound', useAppStore.getState().document, 'gone'); });

  it.each(['documentId', 'id', 'generation'] as const)('結果の%sが異なる測定値を使わない', field => {
    const owner = open(), outcome = measured(owner);
    useAppStore.setState({ mathGeometryResult: { document: owner, generation: 1, evaluated: true,
      outcomes: new Map([['g1', { ...outcome, ...(field === 'generation' ? { generation: 2 } : { [field]: 'other' }) }]]) } });
    refused();
  });

  it('同じ文書IDでも別の文書の行からは追加しない', () => {
    const owner = open();
    open(part());
    refused('staleDocument', owner);
  });

  it.each(['assembly', 'drawing'] as const)('%sでは部品の係数を作らない', kind => {
    open();
    const state = useAppStore.getState();
    if (kind === 'assembly') {
      state.openAssembly(createAssemblyDocument('組立'));
      expect(useAppStore.getState().assembly?.name).toBe('組立');
    } else {
      state.openDrawing(createDrawingDocument('図面', {
        sourceRef: 'part-1', sourceKind: 'part', fileName: '', path: '', contentHash: '', importedAt: '',
      }));
      expect(useAppStore.getState().drawing?.source.sourceRef).toBe('part-1');
    }
    refused('notPart');
  });
});

/** The direct and legacy-transitive coefficients intentionally store different old values. */
function derivedPart(): PartDocument {
  const document = part();
  const draft = mathGeometryParameterDraft(document, 'g1', { name: '直接', value: 111, unit: 'mm', description: '' });
  if (!draft.ok) throw new Error(draft.message);
  return prepareDocumentMathIdentity({ ...document, parameters: [draft.parameter,
    { ...parameter('間接', 222), value: { source: '直接*2', value: 222, display: '222' } }, parameter('固定', 7)] });
}

function evaluated(document: PartDocument): ParameterAnalysis {
  return { ...analyzeParameters(document.parameters, []), variables: new Map([['直接', 23.5], ['間接', 47], ['固定', 7]]),
    exactVariables: new Map([['直接', '23.5'], ['間接', '47'], ['固定', '7']]), failures: [],
    geometryDerived: mathGeometryDerivedParameters(document.parameters) };
}

function renderPanel(): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(createElement(ParameterPanel)); }
  finally { snapshot.mockRestore(); }
}

describe('係数行の図形由来と現在値（GR-31）', () => {
  it('実解析の直接・間接参照に測定名を付け、通常の係数行は従来の形を保つ', () => {
    const document = derivedPart();
    open(document, [measured(document)], evaluated(document));
    const state = useAppStore.getState(), rows = parameterRowsOf(document, state.parameterAnalysis, currentMathGeometry(state));
    expect(rows.map(row => row.geometry)).toEqual([
      { definitionNames: ['測定1'], pending: false }, { definitionNames: ['測定1'], pending: false }, undefined,
    ]);
    expect(rows.map(row => row.value)).toEqual([23.5, 47, 7]);
  });

  it('最初の再計算前も静的な由来を失わず、現在性を渡さなければ計算中にする', () => {
    const document = derivedPart(), analysis = analyzeParameters(document.parameters, []);
    expect(analysis.geometryDerived).toBeUndefined();
    expect(parameterRowsOf(document, analysis).map(row => row.geometry?.pending)).toEqual([true, true, undefined]);
  });

  it('改名後の測定名は現在の定義から読み直す', () => {
    const document = derivedPart(), analysis = evaluated(document);
    const renamed = { ...document, mathGeometry: [definition(LENGTH, '新しい測定名')] };
    expect(parameterRowsOf(renamed, analysis)[0].geometry?.definitionNames).toEqual(['新しい測定名']);
  });

  it('定義がなくなっても図形由来の印は消えない', () => {
    const document = derivedPart();
    expect(parameterRowsOf({ ...document, mathGeometry: [] }, evaluated(document))[0].geometry)
      .toEqual({ definitionNames: [], pending: true });
  });

  const pendingStates: readonly Exclude<CurrentMathGeometry, { readonly status: 'current' }>[] = [
    { status: 'computing' }, { status: 'cancelled' }, { status: 'timeline' }, { status: 'notPart' }, { status: 'notEvaluated', message: null },
  ];
  it.each(pendingStates)('$statusの間は直接・間接の両方を計算中とする', current => {
    const document = derivedPart();
    expect(parameterRowsOf(document, evaluated(document), current).map(row => row.geometry?.pending)).toEqual([true, true, undefined]);
  });

  it('実パネルが由来の印とツールチップを表示し、最新解析の値を使う', () => {
    const document = derivedPart();
    open(document, [measured(document)], evaluated(document));
    const before = useAppStore.getState(), markup = renderPanel();
    expect(markup.split(`>${t('mathGeometry.derived')}</span>`)).toHaveLength(3);
    expect(markup).toContain(`title="${t('mathGeometry.derivedTooltip')}\n測定1"`);
    expect(markup).toContain('= 23.5');
    expect(markup).toContain('= 47');
    expect(markup).not.toContain('= 111');
    expect(markup).not.toContain('= 222');
    expect(useAppStore.getState()).toBe(before);
  });

  it.each(['generation', 'shape', 'timeline', 'cancelled'] as const)('実パネルは%sの変更直後から古い値を隠す', kind => {
    const document = derivedPart();
    open(document, [measured(document)], evaluated(document));
    const state = useAppStore.getState();
    switch (kind) {
      case 'generation': state.recordRecomputeRequest(2); break;
      case 'shape': state.applyDocument({ ...document, solids: [...document.solids] }); break;
      case 'timeline': useAppStore.setState({ timelineIndex: 0 }); break;
      case 'cancelled': useAppStore.setState({ recomputeCancelled: true }); break;
    }
    const markup = renderPanel();
    expect(markup.split(`>${t('mathGeometry.status.pending')}</p>`)).toHaveLength(3);
    expect(markup).not.toMatch(/= (?:23\.5|47|111|222)</u);
    expect(markup).toContain('= 7');
  });

  it('現在の解析が失敗した行では、古い値の代わりに理由を表示する', () => {
    const document = derivedPart(), analysis = evaluated(document);
    open(document, [measured(document)], { ...analysis, variables: new Map([['固定', 7]]), failures: [
      { name: '直接', message: '測定値がありません' }, { name: '間接', message: '係数を計算できません' },
    ] });
    const markup = renderPanel();
    expect(markup).toContain('測定値がありません');
    expect(markup).toContain('係数を計算できません');
    expect(markup).not.toMatch(/= (?:111|222)</u);
  });

  it('作成直後の実パネルでも由来を示して計算完了まで値を隠す', () => {
    const owner = open();
    expect(createParameterFromMathGeometryCommand(commandState(), owner, 'g1').ok).toBe(true);
    const markup = renderPanel();
    expect(markup).toContain(`>${t('mathGeometry.derived')}</span>`);
    expect(markup).toContain(`>${t('mathGeometry.status.pending')}</p>`);
    expect(markup).not.toContain('= 23.5');
    const created = useAppStore.getState().document.parameters[0].value.mathDefinition;
    if (created === undefined) throw new Error('Missing coefficient formula');
    expect(collectMathCoefficients(created.expression)).toEqual([
      { role: 'coefficient', id: 'math-geometry:g1', label: '測定1' },
    ] satisfies ReturnType<typeof collectMathCoefficients>);
  });
});
