import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { Parameter } from '../parameters/types.js';
import type { SketchConstraint } from '../sketch/constraints/types.js';
import { DEFAULT_FACE_COLOR } from '../sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type { CoordinateInput, SketchDocument, SketchFeature } from '../sketch/types.js';
import { createEmptyPartDocument } from './createPartDocument.js';
import {
  applyParameters,
  collectExpressionSources,
  reevaluatePartDocument,
  renameVariableInPartDocument,
} from './reevaluatePart.js';
import type { PartDocument, ReferenceFeature, SolidFeature } from './types.js';

// ---------------------------------------------------------------------------
// 検査の土台
// ---------------------------------------------------------------------------

/** そのまま評価できる式。評価できない式はテストの誤りとして落とす。 */
function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`テストの式が評価できない: ${source}(${result.error.code})`);
  }
  return result.value;
}

/**
 * 変数を含む式(そのままでは評価できない)。値は 0 で置いておき、変数表つきの評価し直しで
 * 入れ替わることを確かめる(入れ替わらなければ 0 のままなので、配線もれが検出できる)。
 */
function pending(source: string): ExpressionValue {
  return { source, value: 0, display: '0' };
}

function parameter(name: string, source: string): Parameter {
  return { name, value: expr(source), unit: 'mm', description: '' };
}

function coordinate(x: string, y: string, z: string): CoordinateInput {
  return { mode: 'absolute', x: expr(x), y: expr(y), z: expr(z) };
}

function pendingCoordinate(x: string, y: string, z: string): CoordinateInput {
  return { mode: 'absolute', x: pending(x), y: pending(y), z: pending(z) };
}

function variables(entries: Readonly<Record<string, number>>): ReadonlyMap<string, number> {
  return new Map(Object.entries(entries));
}

/** 面への参照 1 つ(穴・平面の指定が要る欄を埋めるためだけのもの)。 */
function faceRef(bodyFeatureId = 'extrude-1'): SubShapeRef {
  return {
    bodyFeatureId,
    index: 0,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

interface DocumentParts {
  readonly features?: readonly SketchFeature[];
  readonly constraints?: readonly SketchConstraint[];
  readonly references?: readonly ReferenceFeature[];
  readonly solids?: readonly SolidFeature[];
  readonly parameters?: readonly Parameter[];
}

/** 1 本のスケッチだけを持つ部品文書を組み立てる。 */
function buildDocument(parts: DocumentParts): PartDocument {
  const base = createEmptyPartDocument();
  const sketch: SketchDocument = {
    ...base.sketches[0],
    features: parts.features ?? [],
    ...(parts.constraints === undefined ? {} : { constraints: parts.constraints }),
  };
  return {
    ...base,
    sketches: [sketch],
    references: parts.references ?? [],
    solids: parts.solids ?? [],
    parameters: parts.parameters ?? [],
  };
}

function point(id: string, at: CoordinateInput): SketchFeature {
  return { id, name: id, planeId: DEFAULT_WORK_PLANE_ID, kind: 'point', at };
}

function extrude(id: string, distance: ExpressionValue): SolidFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance,
    reversed: false,
    symmetric: false,
  };
}

function hole(id: string, diameter: ExpressionValue, depth: ExpressionValue): SolidFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'hole',
    targetFeatureId: 'extrude-1',
    face: faceRef(),
    centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }],
    diameter,
    depth: { kind: 'blind', depth },
    tiltAngle: expr('0'),
    tiltAzimuth: expr('0'),
  };
}

function spring(id: string, turns: ExpressionValue): SolidFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'spring',
    origin: { sketchId: 'sketch-1', pointFeatureId: 'point-1' },
    axis: { kind: 'world', axis: 'z' },
    tiltAngle: expr('0'),
    tiltAzimuth: expr('0'),
    length: expr('30'),
    pitch: expr('10'),
    turns,
    derived: 'length',
    coilDiameter: expr('20'),
    wireDiameter: expr('2'),
    handedness: 'right',
  };
}

