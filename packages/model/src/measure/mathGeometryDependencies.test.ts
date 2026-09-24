import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { MATH_INPUT_FORMAT, type MathNode, type StoredMathExpression } from '@pointercad/expression/math/contracts';

import { FUNCTION_DEFINITION_FORMAT, type FunctionDefinition } from '../functionGeometry/functionDefinitionTypes.js';
import type { FunctionSurfaceFeature } from '../functionGeometry/functionSurfaceFeature.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { Parameter } from '../parameters/types.js';
import type { Configuration } from '../part/configurations.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../part/createPartDocument.js';
import type { ExtrudeFeature, PartDocument, ReferenceCoordinateSystemFeature, ReferenceFeature } from '../part/types.js';
import { DEFAULT_FACE_COLOR } from '../sketch/createSketchDocument.js';
import { FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type {
  CoordinateInput,
  SketchDocument,
  SketchFaceFeature,
  SketchFeature,
  SketchFunctionCurveFeature,
  SketchLineFeature,
  SketchPointFeature,
} from '../sketch/types.js';
import {
  MATH_GEOMETRY_MAX_STAGES,
  analyzeMathGeometryDependencies,
  mathGeometryCycleMessage,
  mathGeometryHistoryEdges,
  mathGeometryOrderMessage,
  mathGeometryTooDeepMessage,
} from './mathGeometryDependencies.js';
import { DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId } from './mathGeometryIdentity.js';
import type { MathGeometryDefinition } from './mathGeometryTypes.js';

// ---------------------------------------------------------------------------
// 文書の組み立て。数学の計算部も OCCT も使わない(依存解析は式と参照だけを見る純関数)。
// ---------------------------------------------------------------------------

const ev = expressionValueFromNumber;

/** 係数を名前で使う旧式の欄の式(形の寸法欄は係数を名前で使う)。 */
function named(source: string, value = 10): ExpressionValue {
  return { source, value, display: String(value) };
}
function numberNode(decimal: string): MathNode {
  return { kind: 'number', decimal };
}
function coefficientNode(id: string, label: string): MathNode {
  return { kind: 'symbol', reference: { role: 'coefficient', id, label } };
}
/** 係数の式の中の `coef("名前")`(図形の測定値)。 */
function geometryNode(definitionId: string, label: string): MathNode {
  return coefficientNode(mathGeometryCoefficientId(definitionId), label);
}
function operation(name: string, ...operands: readonly MathNode[]): MathNode {
  return { kind: 'operation', operation: name, operands };
}
function stored(expression: MathNode, source: string): StoredMathExpression {
  return { format: MATH_INPUT_FORMAT, source, inputNotation: 'text', angleUnit: 'degree', expression };
}
/** 数式(`coef` 参照)で書いた係数。 */
function mathParameter(name: string, serial: number, expression: MathNode): Parameter {
  const source = `${name}の式`;
  return { name, mathId: `coefficient:${String(serial)}`, unit: 'mm', description: '',
    value: { source, value: 1, display: '1', mathDefinition: stored(expression, source) } };
}
/** 旧式(名前で参照)の係数。 */
function legacyParameter(name: string, source: string): Parameter {
  return { name, unit: 'mm', description: '', value: named(source) };
}
function definition(id: string, name: string, quantity: MathGeometryDefinition['quantity']): MathGeometryDefinition {
  return { id, documentId: 'part-1', name, quantity, tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}
function volumeOf(id: string, name: string, featureId: string): MathGeometryDefinition {
  return definition(id, name, { kind: 'volume', body: { kind: 'body', featureId } });
}
function edgeLengthOf(id: string, name: string, bodyFeatureId: string): MathGeometryDefinition {
  return definition(id, name, { kind: 'length', curve: { kind: 'edge', reference: { bodyFeatureId, index: 0,
    fingerprint: { kind: 'edge', curveKind: 'line', length: 20, position: [10, 0, 0], axis: [1, 0, 0], radius: null } } } });
}
function sketchLineLengthOf(id: string, name: string, sketchId: string, featureId: string): MathGeometryDefinition {
  return definition(id, name, { kind: 'length', curve: { kind: 'sketch-curve', sketchId, featureId } });
}
/** 箱(基本形状)を履歴の末尾へ足す。id・名前は `box-N`・`箱N`。 */
function appendBox(document: PartDocument, sizeX: ExpressionValue = ev(20), sizeY: ExpressionValue = ev(30),
  sizeZ: ExpressionValue = ev(40), suppressed = false): PartDocument {
  const feature = createPrimitiveFeature(document, 'box');
  return appendSolid(document, { ...feature, suppressed, shape: { kind: 'box', sizeX, sizeY, sizeZ } });
}
function coordinate(x: ExpressionValue, y: ExpressionValue = ev(0), z: ExpressionValue = ev(0)): CoordinateInput {
  return { mode: 'absolute', x, y, z };
}
function point(id: string, at: CoordinateInput, planeId = 'xy'): SketchPointFeature {
  return { id, name: id, planeId, kind: 'point', at };
}
function line(id: string, from: CoordinateInput, to: CoordinateInput, planeId = 'xy'): SketchLineFeature {
  return { id, name: id, planeId, kind: 'line', from, to, construction: false };
}
function face(id: string, boundary: readonly string[], planeId = 'xy'): SketchFaceFeature {
  return { id, name: id, planeId, kind: 'face', boundary: boundary.map(featureId => ({ featureId })), color: DEFAULT_FACE_COLOR };
}
function sketch(id: string, name: string, features: readonly SketchFeature[]): SketchDocument {
  return { id, name, features };
}
/** 3 点と面 1 つの輪郭(押し出しの元)。 */
function triangle(prefix: string, faceId: string, first: CoordinateInput, planeId = 'xy'): readonly SketchFeature[] {
  return [point(`${prefix}1`, first, planeId), point(`${prefix}2`, coordinate(ev(10)), planeId),
    point(`${prefix}3`, coordinate(ev(0), ev(10)), planeId), face(faceId, [`${prefix}1`, `${prefix}2`, `${prefix}3`], planeId)];
}
function extrude(id: string, name: string, sketchId: string, faceFeatureId: string): ExtrudeFeature {
  return { id, name, suppressed: false, kind: 'extrude', profile: { sketchId, faceFeatureId }, distance: ev(10),
    reversed: false, symmetric: false };
}
function workPlane(id: string, name: string, offset: ExpressionValue = ev(0)): ReferenceFeature {
  return { id, kind: 'referencePlane', name, visible: true, plane: { kind: 'workPlane', planeId: 'xy', offset } };
}
function functionDefinition(formula: FunctionDefinition['formula']): FunctionDefinition {
  const range = { min: ev(-1), max: ev(1) };
  return { format: FUNCTION_DEFINITION_FORMAT, bounds: { X: range, Y: range, Z: range }, tolerance: ev(0.01), formula };
}

/** 付録D: 箱1(20×30×40)と、横が係数「幅B」の箱2(奥行10・高さ10)、定義「箱1体積」。 */
function appendixD(widthB: Parameter): PartDocument {
  const withBox1 = appendBox(createEmptyPartDocument(), ev(20), ev(30), ev(40));
  const withBox2 = appendBox(withBox1, named('幅B', 24), ev(10), ev(10));
  return { ...withBox2, parameters: [widthB], mathGeometry: [volumeOf('g-box1', '箱1体積', 'box-1')] };
}
/** 付録D の 幅B = coef("箱1体積")/1000。 */
function widthFromVolume(): Parameter {
  return mathParameter('幅B', 1, operation('divide', geometryNode('g-box1', '箱1体積'), numberNode('1000')));
}

// ---------------------------------------------------------------------------

describe('付録C の理由の文(循環・順序・段数)', () => {
  it('計画書の文字列そのもの(全角括弧を含む)を組み立てる', () => {
    expect(mathGeometryCycleMessage('幅B', '箱1体積', '箱1'))
      .toBe('係数「幅B」は図形の測定値「箱1体積」を使っていますが、その測る形「箱1」が「幅B」を使って作られているため循環しています。');
    expect(mathGeometryOrderMessage('箱1', '箱2', '箱2体積', '幅B'))
      .toBe('「箱1」は、後ろにある「箱2」を測った値（図形の測定値「箱2体積」）を係数「幅B」から使っています。「箱2」より後ろへ移してください。');
    expect(mathGeometryTooDeepMessage()).toBe('図形の測定値を使う係数の連なりが上限（8段）を超えています。');
    expect(MATH_GEOMETRY_MAX_STAGES).toBe(8);
  });
});

describe('段(深さ0・1・2)', () => {
  it('深さ0: 定義はあっても係数が参照しなければ、図形由来の係数も途中の段も無い', () => {
    const empty = analyzeMathGeometryDependencies(createEmptyPartDocument());
    expect(empty.stageOf.size).toBe(0);
    expect(empty.stageCount).toBe(0);
    expect(empty.historyEdges.size).toBe(0);
    expect(empty.unreadable).toBeUndefined();

    const analysis = analyzeMathGeometryDependencies(appendixD(legacyParameter('幅B', '10')));
    expect(analysis.geometryDerived.size).toBe(0);
    expect(analysis.ownerGeometry.size).toBe(0);
    expect(analysis.targets).toEqual(new Map([['g-box1', new Set(['box-1'])]]));
    expect(analysis.stageOf).toEqual(new Map([['g-box1', 1]]));
    expect(analysis.stageCount).toBe(0);
    expect(analysis.usedDefinitionIds.size).toBe(0);
    expect(analysis.cycles).toEqual([]);
    expect(analysis.orderViolations).toEqual([]);
    expect(analysis.blocked.size).toBe(0);
    expect(analysis.historyEdges.size).toBe(0);
  });

  it('深さ1(付録D): 箱1を測って幅Bを決め、箱2を作る。段1で測り、箱2は箱1より後ろ', () => {
    const document = appendixD(widthFromVolume());
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.geometryDerived).toEqual(new Map([['幅B', new Set(['g-box1'])]]));
    expect(analysis.ownerGeometry).toEqual(new Map([['box-2', new Set(['g-box1'])]]));
    expect(analysis.targets).toEqual(new Map([['g-box1', new Set(['box-1'])]]));
    expect(analysis.stageOf).toEqual(new Map([['g-box1', 1]]));
    expect(analysis.stageCount).toBe(1);
    expect(analysis.usedDefinitionIds).toEqual(new Set(['g-box1']));
    expect(analysis.cycles).toEqual([]);
    expect(analysis.orderViolations).toEqual([]);
    expect(analysis.blocked.size).toBe(0);
    expect(analysis.historyEdges).toEqual(new Map([['box-2', ['box-1']]]));
    expect(mathGeometryHistoryEdges(document)).toEqual(analysis.historyEdges);
  });

  it('深さ2: 測った辺で箱2を作り、箱2を測って箱3を作る。係数だけの式(旧式の名前参照)も推移的に図形由来', () => {
    const base = appendBox(appendBox(appendBox(createEmptyPartDocument()), named('P', 40), ev(10), ev(10)), named('Q', 4), ev(10), ev(10));
    const document: PartDocument = { ...base,
      parameters: [
        mathParameter('P', 1, operation('multiply', geometryNode('g-edge', 'Aの辺'), numberNode('2'))),
        mathParameter('Q', 2, operation('divide', geometryNode('g-box2', '箱2体積'), numberNode('1000'))),
        legacyParameter('R', 'Q*2'),
      ],
      mathGeometry: [edgeLengthOf('g-edge', 'Aの辺', 'box-1'), volumeOf('g-box2', '箱2体積', 'box-2'),
        volumeOf('g-box3', '箱3体積', 'box-3')] };
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.stageOf).toEqual(new Map([['g-edge', 1], ['g-box2', 2], ['g-box3', 3]]));
    // 箱3体積は係数から使われないので、途中の段を増やさない(最後の段で測れば足りる)。
    expect(analysis.stageCount).toBe(2);
    expect(analysis.geometryDerived).toEqual(new Map([['P', new Set(['g-edge'])], ['Q', new Set(['g-box2'])], ['R', new Set(['g-box2'])]]));
    expect(analysis.ownerGeometry).toEqual(new Map([['box-2', new Set(['g-edge'])], ['box-3', new Set(['g-box2'])]]));
    expect(analysis.historyEdges).toEqual(new Map([['box-2', ['box-1']], ['box-3', ['box-2']]]));
    expect(analysis.cycles).toEqual([]);
    expect(analysis.blocked.size).toBe(0);
  });
});

