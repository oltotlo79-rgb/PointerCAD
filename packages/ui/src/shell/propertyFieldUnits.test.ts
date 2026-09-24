/**
 * 旧式の欄の値の古さ対策(ADD-23、計画書 geomref-plan.md §4(c)・§5.2 GR-20)。
 *
 * 図形由来の係数(図形の測定値を直接、または他の係数を経由して使う係数)の値は、形を計算し直す
 * たびに変わる。旧式の欄の表示(`useFieldUnits` → `evaluateFieldSource`)が、ストアの変数表に
 * 残った「いまの形の値ではない値」を出さないことを確かめる。
 *
 * 再計算は偽物(`createFakeRecompute`)を本物の `attachPartRecompute` へつなぎ、結果の解析
 * (`parameterAnalysis`。GR-04 の `evaluateDocumentMath` と同じく、図形由来の係数に
 * `geometryDerived` の印を付けた形)を製品と同じ `applyRecompute` の経路で反映する。
 * `useFieldUnits` はサーバー描画で呼び、ブラウザーの購読と同じ選択関数を通す。
 */
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expressionValueFromNumber, type ExpressionResult, type ExpressionValue } from '@pointercad/expression';
import { MATH_INPUT_FORMAT, type StoredMathExpression } from '@pointercad/expression/math/contracts';
import {
  appendSolid,
  type MathGeometryDefinition,
  type Parameter,
  type ParameterAnalysis,
  type PartDocument,
  type PartRecomputeResult,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/t.js';
import { currentMathGeometry } from '../math/mathGeometryResults.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import {
  createFakeRecompute,
  extrudeFeature,
  partWithPoint,
  type PendingRecompute,
  resetTestStore,
  resultFor,
  tick,
} from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  evaluateFieldSource,
  type FieldUnits,
  pendingFieldVariables,
  type PendingFieldError,
  referencesPendingVariable,
  useFieldUnits,
} from './propertyFieldUnits.js';

const TOLERANCE = { linearMm: 1e-6, angularRadians: 1e-6 } as const;
const GEOMETRY_ID = 'geometry-1';

/** 立体 1 つの体積を測る定義(文書ID は既定の `part-1`)。 */
const VOLUME: MathGeometryDefinition = {
  id: GEOMETRY_ID,
  documentId: 'part-1',
  name: '体積1',
  quantity: { kind: 'volume', body: { kind: 'body', featureId: 'extrude-1' } },
  tolerance: TOLERANCE,
};

/**
 * 係数の数式 `coef("体積1")`。図形の測定値の参照は GR-01 の保存形(`math-geometry:` ＋定義ID の
 * 係数参照)。数式の係数なので、文書の変更のたびに作り直す解析(`analyzeParameters`)は値を持たない。
 */
function measuredCoefficient(): ExpressionValue {
  const definition: StoredMathExpression = {
    format: MATH_INPUT_FORMAT,
    source: 'coef("体積1")',
    inputNotation: 'text',
    angleUnit: 'degree',
    expression: { kind: 'symbol', reference: { role: 'coefficient', id: `math-geometry:${GEOMETRY_ID}`, label: '体積1' } },
  };
  return { source: definition.source, value: 0, display: '0', mathDefinition: definition };
}

function parameter(name: string, value: ExpressionValue): Parameter {
  return { name, value, unit: 'mm', description: '' };
}

/** P は図形由来(直接)、Q は P を使うので図形由来(経由)、R は図形と無関係。 */
function parameters(): readonly Parameter[] {
  return [
    parameter('P', measuredCoefficient()),
    parameter('Q', { ...expressionValueFromNumber(0), source: 'P + 1' }),
    parameter('R', expressionValueFromNumber(5)),
  ];
}

/** 押し出し(と追加の段)・係数 P/Q/R・図形の測定値「体積1」を持つ部品。 */
function partWithDerived(extraSolids: readonly string[] = []): PartDocument {
  let document = appendSolid(partWithPoint(), extrudeFeature('extrude-1'));
  for (const id of extraSolids) {
    document = appendSolid(document, extrudeFeature(id));
  }
  return { ...document, parameters: parameters(), mathGeometry: [VOLUME] };
}

/** 再計算の数式評価(GR-04)が返す解析と同じ形。体積が `volume` の形で計算した係数の値。 */
function analysisFor(volume: number): ParameterAnalysis {
  return {
    variables: new Map([['P', volume], ['Q', volume + 1], ['R', 5]]),
    exactVariables: new Map([['P', String(volume)], ['Q', String(volume + 1)], ['R', '5']]),
    nonLengthVariables: new Set<string>(),
    circular: [],
    unused: [],
    failures: [],
    geometryDerived: new Map([['P', [GEOMETRY_ID]], ['Q', [GEOMETRY_ID]]]),
  };
}

