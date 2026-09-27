import { expressionValueFromNumber } from '@pointercad/expression';
import { MATH_INPUT_FORMAT, type StoredMathExpression } from '@pointercad/expression/math/contracts';
import {
  appendSolid,
  createAssemblyDocument,
  createDrawingDocument,
  DEFAULT_MATH_GEOMETRY_TOLERANCE,
  mathGeometryCoefficientId,
  resolveSketch,
  type MathGeometryOutcome,
  type MathGeometryQuantity,
  type PartDocument,
  type SolidBody,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { extrudeFeature, partWithPoint } from '../store/testing/createTestStore.js';
import {
  mathGeometryAddReadiness,
  mathGeometryCandidateRows,
  mathGeometryKindKey,
  mathGeometryPanelGuideText,
  mathGeometryPanelVisible,
  mathGeometryReselectCandidate,
  mathGeometryRows,
  mathGeometryTargetsSummary,
  MATH_GEOMETRY_REASON_KEYS,
  type MathGeometryRowsState,
} from './mathGeometryRows.js';
import { mathGeometryToolGuide, mathGeometryToolGuideText } from './mathGeometryToolGuide.js';
import { createParameterFromMathGeometryCommand } from './mathGeometryParameterCommands.js';

// Enter through the store before its settings dependencies, as the app does.
const DISPLAY_SETTINGS = useAppStore.getInitialState().displaySettings;
const DRAWING_SOURCE = { sourceRef: 'source-1', sourceKind: 'part', fileName: 'box.pcad',
  path: '', contentHash: 'hash', importedAt: '2026-09-24T00:00:00.000Z' } as const;
const BODY = { kind: 'body', featureId: 'box' } as const;
const POINT = { kind: 'sketch-point', sketchId: 'sketch-1', reference: { kind: 'point', pointId: 'point-1' } } as const;
const CURVE = { kind: 'sketch-curve', sketchId: 'sketch-1', featureId: 'line-1' } as const;
const FACE = { kind: 'face', reference: { bodyFeatureId: 'box', index: 0,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 600, position: [0, 0, 0], axis: [0, 0, 1], radius: null } } } as const;
const QUANTITIES = {
  coordinate: { kind: 'coordinate', point: POINT, component: 'X' },
  'point-distance': { kind: 'point-distance', first: POINT, second: POINT },
  'shape-distance': { kind: 'shape-distance', first: BODY, second: BODY },
  length: { kind: 'length', curve: CURVE },
  area: { kind: 'area', shape: FACE },
  volume: { kind: 'volume', body: BODY },
  angle: { kind: 'angle', first: CURVE, second: CURVE, unit: 'degree' },
  'plane-angle': { kind: 'plane-angle', first: FACE, second: FACE, unit: 'degree' },
  'line-plane-angle': { kind: 'line-plane-angle', line: CURVE, plane: FACE, unit: 'degree' },
  'point-angle': { kind: 'point-angle', first: POINT, second: POINT, third: POINT, unit: 'degree' },
  parallel: { kind: 'parallel', first: CURVE, second: FACE },
  perpendicular: { kind: 'perpendicular', first: FACE, second: FACE },
  radius: { kind: 'radius', curve: CURVE },
  'central-angle': { kind: 'central-angle', curve: CURVE, unit: 'degree' },
  'contour-length': { kind: 'contour-length', sketchId: 'sketch-1', featureId: 'rectangle-1' },
  // GR-22: G1 comparisons (packages/model/src/measure/mathGeometryCongruence.ts).
  congruent: { kind: 'congruent', first: CURVE, second: CURVE },
  similar: { kind: 'similar', first: CURVE, second: CURVE },
} as const satisfies Record<MathGeometryQuantity['kind'], MathGeometryQuantity>;

function documentWith(quantity: MathGeometryQuantity = QUANTITIES.volume, name = 'V'): PartDocument {
  const document = appendSolid(partWithPoint(), { ...extrudeFeature('box'), name: '箱' });
  return { ...document, mathGeometry: [{ id: 'g', documentId: document.id, name, quantity,
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE }] };
}