describe('循環の検出(形を作る前に理由付きで止める)', () => {
  it('立体の寸法経由: 箱1の奥行きに幅Bを使うと、定義名・係数名・形の名前入りの文で循環を返す', () => {
    const base = appendBox(createEmptyPartDocument(), ev(20), named('幅B', 24), ev(40));
    const document: PartDocument = { ...base,
      parameters: [widthFromVolume(), mathParameter('表示用', 2, operation('multiply', geometryNode('g-box1', '箱1体積'), numberNode('1')))],
      mathGeometry: [volumeOf('g-box1', '箱1体積', 'box-1')] };
    const analysis = analyzeMathGeometryDependencies(document);
    const message = '係数「幅B」は図形の測定値「箱1体積」を使っていますが、その測る形「箱1」が「幅B」を使って作られているため循環しています。';
    expect(analysis.cycles).toEqual([{ definitionIds: ['g-box1'], coefficientNames: ['幅B'], shapeIds: ['box-1'], message }]);
    // 循環の途中にない係数も、循環の値を使うので古い値で計算させない。
    expect(analysis.blocked).toEqual(new Map([
      ['幅B', message],
      ['表示用', `図形の測定値「箱1体積」を測れないため、係数「表示用」を計算できません: ${message}`],
    ]));
    expect(analysis.stageOf.has('g-box1')).toBe(false);
    expect(analysis.stageCount).toBe(0);
    expect(analysis.orderViolations).toEqual([]);
    // 循環は並べ替えでは直せないので、並べ替えの辺にはしない(二重に断らない)。
    expect(analysis.historyEdges.size).toBe(0);
  });

  it('スケッチ経由: スケッチの点の座標に係数を使い、そのスケッチの押し出しを測ると循環', () => {
    const base = createEmptyPartDocument();
    const document: PartDocument = { ...base,
      sketches: [sketch('sketch-1', 'スケッチ1', triangle('p', 'face-1', coordinate(named('L', 30))))],
      solids: [extrude('extrude-1', '押し出し1', 'sketch-1', 'face-1')],
      parameters: [mathParameter('L', 1, operation('divide', geometryNode('g-volume', '押し出し体積'), numberNode('100')))],
      mathGeometry: [volumeOf('g-volume', '押し出し体積', 'extrude-1')] };
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.ownerGeometry).toEqual(new Map([['p1', new Set(['g-volume'])]]));
    expect(analysis.cycles.map(cycle => cycle.message)).toEqual([
      '係数「L」は図形の測定値「押し出し体積」を使っていますが、その測る形「押し出し1」が「L」を使って作られているため循環しています。',
    ]);
    expect(analysis.cycles[0]?.shapeIds).toEqual(['extrude-1']);
  });

  it('スケッチを測る: 線の長さを測って同じスケッチの寸法に使うと、形の名前はスケッチの名前になる', () => {
    const base = createEmptyPartDocument();
    const document: PartDocument = { ...base,
      sketches: [sketch('sketch-1', 'スケッチ1', [line('line-1', coordinate(ev(0)), coordinate(named('L', 40)))])],
      parameters: [mathParameter('L', 1, operation('multiply', geometryNode('g-line', '線の長さ'), numberNode('2')))],
      mathGeometry: [sketchLineLengthOf('g-line', '線の長さ', 'sketch-1', 'line-1')] };
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.targets).toEqual(new Map([['g-line', new Set(['sketch-1'])]]));
    expect(analysis.cycles).toEqual([{ definitionIds: ['g-line'], coefficientNames: ['L'], shapeIds: ['sketch-1'],
      message: '係数「L」は図形の測定値「線の長さ」を使っていますが、その測る形「スケッチ1」が「L」を使って作られているため循環しています。' }]);
  });

  it('基準平面の距離経由: 作業平面の距離に係数を使い、その平面上のスケッチの押し出しを測ると循環', () => {
    const base = createEmptyPartDocument();
    const document: PartDocument = { ...base,
      references: [workPlane('referencePlane-1', '作業平面1', named('H', 5))],
      sketches: [sketch('sketch-1', 'スケッチ1', triangle('p', 'face-1', coordinate(ev(0)), 'referencePlane-1'))],
      solids: [extrude('extrude-1', '押し出し1', 'sketch-1', 'face-1')],
      parameters: [mathParameter('H', 1, operation('divide', geometryNode('g-volume', '押し出し体積'), numberNode('1000')))],
      mathGeometry: [volumeOf('g-volume', '押し出し体積', 'extrude-1')] };
    const analysis = analyzeMathGeometryDependencies(document);
    const message = '係数「H」は図形の測定値「押し出し体積」を使っていますが、その測る形「押し出し1」が「H」を使って作られているため循環しています。';
    expect(analysis.ownerGeometry).toEqual(new Map([['referencePlane-1', new Set(['g-volume'])]]));
    expect(analysis.cycles.map(cycle => cycle.message)).toEqual([message]);
    expect(analysis.blocked).toEqual(new Map([['H', message]]));
  });

  it('別のスケッチの点を基準にした点を通る循環も見つけ、解析は文書を書き換えない', () => {
    const base = createEmptyPartDocument();
    const relative = (dx: number, dy: number): CoordinateInput => ({ mode: 'relative', base: { kind: 'point', pointId: 'base-point' },
      dx: ev(dx), dy: ev(dy), dz: ev(0) });
    const document: PartDocument = { ...base,
      sketches: [
        sketch('sketch-1', 'スケッチ1', [point('base-point', coordinate(named('L', 5)))]),
        sketch('sketch-2', 'スケッチ2', [point('q1', relative(0, 0)), point('q2', relative(10, 0)), point('q3', relative(0, 10)),
          face('face-2', ['q1', 'q2', 'q3'])]),
      ],
      solids: [extrude('extrude-1', '押し出し1', 'sketch-2', 'face-2')],
      parameters: [mathParameter('L', 1, geometryNode('g-volume', '押し出し体積'))],
      mathGeometry: [volumeOf('g-volume', '押し出し体積', 'extrude-1')] };
    const before = JSON.stringify(document);
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.cycles.map(cycle => cycle.coefficientNames)).toEqual([['L']]);
    expect(analysis.blocked.get('L')).toBe(
      '係数「L」は図形の測定値「押し出し体積」を使っていますが、その測る形「押し出し1」が「L」を使って作られているため循環しています。');
    expect(JSON.stringify(document)).toBe(before);
  });

  it('基準平面が別のスケッチの点を通るときも、その点の係数から循環を見つける', () => {
    const base = createEmptyPartDocument();
    const plane: ReferenceFeature = { id: 'referencePlane-1', kind: 'referencePlane', name: '作業平面1', visible: true,
      plane: { kind: 'threePoints', p1: { kind: 'point', pointId: 'a' }, p2: { kind: 'point', pointId: 'b' }, p3: { kind: 'point', pointId: 'c' } } };
    const document: PartDocument = { ...base,
      references: [plane],
      sketches: [
        sketch('sketch-1', 'スケッチ1', [point('a', coordinate(named('L', 5))), point('b', coordinate(ev(10))), point('c', coordinate(ev(0), ev(10)))]),
        sketch('sketch-2', 'スケッチ2', triangle('q', 'face-2', coordinate(ev(0)), 'referencePlane-1')),
      ],
      solids: [extrude('extrude-1', '押し出し1', 'sketch-2', 'face-2')],
      parameters: [mathParameter('L', 1, geometryNode('g-volume', '押し出し体積'))],
      mathGeometry: [volumeOf('g-volume', '押し出し体積', 'extrude-1')] };
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.cycles).toHaveLength(1);
    expect(analysis.cycles[0]?.definitionIds).toEqual(['g-volume']);
    expect(analysis.stageOf.size).toBe(0);
  });

  it('2つの定義の循環と、その循環の値で作る形を測る定義(下流)を理由付きで止める', () => {
    const base = appendBox(appendBox(appendBox(createEmptyPartDocument(), named('P2', 1), ev(10), ev(10)),
      named('P1', 1), ev(10), ev(10)), named('P1', 1), ev(20), ev(10));
    const document: PartDocument = { ...base,
      parameters: [mathParameter('P1', 1, geometryNode('g1', 'V1')), mathParameter('P2', 2, geometryNode('g2', 'V2')),
        mathParameter('P3', 3, geometryNode('g3', 'V3'))],
      mathGeometry: [volumeOf('g1', 'V1', 'box-1'), volumeOf('g2', 'V2', 'box-2'), volumeOf('g3', 'V3', 'box-3')] };
    const analysis = analyzeMathGeometryDependencies(document);
    const p1 = '係数「P1」は図形の測定値「V1」を使っていますが、その測る形「箱1」が「P1」を使って作られているため循環しています。';
    const p2 = '係数「P2」は図形の測定値「V2」を使っていますが、その測る形「箱2」が「P2」を使って作られているため循環しています。';
    expect(analysis.cycles).toEqual([{ definitionIds: ['g1', 'g2'], coefficientNames: ['P1', 'P2'], shapeIds: ['box-1', 'box-2'], message: p2 }]);
    expect(analysis.blocked).toEqual(new Map([
      ['P1', p1],
      ['P2', p2],
      ['P3', `図形の測定値「V3」を測れないため、係数「P3」を計算できません: ${p2}`],
    ]));
    expect(analysis.stageOf.size).toBe(0);
    expect(analysis.stageCount).toBe(0);
    expect(analysis.historyEdges.size).toBe(0);
  });
});