/** 体積 `volume` を測り、その値で係数を計算し終えた結果(呼ばれた文書・世代のもの)。 */
function measured(call: PendingRecompute, volume: number): PartRecomputeResult {
  const generation = call.options.generation ?? 0;
  return {
    ...resultFor(call.document),
    generation,
    mathGeometry: [{
      id: GEOMETRY_ID,
      documentId: call.document.id,
      generation,
      status: 'value',
      kind: 'real',
      value: volume,
      unit: 'mm3',
      representation: 'geometry-double',
      tolerance: TOLERANCE,
    }],
    parameterAnalysis: analysisFor(volume),
  };
}

const detachers: (() => void)[] = [];

function attachFake(): ReturnType<typeof createFakeRecompute> {
  const fake = createFakeRecompute();
  detachers.push(attachPartRecompute(fake.recompute));
  return fake;
}

/** 部品を開き、最初の計算(世代1、体積24000)を終えた状態にする。 */
async function openedPart(extraSolids: readonly string[] = []): Promise<ReturnType<typeof createFakeRecompute>> {
  useAppStore.getState().resetDocument(partWithDerived(extraSolids));
  const fake = attachFake();
  fake.calls[0].settle(measured(fake.calls[0], 24000));
  await tick();
  expect(statusNow()).toBe('current');
  return fake;
}

/** 履歴の途中(最初の段まで)を表示し、切った文書を体積11111で計算し終えた状態にする。 */
async function slicedAt11111(fake: ReturnType<typeof createFakeRecompute>): Promise<void> {
  useAppStore.getState().setTimelineIndex(0);
  const sliced = fake.calls[fake.calls.length - 1];
  expect(sliced.document).not.toBe(useAppStore.getState().document);
  sliced.settle(measured(sliced, 11111));
  await tick();
  // 切った文書の計算の解析も、同じ係数の配列なのでストアの変数表に入る(古い値の源)。
  expect(useAppStore.getState().parameterAnalysis.variables.get('P')).toBe(11111);
}

function statusNow(): string {
  return currentMathGeometry(useAppStore.getState()).status;
}

/** いまのストアで `useFieldUnits` を呼んだ結果(サーバー描画。購読は選択関数の値をそのまま返す)。 */
function unitsNow(): FieldUnits {
  const captured: { units?: FieldUnits } = {};
  function Probe(): null {
    captured.units = useFieldUnits();
    return null;
  }
  const snapshot = vi.spyOn(React, 'useSyncExternalStore')
    .mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try {
    renderToStaticMarkup(createElement(Probe));
  } finally {
    snapshot.mockRestore();
  }
  if (captured.units === undefined) {
    throw new Error('useFieldUnits が呼ばれませんでした');
  }
  return captured.units;
}

/** 保存されている式(打っている最中でない)の欄 1 つを、いまのストアの材料で評価する。 */
function fieldNow(source: string): ExpressionResult {
  return evaluateFieldSource(source, 'mm', false, unitsNow());
}

function valueOf(result: ExpressionResult): number | null {
  return result.ok ? result.value.value : null;
}

/** 計算待ちの係数を使う欄が返す結果(欄の下の 1 行に「計算中」と出る)。 */
function pendingResult(): { readonly ok: false; readonly error: PendingFieldError } {
  return { ok: false, error: { code: 'unknownVariable', message: t('mathGeometry.status.pending'), position: -1, pending: true } };
}

beforeEach(() => {
  resetTestStore();
  // 世代は文書の作り直しでも戻らない欄なので、検査の間で持ち越さないよう明示的に戻す。
  useAppStore.setState({ requestedGeneration: 0, completedGeneration: 0, lastOutcome: 'idle' });
});

afterEach(() => {
  for (const detach of detachers.splice(0)) {
    detach();
  }
});