function chamfer(id: string, distance1: ExpressionValue, distance2: ExpressionValue): SolidFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'chamfer',
    targetFeatureId: 'extrude-1',
    targets: [faceRef()],
    size: { kind: 'twoDistances', distance1, distance2 },
    swapReferenceFace: false,
  };
}

function offsetPlane(id: string, offset: ExpressionValue): ReferenceFeature {
  return {
    id,
    name: id,
    visible: true,
    kind: 'referencePlane',
    plane: { kind: 'workPlane', planeId: DEFAULT_WORK_PLANE_ID, offset },
  };
}

function coordinatePoint(id: string, at: CoordinateInput): ReferenceFeature {
  return { id, name: id, visible: true, kind: 'referencePoint', definition: { kind: 'coordinate', at } };
}

function distanceConstraint(id: string, length: ExpressionValue): SketchConstraint {
  return {
    id,
    name: id,
    kind: 'distance',
    a: { kind: 'point', pointId: 'point-1' },
    b: { kind: 'point', pointId: 'point-2' },
    length,
  };
}

// ---------------------------------------------------------------------------
// collectExpressionSources
// ---------------------------------------------------------------------------

describe('collectExpressionSources', () => {
  it('空の部品からは 1 つも集めない', () => {
    expect(collectExpressionSources(createEmptyPartDocument())).toEqual([]);
  });

  it('スケッチの座標と立体の寸法を集める(点 3 欄+押し出し 1 欄)', () => {
    const document = buildDocument({
      features: [point('point-1', coordinate('1', '2', '3'))],
      solids: [extrude('extrude-1', expr('10'))],
    });
    expect(collectExpressionSources(document)).toEqual(['1', '2', '3', '10']);
  });

  it('拘束の目標値も集める(FR-207 の「使われていない名前」の判定に要る)', () => {
    const document = buildDocument({
      features: [],
      constraints: [distanceConstraint('constraint-1', pending('板厚 * 3'))],
    });
    expect(collectExpressionSources(document)).toEqual(['板厚 * 3']);
  });

  it('基準ジオメトリのオフセットと座標を集める(1 欄+3 欄)', () => {
    const document = buildDocument({
      references: [
        offsetPlane('referencePlane-1', expr('5')),
        coordinatePoint('referencePoint-1', coordinate('7', '8', '9')),
      ],
    });
    expect(collectExpressionSources(document)).toEqual(['5', '7', '8', '9']);
  });

  it('式を持たない種類(面・ブーリアン・基準軸)からは集めない', () => {
    const document = buildDocument({
      features: [
        {
          id: 'face-1',
          name: 'face-1',
          planeId: DEFAULT_WORK_PLANE_ID,
          kind: 'face',
          boundary: [{ featureId: 'point-1' }],
          color: DEFAULT_FACE_COLOR,
        },
      ],
      references: [
        {
          id: 'referenceAxis-1',
          name: 'referenceAxis-1',
          visible: true,
          kind: 'referenceAxis',
          definition: { kind: 'edge', edge: faceRef() },
        },
      ],
      solids: [
        {
          id: 'boolean-1',
          name: 'boolean-1',
          suppressed: false,
          kind: 'boolean',
          operation: 'union',
          targetFeatureId: 'extrude-1',
          toolFeatureId: 'extrude-2',
        },
      ],
    });
    expect(collectExpressionSources(document)).toEqual([]);
  });

  it('穴・ばね・面取りの欄をすべて集める(穴 4・ばね 7・面取り 2)', () => {
    const document = buildDocument({
      solids: [
        hole('hole-1', expr('6'), expr('4')),
        spring('spring-1', expr('3')),
        chamfer('chamfer-1', expr('1'), expr('2')),
      ],
    });
    // 穴: 径・深さ・傾き・方位 = 4、ばね: 傾き 2 + 全長・ピッチ・巻数・コイル径・線径 = 7、面取り: 2
    expect(collectExpressionSources(document)).toHaveLength(4 + 7 + 2);
  });

  it('パラメータ表自身の式は含めない(自己参照を「使われている」と数えないため)', () => {
    const document = buildDocument({ parameters: [parameter('板厚', '3')] });
    expect(collectExpressionSources(document)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reevaluatePartDocument
// ---------------------------------------------------------------------------

describe('reevaluatePartDocument', () => {
  it('押し出しの距離が変数表で入れ替わり、式文字列は変わらない(FR-202)', () => {
    const document = buildDocument({ solids: [extrude('extrude-1', pending('板厚 * 2'))] });
    const result = reevaluatePartDocument(document, variables({ 板厚: 3 }));
    const solid = result.document.solids[0];
    expect(solid.kind).toBe('extrude');
    if (solid.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(solid.distance.value).toBe(6);
    expect(solid.distance.source).toBe('板厚 * 2');
    expect(result.failures).toEqual([]);
  });

  it('パラメータの値を変えると押し出しの距離が追従する(3 → 5 で 6 → 10)', () => {
    const document = buildDocument({ solids: [extrude('extrude-1', pending('板厚 * 2'))] });
    const six = reevaluatePartDocument(document, variables({ 板厚: 3 })).document;
    const ten = reevaluatePartDocument(six, variables({ 板厚: 5 })).document;
    const solid = ten.solids[0];
    if (solid.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(solid.distance.value).toBe(10);
    expect(solid.distance.source).toBe('板厚 * 2');
  });

  it('穴の径が追従する(板厚 3 → 5 で 6 → 10)', () => {
    const document = buildDocument({
      solids: [hole('hole-1', pending('板厚 * 2'), expr('4'))],
    });
    const three = reevaluatePartDocument(document, variables({ 板厚: 3 })).document;
    const five = reevaluatePartDocument(three, variables({ 板厚: 5 })).document;
    const before = three.solids[0];
    const after = five.solids[0];
    if (before.kind !== 'hole' || after.kind !== 'hole') {
      throw new Error('穴のはず');
    }
    expect(before.diameter.value).toBe(6);
    expect(after.diameter.value).toBe(10);
  });

  it('穴の止まり深さも追従する(depth の中の式まで歩く)', () => {
    const document = buildDocument({
      solids: [hole('hole-1', expr('6'), pending('板厚'))],
    });
    const solid = reevaluatePartDocument(document, variables({ 板厚: 5 })).document.solids[0];
    if (solid.kind !== 'hole' || solid.depth.kind !== 'blind') {
      throw new Error('止まり穴のはず');
    }
    expect(solid.depth.depth.value).toBe(5);
  });

  it('スケッチの点の座標が追従する(板厚 3 → 5)', () => {
    const document = buildDocument({
      features: [point('point-1', pendingCoordinate('板厚', '0', '0'))],
    });
    const three = reevaluatePartDocument(document, variables({ 板厚: 3 })).document;
    const five = reevaluatePartDocument(three, variables({ 板厚: 5 })).document;
    const before = three.sketches[0].features[0];
    const after = five.sketches[0].features[0];
    if (before.kind !== 'point' || after.kind !== 'point') {
      throw new Error('点のはず');
    }
    if (before.at.mode !== 'absolute' || after.at.mode !== 'absolute') {
      throw new Error('絶対座標のはず');
    }
    expect(before.at.x.value).toBe(3);
    expect(after.at.x.value).toBe(5);
  });

  it('基準平面のオフセットが追従する(板厚 3 → 5)', () => {
    const document = buildDocument({
      references: [offsetPlane('referencePlane-1', pending('板厚'))],
    });
    const three = reevaluatePartDocument(document, variables({ 板厚: 3 })).document;
    const five = reevaluatePartDocument(three, variables({ 板厚: 5 })).document;
    const before = three.references[0];
    const after = five.references[0];
    if (before.kind !== 'referencePlane' || after.kind !== 'referencePlane') {
      throw new Error('基準平面のはず');
    }
    if (before.plane.kind !== 'workPlane' || after.plane.kind !== 'workPlane') {
      throw new Error('作業平面のオフセットのはず');
    }
    expect(before.plane.offset.value).toBe(3);
    expect(after.plane.offset.value).toBe(5);
  });

  it('ばねの巻数が追従する(巻 = 3 で 巻 + 0.5 が 3.5)', () => {
    const document = buildDocument({ solids: [spring('spring-1', pending('巻 + 0.5'))] });
    const solid = reevaluatePartDocument(document, variables({ 巻: 3 })).document.solids[0];
    if (solid.kind !== 'spring') {
      throw new Error('ばねのはず');
    }
    expect(solid.turns.value).toBe(3.5);
  });

  it('面取りの 2 距離が両方とも追従する(板厚 = 6 で 6 と 3)', () => {
    const document = buildDocument({
      solids: [chamfer('chamfer-1', pending('板厚'), pending('板厚 / 2'))],
    });
    const solid = reevaluatePartDocument(document, variables({ 板厚: 6 })).document.solids[0];
    if (solid.kind !== 'chamfer' || solid.size.kind !== 'twoDistances') {
      throw new Error('2 距離の面取りのはず');
    }
    expect(solid.size.distance1.value).toBe(6);
    expect(solid.size.distance2.value).toBe(3);
  });

  it('拘束の目標値も追従する(FR-313 と FR-207 の噛み合い)', () => {
    const document = buildDocument({
      constraints: [distanceConstraint('constraint-1', pending('板厚 * 4'))],
    });
    const sketch = reevaluatePartDocument(document, variables({ 板厚: 3 })).document.sketches[0];
    const constraint = (sketch.constraints ?? [])[0];
    if (constraint === undefined || constraint.kind !== 'distance') {
      throw new Error('距離拘束のはず');
    }
    expect(constraint.length.value).toBe(12);
  });

  it('拘束の欄が無い文書に空の配列を生やさない(保存の往復で形を変えない)', () => {
    const document = buildDocument({ features: [point('point-1', pendingCoordinate('板厚', '0', '0'))] });
    const next = reevaluatePartDocument(document, variables({ 板厚: 3 })).document;
    expect(next.sketches[0].constraints).toBeUndefined();
  });

  it('未知の変数を含む式は値を据え置き、失敗の一覧へ入れる(FR-504)', () => {
    const document = buildDocument({ solids: [extrude('extrude-1', expr('10'))] });
    const broken: PartDocument = {
      ...document,
      solids: [extrude('extrude-1', { source: '未知 + 1', value: 10, display: '10' })],
    };
    const result = reevaluatePartDocument(broken, variables({ 板厚: 3 }));
    const solid = result.document.solids[0];
    if (solid.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(solid.distance.value).toBe(10);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].ownerId).toBe('extrude-1');
    expect(result.failures[0].source).toBe('未知 + 1');
    expect(result.failures[0].message.length).toBeGreaterThan(0);
  });

  it('ゼロ除算も値を据え置き、例外を投げない', () => {
    const document = buildDocument({
      solids: [extrude('extrude-1', { source: '板厚 / 0', value: 7, display: '7' })],
    });
    const result = reevaluatePartDocument(document, variables({ 板厚: 3 }));
    const solid = result.document.solids[0];
    if (solid.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(solid.distance.value).toBe(7);
    expect(result.failures).toHaveLength(1);
  });

  it('値が 1 つも変わらなければ元の文書をそのまま返す(下流の鍵を無駄に変えない)', () => {
    const document = buildDocument({
      features: [point('point-1', coordinate('1', '2', '3'))],
      references: [offsetPlane('referencePlane-1', expr('5'))],
      solids: [extrude('extrude-1', expr('10'))],
    });
    const result = reevaluatePartDocument(document, variables({ 板厚: 3 }));
    expect(result.document).toBe(document);
    expect(result.failures).toEqual([]);
  });

  it('変わったのが立体だけなら、スケッチと基準ジオメトリは元のオブジェクトのまま', () => {
    const document = buildDocument({
      features: [point('point-1', coordinate('1', '2', '3'))],
      references: [offsetPlane('referencePlane-1', expr('5'))],
      solids: [extrude('extrude-1', pending('板厚 * 2'))],
    });
    const next = reevaluatePartDocument(document, variables({ 板厚: 3 })).document;
    expect(next).not.toBe(document);
    expect(next.sketches).toBe(document.sketches);
    expect(next.references).toBe(document.references);
  });

  it('式文字列は 1 つも変わらない(FR-202)', () => {
    const document = buildDocument({
      features: [point('point-1', pendingCoordinate('板厚', '板厚 * 2', '0'))],
      solids: [extrude('extrude-1', pending('板厚 + 1'))],
    });
    const before = collectExpressionSources(document);
    const after = collectExpressionSources(
      reevaluatePartDocument(document, variables({ 板厚: 3 })).document,
    );
    expect(after).toEqual(before);
  });

  it('式 1000 個の評価し直しが 200ms 以内で終わる(NFR-PF-3 の内訳)', () => {
    const solids: SolidFeature[] = [];
    for (let index = 0; index < 1000; index += 1) {
      solids.push(extrude(`extrude-${String(index + 1)}`, pending('板厚 * 2')));
    }
    const document = buildDocument({ solids });
    expect(collectExpressionSources(document)).toHaveLength(1000);
    const startedAt = performance.now();
    const result = reevaluatePartDocument(document, variables({ 板厚: 3 }));
    const elapsedMs = performance.now() - startedAt;
    console.log(`式 1000 個の評価し直し: ${elapsedMs.toFixed(1)} ms / 上限 200 ms`);
    expect(result.document.solids).toHaveLength(1000);
    expect(elapsedMs).toBeLessThan(200);
  });

  it('式 1000 個の入口(applyParameters)が 200ms 以内で終わる(再計算のたびに通る道)', () => {
    const solids: SolidFeature[] = [];
    for (let index = 0; index < 1000; index += 1) {
      solids.push(extrude(`extrude-${String(index + 1)}`, pending('板厚 * 2')));
    }
    const document = buildDocument({ solids, parameters: [parameter('板厚', '3')] });
    const startedAt = performance.now();
    const applied = applyParameters(document);
    const elapsedMs = performance.now() - startedAt;
    console.log(`式 1000 個の applyParameters: ${elapsedMs.toFixed(1)} ms / 上限 200 ms`);
    expect(applied.analysis.unused).toEqual([]);
    expect(elapsedMs).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// renameVariableInPartDocument
// ---------------------------------------------------------------------------

describe('renameVariableInPartDocument', () => {
  it('スケッチ・立体・基準ジオメトリ・パラメータ表の式がすべて追従する', () => {
    const document = buildDocument({
      features: [point('point-1', pendingCoordinate('板厚', '0', '0'))],
      references: [offsetPlane('referencePlane-1', pending('板厚 * 2'))],
      solids: [extrude('extrude-1', pending('板厚 + 1'))],
      parameters: [parameter('板厚', '3'), { ...parameter('穴径', '3'), value: pending('板厚 * 2') }],
    });
    const next = renameVariableInPartDocument(document, '板厚', '板の厚み');
    expect(collectExpressionSources(next)).toEqual(['板の厚み', '0', '0', '板の厚み * 2', '板の厚み + 1']);
    expect(next.parameters[1].value.source).toBe('板の厚み * 2');
    // パラメータの名前そのものを変えるのは renameParameter の担当(ここでは変えない)。
    expect(next.parameters[0].name).toBe('板厚');
  });

  it('別の名前の一部が置き換わらない(板厚さ は変わらない)', () => {
    const document = buildDocument({ solids: [extrude('extrude-1', pending('板厚さ * 2'))] });
    const next = renameVariableInPartDocument(document, '板厚', '板の厚み');
    expect(collectExpressionSources(next)).toEqual(['板厚さ * 2']);
    expect(next).toBe(document);
  });

  it('値は変えない(名前が変わっても数は変わらない)', () => {
    const document = buildDocument({
      solids: [extrude('extrude-1', { source: '板厚 * 2', value: 6, display: '6' })],
    });
    const solid = renameVariableInPartDocument(document, '板厚', '板の厚み').solids[0];
    if (solid.kind !== 'extrude') {
      throw new Error('押し出しのはず');
    }
    expect(solid.distance.value).toBe(6);
    expect(solid.distance.source).toBe('板の厚み * 2');
  });
});

// ---------------------------------------------------------------------------
// applyParameters
// ---------------------------------------------------------------------------

describe('applyParameters', () => {
  it('パラメータ表が空なら何もしない(元の文書をそのまま返す)', () => {
    const document = buildDocument({ solids: [extrude('extrude-1', expr('10'))] });
    const applied = applyParameters(document);
    expect(applied.document).toBe(document);
    expect(applied.analysis.variables.size).toBe(0);
    expect(applied.analysis.circular).toEqual([]);
    expect(applied.failures).toEqual([]);
  });

  it('板厚 = 3、穴径 = 板厚 * 2 で、穴の径 = 穴径 が 6 になる(利用者の例)', () => {
    const document = buildDocument({
      solids: [hole('hole-1', pending('穴径'), expr('4'))],
      parameters: [parameter('板厚', '3'), { ...parameter('穴径', '0'), value: pending('板厚 * 2') }],
    });
    const applied = applyParameters(document);
    const solid = applied.document.solids[0];
    if (solid.kind !== 'hole') {
      throw new Error('穴のはず');
    }
    expect(solid.diameter.value).toBe(6);
    expect(applied.analysis.variables.get('穴径')).toBe(6);
    expect(applied.failures).toEqual([]);
  });

  it('板厚を 5 にすると穴の径が 10 になる(FR-207 の「1 か所変えると全部追従」)', () => {
    const before = buildDocument({
      solids: [hole('hole-1', pending('穴径'), expr('4'))],
      parameters: [parameter('板厚', '3'), { ...parameter('穴径', '0'), value: pending('板厚 * 2') }],
    });
    const document: PartDocument = {
      ...before,
      parameters: [parameter('板厚', '5'), before.parameters[1]],
    };
    const applied = applyParameters(document);
    const solid = applied.document.solids[0];
    if (solid.kind !== 'hole') {
      throw new Error('穴のはず');
    }
    expect(solid.diameter.value).toBe(10);
  });

  it('パラメータ表自身の値も新しい変数表で書き直す(表の「値」の列が古い数を見せない)', () => {
    const document = buildDocument({
      parameters: [parameter('板厚', '5'), { ...parameter('穴径', '0'), value: pending('板厚 * 2') }],
    });
    const applied = applyParameters(document);
    expect(applied.document.parameters[1].value.value).toBe(10);
    expect(applied.document.parameters[1].value.source).toBe('板厚 * 2');
  });

  it('循環している名前があっても例外を投げず、文書は変わらない(値は据え置き)', () => {
    const document = buildDocument({
      solids: [extrude('extrude-1', { source: 'A * 2', value: 4, display: '4' })],
      parameters: [
        { ...parameter('A', '1'), value: pending('B + 1') },
        { ...parameter('B', '1'), value: pending('A + 1') },
      ],
    });
    const applied = applyParameters(document);
    expect(applied.analysis.circular).toEqual(['A', 'B']);
    expect(applied.document).toBe(document);
    expect(applied.failures).toHaveLength(1);
  });

  it('文書の式から参照されている名前は「未使用」にならない(FR-207)', () => {
    const document = buildDocument({
      solids: [extrude('extrude-1', pending('板厚 * 2'))],
      parameters: [parameter('板厚', '3'), parameter('未使用', '5')],
    });
    const applied = applyParameters(document);
    expect(applied.analysis.unused).toEqual(['未使用']);
  });
});