describe('数えないもの・循環ではないもの', () => {
  it('選んでいない構成の式は数えない(選んだ構成の式だけが係数の表に写っている)', () => {
    const base = appendBox(createEmptyPartDocument(), ev(20), named('幅B', 10), ev(40));
    const other: Configuration = { id: 'configuration-2', name: '測定値から', values: { 幅B: '幅Bの式' },
      mathDefinitions: { 幅B: stored(operation('divide', geometryNode('g-box1', '箱1体積'), numberNode('1000')), '幅Bの式') } };
    const document: PartDocument = { ...base, parameters: [legacyParameter('幅B', '10')],
      configurations: [...base.configurations, other], mathGeometry: [volumeOf('g-box1', '箱1体積', 'box-1')] };
    expect(document.activeConfigurationId).not.toBe('configuration-2');
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.geometryDerived.size).toBe(0);
    expect(analysis.cycles).toEqual([]);
    expect(analysis.blocked.size).toBe(0);
    // 同じ式が選んだ構成として表に写れば数える(このときは循環)。
    const selected = analyzeMathGeometryDependencies({ ...document, parameters: [widthFromVolume()] });
    expect(selected.cycles.map(cycle => cycle.definitionIds)).toEqual([['g-box1']]);
  });

  it('参照先の形が無い定義は循環ではない(実行時に missing-reference で理由付きの失敗)', () => {
    const base = appendBox(createEmptyPartDocument(), named('幅B', 24), ev(10), ev(10));
    const document: PartDocument = { ...base,
      parameters: [mathParameter('幅B', 1, operation('divide', geometryNode('g-gone', '消えた体積'), numberNode('1000')))],
      mathGeometry: [volumeOf('g-gone', '消えた体積', 'extrude-deleted')] };
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.targets).toEqual(new Map([['g-gone', new Set()]]));
    expect(analysis.cycles).toEqual([]);
    expect(analysis.stageOf).toEqual(new Map([['g-gone', 1]]));
    expect(analysis.stageCount).toBe(1);
    expect(analysis.blocked.size).toBe(0);
    expect(analysis.orderViolations).toEqual([]);
    expect(analysis.historyEdges.size).toBe(0);
    expect(analysis.geometryDerived).toEqual(new Map([['幅B', new Set(['g-gone'])]]));
  });

  it('定義が無い参照は依存にしない(有効なら循環になる形でも循環にしない)が、由来は図形由来のまま', () => {
    const base = appendBox(createEmptyPartDocument(), ev(20), named('幅B', 24), ev(40));
    const document: PartDocument = { ...base,
      parameters: [mathParameter('幅B', 1, operation('divide', geometryNode('g-missing', '無い値'), numberNode('1000')))],
      mathGeometry: [volumeOf('g-box1', '箱1体積', 'box-1')] };
    const analysis = analyzeMathGeometryDependencies(document);
    // 由来としては図形由来のまま(厳密値や覚え書きへ戻さない)。参照そのものは評価が理由付きで断る。
    expect(analysis.geometryDerived).toEqual(new Map([['幅B', new Set(['g-missing'])]]));
    expect(analysis.usedDefinitionIds.size).toBe(0);
    expect(analysis.cycles).toEqual([]);
    expect(analysis.stageCount).toBe(0);
    expect(analysis.blocked.size).toBe(0);
    expect(analysis.historyEdges.size).toBe(0);
  });

  it('識別番号が重なる定義は1つに決まらないので依存にしない', () => {
    const base = appendBox(createEmptyPartDocument(), ev(20), named('幅B', 24), ev(40));
    const document: PartDocument = { ...base, parameters: [widthFromVolume()],
      mathGeometry: [volumeOf('g-box1', '箱1体積', 'box-1'), volumeOf('g-box1', '別の体積', 'box-1')] };
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.usedDefinitionIds.size).toBe(0);
    expect(analysis.cycles).toEqual([]);
    expect(analysis.blocked.size).toBe(0);
  });

  it('式の名前が定義の名前と違う参照(評価では断る)も、依存としては見落とさない側で数える', () => {
    const stale = mathParameter('幅B', 1, operation('divide', geometryNode('g-box1', '古い名前'), numberNode('1000')));
    const analysis = analyzeMathGeometryDependencies(appendixD(stale));
    expect(analysis.usedDefinitionIds).toEqual(new Set(['g-box1']));
    expect(analysis.stageCount).toBe(1);
    expect(analysis.historyEdges).toEqual(new Map([['box-2', ['box-1']]]));
  });

  it('同じ識別番号に2つの名前がある式は読めない理由を返し、例外を投げない', () => {
    const broken = mathParameter('幅B', 1, operation('add', geometryNode('g-box1', '箱1体積'), geometryNode('g-box1', '別名')));
    const analysis = analyzeMathGeometryDependencies(appendixD(broken));
    expect(analysis.unreadable).toBe('同じ係数の参照名が一致しません。');
    expect(analysis.geometryDerived.size).toBe(0);
    expect(analysis.cycles).toEqual([]);
    expect(analysis.historyEdges.size).toBe(0);
  });
});