function real(value = 24000, unit: Extract<MathGeometryOutcome, { readonly kind: 'real' }>['unit'] = 'mm3'): MathGeometryOutcome {
  return { id: 'g', documentId: 'part-1', generation: 7, status: 'value', kind: 'real', value, unit,
    representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}

function body(): SolidBody {
  return { featureId: 'box', volume: 24000, bodyKind: 'solid', isValid: true, threadMarks: [],
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 },
    faces: [{ index: 0, surfaceKind: 'plane', area: 600, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null,
      triangleOffset: 0, triangleCount: 0 }],
    edges: [{ index: 0, curveKind: 'line', length: 20, midpoint: [10, 0, 0], start: [0, 0, 0], end: [20, 0, 0],
      axis: [1, 0, 0], radius: null, segmentOffset: 0, segmentCount: 1 }],
    vertices: [{ index: 0, position: [0, 0, 0] }],
  };
}

function stateFor(document = documentWith(), outcomes: readonly MathGeometryOutcome[] = [real()],
  overrides: Partial<MathGeometryRowsState> = {}): MathGeometryRowsState {
  const sketch = document.sketches[0];
  return { document, assembly: null, drawing: null, timelineIndex: null, recomputeCancelled: false,
    requestedGeneration: 7, completedGeneration: 7, lastOutcome: 'success', partErrors: [], errorMessage: null,
    mathGeometryResult: { document, generation: 7, evaluated: true, outcomes: new Map(outcomes.map(item => [item.id, item])) },
    activeTool: 'mathGeometry', selection: [], sketch, resolvedSketch: resolveSketch(sketch), bodies: [body()],
    displaySettings: DISPLAY_SETTINGS, ...overrides };
}

function storedReference(): StoredMathExpression {
  return { format: MATH_INPUT_FORMAT, source: 'coef("V")', inputNotation: 'text', angleUnit: 'degree',
    expression: { kind: 'symbol', reference: { role: 'coefficient', id: mathGeometryCoefficientId('g'), label: 'V' } } };
}