describe('旧式の欄の値の古さ対策(GR-20)', () => {
  it('図形由来の係数を持たない文書では、計算中でも履歴の途中でも従来どおり評価する', async () => {
    const document = appendSolid(appendSolid(partWithPoint(), extrudeFeature('extrude-1')), extrudeFeature('extrude-2'));
    useAppStore.getState().resetDocument({ ...document, parameters: [parameter('R', expressionValueFromNumber(5))] });
    const fake = attachFake();
    expect(statusNow()).toBe('computing');
    expect(unitsNow().pendingVariables.size).toBe(0);
    expect(valueOf(fieldNow('R * 2'))).toBe(10);

    fake.calls[0].settle({ ...resultFor(fake.calls[0].document), generation: 1 });
    await tick();
    useAppStore.getState().setTimelineIndex(0);
    expect(statusNow()).toBe('timeline');
    expect(pendingFieldVariables(useAppStore.getState()).size).toBe(0);
    expect(valueOf(fieldNow('R * 2'))).toBe(10);
  });

  it('形の計算が終わった現在の値は、図形由来の係数とそれを使う係数の欄にそのまま出す', async () => {
    await openedPart();
    const units = unitsNow();
    expect(units.pendingVariables.size).toBe(0);
    expect(valueOf(fieldNow('P * 2'))).toBe(48000);
    expect(valueOf(fieldNow('Q'))).toBe(24001);
    expect(valueOf(fieldNow('R + 1'))).toBe(6);
  });

  it('履歴の途中を表示している間は、途中の形で計算した値を出さず「計算中」を返す', async () => {
    const fake = await openedPart(['extrude-2']);
    await slicedAt11111(fake);
    expect(statusNow()).toBe('timeline');
    expect([...unitsNow().pendingVariables].sort()).toEqual(['P', 'Q']);
    expect(fieldNow('P * 2')).toEqual(pendingResult());
    // P を経由して図形を使う係数 Q も、同じく値を出さない。
    expect(fieldNow('Q + 1')).toEqual(pendingResult());
    // 図形と無関係な係数だけの式は、途中表示の間も評価する。
    expect(valueOf(fieldNow('R * 2'))).toBe(10);
  });

  it('つまみを末尾へ戻した後の計算中は前の値を出さず、その世代が終わると新しい値を出す', async () => {
    const fake = await openedPart(['extrude-2']);
    await slicedAt11111(fake);
    useAppStore.getState().setTimelineIndex(null);
    expect(statusNow()).toBe('computing');
    // 変数表には切った文書の値が残っているが、欄には出さない。
    expect(unitsNow().variables.get('P')).toBe(11111);
    expect(fieldNow('P * 2')).toEqual(pendingResult());

    const last = fake.calls[fake.calls.length - 1];
    expect(last.document).toBe(useAppStore.getState().document);
    last.settle(measured(last, 30000));
    await tick();
    expect(statusNow()).toBe('current');
    expect(unitsNow().pendingVariables.size).toBe(0);
    expect(valueOf(fieldNow('P * 2'))).toBe(60000);
  });

  it('計算を中止した後も、形を作れず測れなかった後も、変数表に残る値を出さない', async () => {
    const fake = await openedPart(['extrude-2']);
    await slicedAt11111(fake);
    useAppStore.getState().setTimelineIndex(null);
    useAppStore.getState().cancelRecompute();
    const cancelled = fake.calls[fake.calls.length - 1];
    cancelled.settle({ ...resultFor(cancelled.document), generation: cancelled.options.generation ?? 0, cancelled: true });
    await tick();
    expect(statusNow()).toBe('cancelled');
    expect(unitsNow().variables.get('P')).toBe(11111);
    expect(fieldNow('P * 2')).toEqual(pendingResult());

    // もう一度途中を表示してから末尾へ戻し、その計算では形を作れず測れなかった(数式の解析も付かない)。
    useAppStore.getState().setTimelineIndex(0);
    const sliced = fake.calls[fake.calls.length - 1];
    sliced.settle(measured(sliced, 11111));
    await tick();
    useAppStore.getState().setTimelineIndex(null);
    const failed = fake.calls[fake.calls.length - 1];
    failed.settle({
      ...resultFor(failed.document),
      generation: failed.options.generation ?? 0,
      errors: [{ featureId: 'extrude-1', code: 'kernelFailed', message: '立体を作れませんでした' }],
    });
    await tick();
    expect(statusNow()).toBe('notEvaluated');
    expect(unitsNow().variables.get('P')).toBe(11111);
    expect(fieldNow('P * 2')).toEqual(pendingResult());
  });

  it('形を変えた直後も計算中を出す（統括承認: 解析の印が消えても定義から由来を判定するため）', async () => {
    const fake = await openedPart();
    const document = useAppStore.getState().document;
    useAppStore.getState().applyDocument(appendSolid(document, extrudeFeature('extrude-2')));
    expect(statusNow()).toBe('computing');
    const units = unitsNow();
    expect(units.variables.has('P')).toBe(false);
    expect(units.variables.has('Q')).toBe(false);
    expect(fieldNow('P * 2')).toEqual(pendingResult());
    expect(fieldNow('Q + 1')).toEqual(pendingResult());
    expect(pendingFieldVariables(useAppStore.getState())).toBe(pendingFieldVariables({ ...useAppStore.getState() }));
    expect(valueOf(fieldNow('R * 2'))).toBe(10);

    fake.calls[1].settle(measured(fake.calls[1], 30000));
    await tick();
    expect(valueOf(fieldNow('P * 2'))).toBe(60000);
  });

  it('計算待ちの名前を含む式だけを止め、構文の誤りは理由をそのまま出す', () => {
    const pending: ReadonlySet<string> = new Set(['P']);
    expect(referencesPendingVariable('P * 2', pending)).toBe(true);
    // 単位の中の名前も数える(inch で打った式は `(P*2)in` の形で保存される)。
    expect(referencesPendingVariable('(P*2)in', pending)).toBe(true);
    // 字句で比べるので、名前の一部が一致するだけの別の名前は止めない。
    expect(referencesPendingVariable('Pa * 2', pending)).toBe(false);
    expect(referencesPendingVariable('P * 2', new Set<string>())).toBe(false);
    // 読めない式は参照なしとし、評価の誤りの理由を出させる。
    expect(referencesPendingVariable('P *', pending)).toBe(false);

    const units: FieldUnits = {
      variables: new Map([['P', 1], ['Pa', 3]]),
      exactVariables: new Map<string, string>(),
      nonLengthVariables: new Set<string>(),
      lengthUnit: 'mm',
      pendingVariables: pending,
    };
    expect(evaluateFieldSource('P + 未知', 'mm', false, units)).toEqual(pendingResult());
    expect(valueOf(evaluateFieldSource('Pa * 2', 'mm', false, units))).toBe(6);
    const broken = evaluateFieldSource('P *', 'mm', false, units);
    expect(broken.ok).toBe(false);
    expect(broken.ok ? null : broken.error.code).toBe('unexpectedEnd');
  });

  it('打っている最中の式を表示の単位(inch)で包んでも、計算待ちの名前を見つける', () => {
    const units: FieldUnits = {
      variables: new Map([['P', 1]]),
      exactVariables: new Map<string, string>(),
      nonLengthVariables: new Set<string>(),
      lengthUnit: 'inch',
      pendingVariables: new Set(['P']),
    };
    expect(evaluateFieldSource('P * 2', 'mm', true, units)).toEqual(pendingResult());
    // 名前を使わない打ち込みは今までどおり inch で読む(2in = 50.8mm)。
    expect(valueOf(evaluateFieldSource('2', 'mm', true, units))).toBe(50.8);
    // 角度の欄は包まないが、名前は同じく見つける。
    expect(evaluateFieldSource('P', 'degree', true, units)).toEqual(pendingResult());
  });

  it('同じ状態には同じ集合を返し、useFieldUnits もその集合を渡す(選択関数から呼べる)', async () => {
    const fake = await openedPart(['extrude-2']);
    const currentState = useAppStore.getState();
    expect(pendingFieldVariables(currentState)).toBe(pendingFieldVariables({ ...currentState }));

    await slicedAt11111(fake);
    const state = useAppStore.getState();
    const pending = pendingFieldVariables(state);
    expect([...pending].sort()).toEqual(['P', 'Q']);
    expect(pendingFieldVariables(state)).toBe(pending);
    expect(pendingFieldVariables({ ...state })).toBe(pending);
    expect(unitsNow().pendingVariables).toBe(pending);
  });
});

describe('GR-20b 定義からの由来の判定', () => {
  it('同じ識別番号に異なる名前がある式では、現在の解析の印へ戻って古い値を出さない', () => {
    const value = measuredCoefficient();
    if (value.mathDefinition === undefined) throw new Error('Expected a math definition');
    const broken: ExpressionValue = { ...value, mathDefinition: { ...value.mathDefinition,
      expression: { kind: 'operation', operation: 'add', operands: [
        value.mathDefinition.expression,
        { kind: 'symbol', reference: { role: 'coefficient', id: `math-geometry:${GEOMETRY_ID}`, label: '別名' } },
      ] } } };
    const state = { ...useAppStore.getState(), document: { ...partWithDerived(), parameters: [parameter('P', broken)] },
      parameterAnalysis: analysisFor(123), mathGeometryResult: null };
    const pending = pendingFieldVariables(state);
    expect([...pending]).toEqual(['P', 'Q']);
    expect(pendingFieldVariables({ ...state })).toBe(pending);
    expect(evaluateFieldSource('P', 'mm', false, { ...unitsNow(), ...state.parameterAnalysis, pendingVariables: pending })).toEqual(pendingResult());
  });
});