describe('関数作図・未解決の式の係数', () => {
  it('関数曲面・関数曲線の式が図形由来の係数を使えば持ち主として数え、関数曲面は測る形より後ろ', () => {
    const base = appendBox(createEmptyPartDocument());
    const scale = coefficientNode('coefficient:1', '倍率');
    const surface: FunctionSurfaceFeature = { id: 'functionSurface-1', name: '関数曲面1', kind: 'functionSurface', suppressed: false,
      definition: functionDefinition({ kind: 'coordinate-surface', output: 'Z', expression: stored(operation('multiply', scale, numberNode('1')), 'coef("倍率")*1') }) };
    const curve: SketchFunctionCurveFeature = { id: 'function-curve', name: '関数曲線', kind: 'functionCurve', planeId: FREE_WORK_PLANE_ID,
      construction: false, definition: functionDefinition({ kind: 'coordinate-curve', independent: 'X',
        outputs: { Y: stored(scale, 'coef("倍率")'), Z: stored(numberNode('0'), '0') } }) };
    const document: PartDocument = { ...base,
      sketches: [{ ...base.sketches[0], features: [curve] }],
      solids: [...base.solids, surface],
      parameters: [mathParameter('倍率', 1, operation('divide', geometryNode('g-box1', '箱1体積'), numberNode('24000')))],
      mathGeometry: [volumeOf('g-box1', '箱1体積', 'box-1')] };
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.ownerGeometry).toEqual(new Map([['function-curve', new Set(['g-box1'])], ['functionSurface-1', new Set(['g-box1'])]]));
    expect(analysis.historyEdges).toEqual(new Map([['functionSurface-1', ['box-1']]]));
    expect(analysis.stageCount).toBe(1);
    expect(analysis.cycles).toEqual([]);
    expect(analysis.orderViolations).toEqual([]);
  });

  it('未解決の式も持ち主として数えるが、形を作らないので順序・循環には関わらない', () => {
    const document: PartDocument = { ...appendixD(widthFromVolume()),
      unresolvedMathProblems: [{ id: 'math-problem:1', name: '解けない式', status: 'unresolved',
        definition: stored(operation('add', coefficientNode('coefficient:1', '幅B'), numberNode('1')), 'coef("幅B")+1') }] };
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.ownerGeometry.get('math-problem:1')).toEqual(new Set(['g-box1']));
    expect(analysis.historyEdges).toEqual(new Map([['box-2', ['box-1']]]));
    expect(analysis.cycles).toEqual([]);
  });
});