describe('math geometry rows: values and status', () => {
  it('reads a current real row, its units, margins, unused badge and buttons', () => {
    const row = mathGeometryRows(stateFor())[0];
    expect(row).toMatchObject({ id: 'g', name: 'V', kindLabel: '体積', valueText: '24000 mm³', statusKey: null,
      statusText: null, targetsSummary: '箱 (立体)', usageCount: 0, usageText: '未使用', circular: false,
      angleUnit: null, remove: { ready: true }, createParameter: { ready: true } });
    expect(row.toleranceText).toBe('長さ 0.000001 mm / 角度 0.0000572957795131 度');
    expect(row.toleranceNote).toBe('平行・垂直などを判定する幅です。値の誤差の保証ではありません。');
  });

  it.each([
    [25.4, 'mm', 'mm', '25.4 mm'], [1500, 'mm', 'mm', '1.5 m'],
    [25.4, 'mm', 'inch', '1.000 in'], [645.16, 'mm2', 'inch', '1.000 in²'],
    [16387.064, 'mm3', 'inch', '1.000 in³'], [1200, 'mm2', 'mm', '1200 mm²'],
    [45.678, 'degree', 'inch', '45.68 度'], [Math.PI, 'radian', 'mm', '3.14159265359 ラジアン'],
  ] as const)('formats %s %s with %s display units', (value, unit, lengthUnit, expected) => {
    const state = stateFor(documentWith(), [real(value, unit)], { displaySettings: { lengthUnit } });
    expect(mathGeometryRows(state)[0].valueText).toBe(expected);
    expect(mathGeometryRows(state)[0].toleranceText).toContain('0.000001 mm');
    expect(state.mathGeometryResult?.outcomes.get('g')).toEqual(real(value, unit));
  });

  it.each([true, false])('shows the boolean %s but never offers a coefficient', value => {
    const result: MathGeometryOutcome = { id: 'g', documentId: 'part-1', generation: 7, status: 'value', kind: 'boolean', value,
      representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
    const row = mathGeometryRows(stateFor(documentWith(QUANTITIES.parallel), [result]))[0];
    expect(row.valueText).toBe(value ? 'はい' : 'いいえ');
    expect(row.createParameter.reasonKey).toBe('mathGeometry.createParameter.disabled.noValue');
  });

  const statuses = [
    ['computing', { requestedGeneration: 8 }],
    ['cancelled', { recomputeCancelled: true }],
    ['timeline', { timelineIndex: 0 }],
  ] as const;
  it.each(statuses)('hides old values in %s state', (status, overrides) => {
    const row = mathGeometryRows(stateFor(documentWith(), [real()], overrides))[0];
    expect(row.valueText).toBeNull();
    expect(row.statusKey).toBe(`mathGeometry.status.${status}`);
    expect(row.statusText).toBe(t(`mathGeometry.status.${status}`));
    expect(row.createParameter).toMatchObject({ ready: false, reasonKey: 'mathGeometry.createParameter.disabled.noValue' });
  });

  it('shows the first geometry failure when measurement was not evaluated', () => {
    const state = stateFor();
    const row = mathGeometryRows({ ...state, mathGeometryResult: { document: state.document, generation: 7,
      evaluated: false, outcomes: new Map([['g', real()]]) }, partErrors: [{ featureId: 'box', code: 'kernelFailed', message: '失敗の詳細' }] })[0];
    expect(row.valueText).toBeNull();
    expect(row.statusText).toBe('形を計算できなかったため測れません。 失敗の詳細');
  });

  it('hides results after replacing a document with the same default document ID', () => {
    const before = stateFor();
    expect(mathGeometryRows({ ...before, document: documentWith() })[0].statusKey).toBe('mathGeometry.status.computing');
  });

  it('reads the latest definition name after rename and again after Undo', () => {
    const oldDocument = documentWith();
    const renamed = { ...oldDocument, mathGeometry: oldDocument.mathGeometry?.map(item => ({ ...item, name: 'NewV' })) };
    expect(mathGeometryRows(stateFor(renamed))[0].name).toBe('NewV');
    expect(mathGeometryRows(stateFor(oldDocument))[0].name).toBe('V');
  });

  it('shows pending when a current generation has no result for the definition', () => {
    expect(mathGeometryRows(stateFor(documentWith(), []))[0]).toMatchObject({ valueText: null,
      statusKey: 'mathGeometry.status.pending', createParameter: { ready: false } });
  });

  it.each([{ documentId: 'other' }, { generation: 6 }, { id: 'other' }])('rejects an outcome with wrong identity: %j', patch => {
    const state = stateFor();
    expect(mathGeometryRows({ ...state, mathGeometryResult: { document: state.document, generation: 7, evaluated: true,
      outcomes: new Map([['g', { ...real(), ...patch }]]) } })[0].valueText).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects a nonfinite real value %s', value => {
    expect(mathGeometryRows(stateFor(documentWith(), [real(value)]))[0]).toMatchObject({
      valueText: null, statusKey: 'mathGeometry.reason.failed-geometry', createParameter: { ready: false },
    });
  });

  it.each([
    ['missing-reference', '参照先が見つかりません。選び直すか削除してください。'],
    ['failed-geometry', '参照先の形を計算できませんでした。'],
    ['unsupported', 'この参照先からはこの量を求められません。'],
    ['invalid-request', '定義の内容を確認してください。'],
    ['ambiguous-reference', '形が変わり、参照先を1つに決められません。選び直してください。'],
  ] as const)('shows the %s explanation and retains the model detail', (reason, text) => {
    const result: MathGeometryOutcome = { id: 'g', documentId: 'part-1', generation: 7, status: 'unresolved', reason, message: '詳細' };
    const row = mathGeometryRows(stateFor(documentWith(), [result]))[0];
    expect(row.statusKey).toBe(MATH_GEOMETRY_REASON_KEYS[reason]);
    expect(row.statusText).toBe(`${text} 詳細`);
    expect(row.valueText).toBeNull();
    expect(row.remove.ready).toBe(true);
    expect(row.createParameter.ready).toBe(false);
  });
});

describe('quantity headings, candidates and reselection', () => {
  it.each(Object.values(QUANTITIES))('has a typed, existing heading for $kind', quantity => {
    const key = mathGeometryKindKey(quantity);
    expect(key).toBe(quantity.kind === 'coordinate' ? 'mathGeometry.kind.coordinate.X' : `mathGeometry.kind.${quantity.kind}`);
    expect(t(key)).toBeTypeOf('string');
    expect(t(key).length).toBeGreaterThan(0);
    expect(mathGeometryTargetsSummary(documentWith(), quantity).length).toBeGreaterThan(0);
  });

  it.each(['X', 'Y', 'Z'] as const)('preserves the %s coordinate component when choosing a reselection', component => {
    const quantities: readonly MathGeometryQuantity[] = ['X', 'Y', 'Z'].map(axis => ({ ...QUANTITIES.coordinate,
      component: axis === 'X' ? 'X' : axis === 'Y' ? 'Y' : 'Z' }));
    expect(mathGeometryKindKey({ ...QUANTITIES.coordinate, component })).toBe(`mathGeometry.kind.coordinate.${component}`);
    expect(mathGeometryReselectCandidate({ ...QUANTITIES.coordinate, component }, quantities))
      .toEqual({ ...QUANTITIES.coordinate, component });
  });

  it.each([QUANTITIES.angle, QUANTITIES['plane-angle'], QUANTITIES['line-plane-angle'],
    QUANTITIES['point-angle'], QUANTITIES['central-angle']])('uses the model unit helper for $kind', quantity => {
    const radians = { ...quantity, unit: 'radian' } as const;
    expect(mathGeometryRows(stateFor(documentWith(radians)))[0].angleUnit).toBe('radian');
    expect(mathGeometryReselectCandidate(radians, [quantity])).toBeNull();
    expect(mathGeometryReselectCandidate(radians, [radians])).toBe(radians);
  });

  it('labels a selected vertex and edge as shortest distance with both targets', () => {
    const state = stateFor(documentWith(), [real()], { selection: [
      subShapeElementId('box', 'vertex', 0), subShapeElementId('box', 'edge', 0),
    ] });
    const [candidate] = mathGeometryCandidateRows(state);
    expect(candidate.kindLabel).toBe('最短距離');
    expect(candidate.targetsSummary).toBe('箱 (頂点 1) / 箱 (辺 1)');
    expect(mathGeometryAddReadiness(state).ready).toBe(true);
  });

  it('offers a coordinate-in-frame candidate when the selection pairs a point with a reference coordinate system (GR-22)', () => {
    const base = documentWith();
    const pointFeatureId = base.sketches[0]?.features[0]?.id ?? '';
    const document: PartDocument = { ...base, references: [{ kind: 'referenceCoordinateSystem', id: 'frame-1',
      name: '座標系1', visible: true, origin: { kind: 'point', pointId: pointFeatureId },
      xAxis: { kind: 'world', axis: 'x' }, yAxis: { kind: 'world', axis: 'y' } }] };
    const state = stateFor(document, [real()], { selection: [pointFeatureId, 'frame-1'] });
    const candidates = mathGeometryCandidateRows(state);
    expect(candidates.map(c => c.quantity.kind)).toEqual(['coordinate', 'coordinate', 'coordinate']);
    expect(candidates.every(c => c.quantity.kind === 'coordinate' && c.quantity.frame?.featureId === 'frame-1')).toBe(true);
    expect(candidates[0]?.targetsSummary).toContain('座標系1');
    expect(mathGeometryAddReadiness(state).ready).toBe(true);
  });

  it('does not offer coordinate-in-frame candidates for a plain sketch point selected alone (no frame in the selection)', () => {
    const base = documentWith();
    const pointFeatureId = base.sketches[0]?.features[0]?.id ?? '';
    const document: PartDocument = { ...base, references: [{ kind: 'referenceCoordinateSystem', id: 'frame-1',
      name: '座標系1', visible: true, origin: { kind: 'point', pointId: pointFeatureId },
      xAxis: { kind: 'world', axis: 'x' }, yAxis: { kind: 'world', axis: 'y' } }] };
    const state = stateFor(document, [real()], { selection: [pointFeatureId] });
    const candidates = mathGeometryCandidateRows(state);
    expect(candidates.every(c => c.quantity.kind === 'coordinate' && c.quantity.frame === undefined)).toBe(true);
  });

  it('reads renamed solid names and retains deleted target identities', () => {
    const document = documentWith();
    const renamed = { ...document, solids: document.solids.map(item => ({ ...item, name: '新しい箱' })) };
    expect(mathGeometryTargetsSummary(renamed, QUANTITIES.area)).toBe('新しい箱 (面 1)');
    expect(mathGeometryTargetsSummary({ ...document, solids: [] }, QUANTITIES.volume)).toBe('box (立体)');
  });

  it('reads sketch point names through the current document and keeps the point identity', () => {
    const document = documentWith();
    const sketch = document.sketches[0], feature = sketch.features[0];
    const quantity: MathGeometryQuantity = { kind: 'coordinate', component: 'Z', point: { kind: 'sketch-point',
      sketchId: sketch.id, reference: { kind: 'point', pointId: feature.id } } };
    expect(mathGeometryTargetsSummary(document, quantity)).toBe(`${sketch.name} / ${feature.name} (点: ${feature.id})`);
  });

  it.each(['original', 'renamed', 'missing'] as const)('includes the coordinate frame with its %s identity', status => {
    const quantity: MathGeometryQuantity = { ...QUANTITIES.coordinate, frame: { kind: 'reference', featureId: 'frame-1' } };
    const original = documentWith(quantity);
    const name = status === 'renamed' ? 'NewFrame' : 'Frame';
    const document: PartDocument = { ...original, references: status === 'missing' ? [] : [{
      kind: 'referenceCoordinateSystem', id: 'frame-1', name, visible: false, origin: POINT.reference,
      xAxis: { kind: 'world', axis: 'x' }, yAxis: { kind: 'world', axis: 'y' },
    }] };
    const pointText = mathGeometryTargetsSummary(document, QUANTITIES.coordinate);
    const expected = `${pointText} / ${status === 'missing' ? 'frame-1' : name} (座標系)`;
    expect(mathGeometryTargetsSummary(document, quantity)).toBe(expected);
    expect(mathGeometryRows(stateFor(document))[0].targetsSummary).toBe(expected);
  });

  it('enables reselection only when the selected quantity matches', () => {
    const selected = stateFor(documentWith(), [real()], { selection: ['box'] });
    expect(mathGeometryRows(selected)[0].reselect).toMatchObject({ ready: true, quantity: QUANTITIES.volume });
    expect(mathGeometryRows(stateFor())[0].reselect).toMatchObject({ ready: false,
      reasonKey: 'mathGeometry.disabled.reselectKind', quantity: null });
    expect(mathGeometryReselectCandidate(QUANTITIES.length, [QUANTITIES.volume])).toBeNull();
  });

  it('suppresses candidates and reselection while the selected shapes are stale', () => {
    const state = stateFor(documentWith(), [real()], { selection: ['box'], requestedGeneration: 8 });
    expect(mathGeometryCandidateRows(state)).toEqual([]);
    expect(mathGeometryAddReadiness(state).reasonKey).toBe('mathGeometry.disabled.computing');
    expect(mathGeometryRows(state)[0].reselect).toMatchObject({ ready: false,
      reasonKey: 'mathGeometry.disabled.computing', quantity: null });
  });
});

describe('usage, circularity and coefficient creation', () => {
  it('counts coefficients, configurations and unresolved problems and names all delete blockers', () => {
    const reference = storedReference();
    const document: PartDocument = { ...documentWith(), parameters: [
      { name: 'P', value: { ...expressionValueFromNumber(3), mathDefinition: reference }, unit: 'none', description: '' },
    ], configurations: [{ id: 'c', name: '構成A', values: {}, mathDefinitions: { P: reference, Q: reference } }],
    unresolvedMathProblems: [{ id: 'math-problem:p', name: '式A', status: 'unresolved', definition: reference }] };
    const row = mathGeometryRows(stateFor(document))[0];
    expect(row.usageCount).toBe(3);
    expect(row.usageText).toBe('3か所');
    expect(row.usageNames).toEqual(['P', '構成A', '式A']);
    expect(row.remove).toEqual({ ready: false, reasonKey: 'mathGeometry.error.referencedBy',
      reasonText: 'この測定値は P / 構成A / 式A で使われています。先にそちらを直してください。' });
  });

  it('derives the circular badge and reason from the actual model dependency analysis', () => {
    const original = documentWith();
    const document: PartDocument = { ...original,
      parameters: [{ name: 'P', mathId: 'coefficient:1', value: { ...expressionValueFromNumber(3), mathDefinition: storedReference() },
        unit: 'mm', description: '' }],
      solids: [{ ...extrudeFeature('box'), name: '箱', distance: { source: 'P', value: 3, display: '3' } }],
    };
    const row = mathGeometryRows(stateFor(document, [], { requestedGeneration: 8 }))[0];
    expect(row.circular).toBe(true);
    expect(row.cycleText).toBe('循環');
    expect(row.cycleMessage).toBe('係数「P」は図形の測定値「V」を使っていますが、その測る形「箱」が「P」を使って作られているため循環しています。');
    expect(row.remove.ready).toBe(false);
    expect(row.createParameter.ready).toBe(false);
  });

  it.each(['parameter', 'geometry'] as const)('rejects a coefficient name already used by a %s', kind => {
    const document = documentWith();
    const existingName = `V${t('mathGeometry.createParameter.nameSuffix')}`;
    const collision: PartDocument = kind === 'parameter'
      ? { ...document, parameters: [{ name: existingName, value: expressionValueFromNumber(1), unit: 'none', description: '' }] }
      : { ...document, mathGeometry: [...document.mathGeometry ?? [], { id: 'other', documentId: document.id,
        name: existingName, quantity: QUANTITIES.volume, tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE }] };
    expect(mathGeometryRows(stateFor(collision))[0].createParameter.reasonKey)
      .toBe('mathGeometry.createParameter.disabled.duplicateName');
  });

  it('explains an invalid generated coefficient name', () => {
    expect(mathGeometryRows(stateFor(documentWith(QUANTITIES.volume, '1invalid')))[0].createParameter.reasonKey)
      .toBe('mathGeometry.createParameter.disabled.invalidName');
  });

  it('agrees with GR-31 for a valid 128-character measurement name plus the coefficient suffix', () => {
    const state = stateFor(documentWith(QUANTITIES.volume, 'A'.repeat(128)));
    const published: PartDocument[] = [];
    const result = createParameterFromMathGeometryCommand({ ...state, applyDocument: document => { published.push(document); } },
      state.document, 'g');
    expect(result.ok).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0].parameters[0].name).toBe(`${'A'.repeat(128)}の値`);
    expect(mathGeometryRows(state)[0].createParameter.ready).toBe(result.ok);
  });

  it('leaves the supplied document, result and selection unchanged', () => {
    const state = stateFor(documentWith(), [real()], { selection: ['box'] });
    const before = structuredClone(state);
    mathGeometryRows(state);
    mathGeometryCandidateRows(state);
    mathGeometryAddReadiness(state);
    expect(state).toEqual(before);
  });
});