describe('順序(Q7=O1: 測る形はその値を使う形より履歴の前)', () => {
  function usesBeforeMeasured(suppressed: boolean): PartDocument {
    const base = appendBox(appendBox(createEmptyPartDocument(), named('幅B', 24), ev(10), ev(10), suppressed), ev(20), ev(30), ev(40));
    return { ...base, parameters: [mathParameter('幅B', 1, operation('divide', geometryNode('g-box2', '箱2体積'), numberNode('1000')))],
      mathGeometry: [volumeOf('g-box2', '箱2体積', 'box-2')] };
  }

  it('使う形が測る形より前なら、形の名前・定義名・係数名入りの理由で順序違反', () => {
    const analysis = analyzeMathGeometryDependencies(usesBeforeMeasured(false));
    const message = '「箱1」は、後ろにある「箱2」を測った値（図形の測定値「箱2体積」）を係数「幅B」から使っています。「箱2」より後ろへ移してください。';
    expect(analysis.orderViolations).toEqual([{ featureId: 'box-1', targetFeatureId: 'box-2', definitionId: 'g-box2', coefficientName: '幅B', message }]);
    expect(analysis.blocked).toEqual(new Map([['幅B', message]]));
    expect(analysis.cycles).toEqual([]);
    expect(analysis.stageOf).toEqual(new Map([['g-box2', 1]]));
    // 並べ替えの辺はそのまま出す(箱1を箱2より後ろへ動かせば満たせる)。
    expect(analysis.historyEdges).toEqual(new Map([['box-1', ['box-2']]]));
  });

  it('抑制された形は作られないので順序違反に数えないが、並べ替えの辺には入れる', () => {
    const analysis = analyzeMathGeometryDependencies(usesBeforeMeasured(true));
    expect(analysis.orderViolations).toEqual([]);
    expect(analysis.blocked.size).toBe(0);
    expect(analysis.historyEdges).toEqual(new Map([['box-1', ['box-2']]]));
  });

  it('基準ジオメトリどうしでも順序を見る(作業平面2上のスケッチを測った値を、前の作業平面1が使う)', () => {
    const base = createEmptyPartDocument();
    const document: PartDocument = { ...base,
      references: [workPlane('referencePlane-1', '作業平面1', named('H', 5)), workPlane('referencePlane-2', '作業平面2', ev(10))],
      sketches: [sketch('sketch-1', 'スケッチ1', [line('line-1', coordinate(ev(0)), coordinate(ev(30)), 'referencePlane-2')])],
      parameters: [mathParameter('H', 1, geometryNode('g-line', '線の長さ'))],
      mathGeometry: [sketchLineLengthOf('g-line', '線の長さ', 'sketch-1', 'line-1')] };
    const analysis = analyzeMathGeometryDependencies(document);
    const message = '「作業平面1」は、後ろにある「作業平面2」を測った値（図形の測定値「線の長さ」）を係数「H」から使っています。「作業平面2」より後ろへ移してください。';
    expect(analysis.orderViolations.map(violation => violation.message)).toEqual([message]);
    expect(analysis.blocked).toEqual(new Map([['H', message]]));
    expect(analysis.historyEdges).toEqual(new Map([['referencePlane-1', ['referencePlane-2']]]));
  });

  it('立体を測った値を使う基準ジオメトリは(区間が違い並べ替えで直せないので)順序違反にも並べ替えの辺にもしない', () => {
    const base = appendBox(createEmptyPartDocument());
    const document: PartDocument = { ...base,
      references: [workPlane('referencePlane-1', '作業平面1', named('H', 5))],
      parameters: [mathParameter('H', 1, operation('divide', geometryNode('g-box1', '箱1体積'), numberNode('1000')))],
      mathGeometry: [volumeOf('g-box1', '箱1体積', 'box-1')] };
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.ownerGeometry).toEqual(new Map([['referencePlane-1', new Set(['g-box1'])]]));
    expect(analysis.orderViolations).toEqual([]);
    expect(analysis.blocked.size).toBe(0);
    expect(analysis.historyEdges.size).toBe(0);
    expect(analysis.stageCount).toBe(1);
    expect(analysis.cycles).toEqual([]);
  });

  it('スケッチを測るときは、そのスケッチが依存する後ろの形との順序を見る', () => {
    const base = appendBox(appendBox(createEmptyPartDocument(), named('L', 20), ev(10), ev(10)));
    const vertex: SubShapeRef = { bodyFeatureId: 'box-2', index: 0, fingerprint: { kind: 'vertex', position: [0, 0, 0] } };
    const from: CoordinateInput = { mode: 'relative', base: { kind: 'subShape', ref: vertex }, dx: ev(0), dy: ev(0), dz: ev(0) };
    const document: PartDocument = { ...base,
      sketches: [sketch('sketch-1', 'スケッチ1', [line('line-1', from, coordinate(ev(10)))])],
      parameters: [mathParameter('L', 1, geometryNode('g-line', '線の長さ'))],
      mathGeometry: [sketchLineLengthOf('g-line', '線の長さ', 'sketch-1', 'line-1')] };
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.targets).toEqual(new Map([['g-line', new Set(['sketch-1'])]]));
    expect(analysis.orderViolations.map(violation => violation.message)).toEqual([
      '「箱1」は、後ろにある「箱2」を測った値（図形の測定値「線の長さ」）を係数「L」から使っています。「箱2」より後ろへ移してください。',
    ]);
    expect(analysis.historyEdges).toEqual(new Map([['box-1', ['box-2']]]));
  });
});

describe('段数の上限(Q7=O1: 連なりは最大8段)', () => {
  it('9段目の測定値を使う係数だけを理由付きで止め、途中の段は8で打ち切る', () => {
    let document = appendBox(createEmptyPartDocument());
    const parameters: Parameter[] = [];
    const mathGeometry: MathGeometryDefinition[] = [];
    for (let stage = 1; stage <= 9; stage += 1) {
      mathGeometry.push(volumeOf(`g${String(stage)}`, `体積${String(stage)}`, `box-${String(stage)}`));
      parameters.push(mathParameter(`P${String(stage)}`, stage,
        operation('divide', geometryNode(`g${String(stage)}`, `体積${String(stage)}`), numberNode('1000'))));
      document = appendBox(document, named(`P${String(stage)}`, 1), ev(10), ev(10));
    }
    const analysis = analyzeMathGeometryDependencies({ ...document, parameters, mathGeometry });
    expect(analysis.stageOf.get('g8')).toBe(8);
    expect(analysis.stageOf.get('g9')).toBe(9);
    expect(analysis.tooDeep).toEqual(['g9']);
    expect(analysis.stageCount).toBe(8);
    expect(analysis.blocked).toEqual(new Map([['P9', '図形の測定値を使う係数の連なりが上限（8段）を超えています。']]));
    expect(analysis.cycles).toEqual([]);
  });
});