describe('panel visibility and shared guide text', () => {
  it('shows the panel only for an active math geometry tool in a part', () => {
    const state = stateFor();
    expect(mathGeometryPanelVisible(state)).toBe(true);
    expect(mathGeometryPanelVisible({ ...state, activeTool: 'select' })).toBe(false);
    expect(mathGeometryPanelVisible({ ...state, assembly: createAssemblyDocument('assembly') })).toBe(false);
    expect(mathGeometryPanelVisible({ ...state, drawing: createDrawingDocument('drawing', DRAWING_SOURCE) })).toBe(false);
  });

  it('does not return rows or candidates for a hidden part behind an assembly/drawing', () => {
    for (const override of [{ assembly: createAssemblyDocument('assembly') },
      { drawing: createDrawingDocument('drawing', DRAWING_SOURCE) }]) {
      const state = stateFor(documentWith(), [real()], override);
      expect(mathGeometryRows(state)).toEqual([]);
      expect(mathGeometryCandidateRows(state)).toEqual([]);
      expect(mathGeometryAddReadiness(state).reasonKey).toBe('mathGeometry.disabled.notPart');
      expect(mathGeometryPanelGuideText(state)).toBeNull();
    }
  });

  it.each([[], ['box'], ['unknown'], ['a', 'b', 'c', 'd']].map(selection => ({ selection })))('returns the same primitive guide text as GR-26 for $selection', ({ selection }) => {
    const state = stateFor(documentWith(), [real()], { selection });
    const guide = mathGeometryToolGuide(state);
    if (guide === null) throw new Error('Expected an active guide');
    expect(mathGeometryPanelGuideText(state)).toBe(mathGeometryToolGuideText(guide));
    expect(mathGeometryPanelGuideText(state)).toBe(mathGeometryPanelGuideText(state));
  });

  it.each([
    [[], 'nothingSelected'], [['unknown'], 'unsupportedPair'], [['a', 'b', 'c', 'd'], 'tooMany'],
  ] as const)('returns the add refusal for selection %j', (selection, reason) => {
    expect(mathGeometryAddReadiness(stateFor(documentWith(), [], { selection }))).toEqual({ ready: false,
      reasonKey: `mathGeometry.disabled.${reason}`, reasonText: t(`mathGeometry.disabled.${reason}`) });
  });

  it('returns no guide for other tools and no rows for an empty definitions list', () => {
    expect(mathGeometryPanelGuideText({ ...stateFor(), activeTool: 'select' })).toBeNull();
    expect(mathGeometryRows(stateFor({ ...documentWith(), mathGeometry: [] }, []))).toEqual([]);
  });
});