function frameDependencyPart(input: ExpressionValue = ev(1), via: 'origin' | 'xAxis' | 'yAxis' = 'origin'): PartDocument {
  const frame: ReferenceCoordinateSystemFeature = { kind: 'referenceCoordinateSystem', id: 'frame', name: '測定座標系', visible: false,
    origin: { kind: 'point', pointId: 'frame-origin' },
    xAxis: via === 'xAxis' ? { kind: 'reference', referenceFeatureId: 'frame-axis' } : { kind: 'world', axis: 'x' },
    yAxis: via === 'yAxis' ? { kind: 'reference', referenceFeatureId: 'frame-axis' } : { kind: 'world', axis: 'y' } };
  return { ...createEmptyPartDocument(), references: [
    { kind: 'referencePoint', id: 'frame-origin', name: '座標系の原点', visible: true,
      definition: { kind: 'coordinate', at: coordinate(via === 'origin' ? input : ev(1), ev(2), ev(3)) } },
    { kind: 'referencePoint', id: 'axis-end', name: '軸の終点', visible: true,
      definition: { kind: 'coordinate', at: coordinate(via === 'origin' ? ev(1) : input, ev(1)) } },
    { kind: 'referenceAxis', id: 'frame-axis', name: '座標系の軸', visible: true,
      definition: { kind: 'twoPoints', from: { kind: 'origin' }, to: { kind: 'point', pointId: 'axis-end' } } }, frame],
    sketches: [sketch('measured-sketch', '測る点', [point('measured-point', coordinate(ev(4), ev(6), ev(8)))])],
    mathGeometry: [definition('g-frame', '局所座標', { kind: 'coordinate', component: 'X',
      point: { kind: 'sketch-point', sketchId: 'measured-sketch', reference: { kind: 'point', pointId: 'measured-point' } },
      frame: { kind: 'reference', featureId: 'frame' } })] };
}

describe('GR-10b 座標系を経由する図形の依存', () => {
  it('係数が未使用でも点のスケッチと非表示の座標系を対象に含める', () => {
    const analysis = analyzeMathGeometryDependencies(frameDependencyPart());
    expect(analysis.targets).toEqual(new Map([['g-frame', new Set(['measured-sketch', 'frame'])]]));
    expect(analysis.stageOf.get('g-frame')).toBe(1);
    expect(analysis.stageCount).toBe(0);
  });

  it.each(['gone', 'frame-origin', 'frame-axis', 'box-1'] as const)('座標系に実在しない%sを項目へ偽装しない', featureId => {
    const base = appendBox(frameDependencyPart());
    const original = base.mathGeometry?.[0];
    if (original?.quantity.kind !== 'coordinate') throw new Error('Expected coordinate definition');
    const changed = { ...original, quantity: { ...original.quantity, frame: { kind: 'reference' as const, featureId } } };
    const analysis = analyzeMathGeometryDependencies({ ...base, mathGeometry: [changed] });
    expect(analysis.targets.get('g-frame')).toEqual(new Set(['measured-sketch']));
    expect(analysis.cycles).toEqual([]);
  });

  it.each(['origin', 'xAxis', 'yAxis'] as const)('%sの上流から同じ測定値へ戻る循環を検出する', via => {
    const base = frameDependencyPart(named('P'), via);
    const analysis = analyzeMathGeometryDependencies({ ...base, parameters: [mathParameter('P', 1, geometryNode('g-frame', '局所座標'))] });
    const message = mathGeometryCycleMessage('P', '局所座標', '測定座標系');
    expect(analysis.cycles).toEqual([{ definitionIds: ['g-frame'], coefficientNames: ['P'], shapeIds: ['frame'], message }]);
    expect(analysis.blocked).toEqual(new Map([['P', message]]));
    expect(analysis.stageOf.has('g-frame')).toBe(false);
    expect(analysis.historyEdges.size).toBe(0);
  });

  it.each(['origin', 'xAxis', 'yAxis'] as const)('%sの上流で別の測定値を使うと2段になり循環とは区別する', via => {
    const base = frameDependencyPart(named('P'), via);
    const document: PartDocument = { ...base,
      sketches: [...base.sketches, sketch('source', '測る線', [line('source-line', coordinate(ev(0)), coordinate(ev(10)))])],
      parameters: [mathParameter('P', 1, geometryNode('g-source', '線の長さ')), mathParameter('Q', 2, geometryNode('g-frame', '局所座標'))],
      mathGeometry: [sketchLineLengthOf('g-source', '線の長さ', 'source', 'source-line'), ...(base.mathGeometry ?? [])] };
    const analysis = analyzeMathGeometryDependencies(document);
    expect(analysis.stageOf).toEqual(new Map([['g-source', 1], ['g-frame', 2]]));
    expect(analysis.stageCount).toBe(2);
    expect(analysis.cycles).toEqual([]);
    expect(analysis.orderViolations).toEqual([]);
    expect(analysis.blocked.size).toBe(0);
  });

  it('座標系より前の利用先を順序違反にし、後ろへ移すと解消する', () => {
    const base = frameDependencyPart(), consumer = workPlane('consumer', '利用先の平面', named('Q'));
    const frame = base.references[base.references.length - 1], upstream = base.references.slice(0, -1);
    const document: PartDocument = { ...base, references: [...upstream, consumer, frame],
      parameters: [mathParameter('Q', 1, geometryNode('g-frame', '局所座標'))] };
    const analysis = analyzeMathGeometryDependencies(document);
    const message = mathGeometryOrderMessage('利用先の平面', '測定座標系', '局所座標', 'Q');
    expect(analysis.orderViolations).toEqual([{ featureId: 'consumer', targetFeatureId: 'frame',
      definitionId: 'g-frame', coefficientName: 'Q', message }]);
    expect(analysis.historyEdges).toEqual(new Map([['consumer', ['frame']]]));
    expect(analysis.blocked).toEqual(new Map([['Q', message]]));
    const moved = analyzeMathGeometryDependencies({ ...document, references: [...upstream, frame, consumer] });
    expect(moved.orderViolations).toEqual([]);
    expect(moved.blocked.size).toBe(0);
    expect(moved.historyEdges).toEqual(new Map([['consumer', ['frame']]]));
  });
});
