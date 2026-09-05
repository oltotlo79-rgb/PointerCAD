/**
 * 基本形状(球・箱・円柱・円錐・トーラス)のコマンドの検査
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク18、§2.7、§2.15)。
 *
 * 対応要件: FR-429、FR-201/202、FR-502、NFR-UX-4、NFR-UX-5。
 * ストアにも DOM にも触れない純関数だけを呼ぶ(`solidCommands.test.ts` と同じ流儀)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  appendSolid,
  createEmptyPartDocument,
  createPrimitiveFeature,
  DEFAULT_BOX_SIZE_MM,
  DEFAULT_CONE_BOTTOM_RADIUS_MM,
  DEFAULT_CONE_HEIGHT_MM,
  DEFAULT_CONE_TOP_RADIUS_MM,
  DEFAULT_CYLINDER_HEIGHT_MM,
  DEFAULT_CYLINDER_RADIUS_MM,
  DEFAULT_SPHERE_RADIUS_MM,
  DEFAULT_TORUS_MAJOR_RADIUS_MM,
  DEFAULT_TORUS_MINOR_RADIUS_MM,
  findSolid,
  replaceSketch,
  type PartDocument,
  type PrimitiveFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS } from '../i18n/t.js';
import type { SolidInputCommit } from '../sketch/numericInput.js';

import {
  commitPrimitive,
  primitiveFieldSummaries,
  primitiveOriginSummary,
  primitiveShapeFrom,
  primitiveShapeRejection,
  primitiveToolOf,
  primitiveToolReadiness,
  selectedPrimitiveOrigin,
  setPrimitiveAxis,
  setPrimitiveField,
  setPrimitiveOriginCoordinate,
  type PrimitiveContext,
  type PrimitiveToolId,
} from './primitiveCommands.js';
import { subShapeElementId, type SubShapeBody } from './subShapeSelection.js';

const PRIMITIVE_TOOLS: readonly PrimitiveToolId[] = ['sphere', 'box', 'cylinder', 'cone', 'torus'];

/** 頂点を 2 つ持つ立体(中心に頂点を指すときの相手)。 */
function bodyWithVertices(featureId: string): SubShapeBody {
  return {
    featureId,
    mesh: { edgePositions: new Float32Array(0) },
    faces: [],
    edges: [],
    vertices: [
      { index: 0, position: [0, 0, 0] },
      { index: 1, position: [10, 20, 30] },
    ],
  };
}

/** 点フィーチャーを 1 つ持つ部品文書。 */
function documentWithPoint(id = 'point-1'): PartDocument {
  const base = createEmptyPartDocument();
  return replaceSketch(
    base,
    appendFeature(base.sketches[0], {
      id,
      name: id,
      planeId: 'xy',
      kind: 'point',
      at: absoluteCoordinate(1, 2, 3),
    }),
  );
}

function contextOf(fields: Partial<PrimitiveContext> = {}): PrimitiveContext {
  return {
    document: fields.document ?? createEmptyPartDocument(),
    bodies: fields.bodies ?? [],
    selection: fields.selection ?? [],
  };
}

/** その場入力の確定結果のひな型(欄を渡さないときは既定値で作られる)。 */
function commitOf(tool: PrimitiveToolId, values: SolidInputCommit['values'] = {}): SolidInputCommit {
  return { kind: 'solid', tool, step: 'sphereSize', values, flags: {} };
}

/** できた基本形状のフィーチャーを取り出す(取り出せなければ検査を落とす)。 */
function primitiveAt(document: PartDocument, featureId: string): PrimitiveFeature {
  const found = findSolid(document, featureId);
  if (found === undefined || found.kind !== 'primitive') {
    throw new Error(`基本形状が見つからない: ${featureId}`);
  }
  return found;
}

describe('道具 id の絞り込み(`as` を使わない)', () => {
  it('基本形状 5 種だけを受け付ける', () => {
    for (const tool of PRIMITIVE_TOOLS) {
      expect(primitiveToolOf(tool)).toBe(tool);
    }
    expect(primitiveToolOf('extrude')).toBeNull();
    expect(primitiveToolOf('spring')).toBeNull();
    expect(primitiveToolOf('')).toBeNull();
  });
});

describe('中心を選択から決める(FR-429、§0.a-0.18)', () => {
  it('何も選んでいなければ原点の座標(NFR-UX-4「Enter 連打で意味のある結果」)', () => {
    const origin = selectedPrimitiveOrigin(contextOf());
    expect(origin.kind).toBe('coordinate');
    if (origin.kind !== 'coordinate') {
      return;
    }
    expect(origin.value.mode).toBe('absolute');
    if (origin.value.mode !== 'absolute') {
      return;
    }
    expect([origin.value.x.value, origin.value.y.value, origin.value.z.value]).toEqual([0, 0, 0]);
  });

  it('立体の頂点を選んでいれば、その頂点の指紋を持つ参照になる', () => {
    const bodies = [bodyWithVertices('extrude-1')];
    const origin = selectedPrimitiveOrigin(
      contextOf({ bodies, selection: [subShapeElementId('extrude-1', 'vertex', 1)] }),
    );
    expect(origin).toEqual({
      kind: 'vertex',
      ref: {
        bodyFeatureId: 'extrude-1',
        index: 1,
        fingerprint: { kind: 'vertex', position: [10, 20, 30] },
      },
    });
  });

  it('スケッチの点を選んでいれば、その点フィーチャーの参照になる', () => {
    const document = documentWithPoint();
    const origin = selectedPrimitiveOrigin(contextOf({ document, selection: ['point-1'] }));
    expect(origin).toEqual({
      kind: 'sketchPoint',
      ref: { sketchId: document.sketches[0].id, pointFeatureId: 'point-1' },
    });
  });

  it('頂点と点の両方が選ばれていれば頂点を採る(§2.15 の「選ぶ種類は頂点」に合わせる)', () => {
    const document = documentWithPoint();
    const bodies = [bodyWithVertices('extrude-1')];
    const origin = selectedPrimitiveOrigin(
      contextOf({
        document,
        bodies,
        selection: ['point-1', subShapeElementId('extrude-1', 'vertex', 0)],
      }),
    );
    expect(origin.kind).toBe('vertex');
  });

  it('面・辺を選んでいても中心にはしない(中心にできるのは頂点だけ、§2.7.1)', () => {
    const bodies = [bodyWithVertices('extrude-1')];
    const origin = selectedPrimitiveOrigin(
      contextOf({ bodies, selection: [subShapeElementId('extrude-1', 'face', 0)] }),
    );
    expect(origin.kind).toBe('coordinate');
  });
});

describe('欄が空でも既定の形ができる(§2.7.1 の既定値、NFR-UX-4)', () => {
  it('5 種とも model の既定値と同じ寸法になる', () => {
    expect(primitiveShapeFrom('sphere', {})).toEqual({
      kind: 'sphere',
      radius: expressionValueFromNumber(DEFAULT_SPHERE_RADIUS_MM),
    });
    expect(primitiveShapeFrom('box', {})).toEqual({
      kind: 'box',
      sizeX: expressionValueFromNumber(DEFAULT_BOX_SIZE_MM),
      sizeY: expressionValueFromNumber(DEFAULT_BOX_SIZE_MM),
      sizeZ: expressionValueFromNumber(DEFAULT_BOX_SIZE_MM),
    });
    expect(primitiveShapeFrom('cylinder', {})).toEqual({
      kind: 'cylinder',
      radius: expressionValueFromNumber(DEFAULT_CYLINDER_RADIUS_MM),
      height: expressionValueFromNumber(DEFAULT_CYLINDER_HEIGHT_MM),
    });
    expect(primitiveShapeFrom('cone', {})).toEqual({
      kind: 'cone',
      bottomRadius: expressionValueFromNumber(DEFAULT_CONE_BOTTOM_RADIUS_MM),
      topRadius: expressionValueFromNumber(DEFAULT_CONE_TOP_RADIUS_MM),
      height: expressionValueFromNumber(DEFAULT_CONE_HEIGHT_MM),
    });
    expect(primitiveShapeFrom('torus', {})).toEqual({
      kind: 'torus',
      majorRadius: expressionValueFromNumber(DEFAULT_TORUS_MAJOR_RADIUS_MM),
      minorRadius: expressionValueFromNumber(DEFAULT_TORUS_MINOR_RADIUS_MM),
    });
  });

  it('渡された欄はそのまま使う(式は文字列のまま残る、FR-202)', () => {
    const radius = { source: '5*2', value: 10, display: '10' };
    expect(primitiveShapeFrom('sphere', { sphereRadius: radius })).toEqual({
      kind: 'sphere',
      radius,
    });
  });
});

describe('寸法の先出し検査(§2.7.1 の断りの条件、NFR-UX-5)', () => {
  const value = expressionValueFromNumber;

  it('既定の寸法はどれも通る', () => {
    for (const tool of PRIMITIVE_TOOLS) {
      expect(primitiveShapeRejection(primitiveShapeFrom(tool, {})), tool).toBeNull();
    }
  });

  it('球の半径 0 は断る', () => {
    expect(primitiveShapeRejection({ kind: 'sphere', radius: value(0) })).toBe(
      'primitiveError.sphereRadius',
    );
    expect(primitiveShapeRejection({ kind: 'sphere', radius: value(-1) })).toBe(
      'primitiveError.sphereRadius',
    );
  });

  it('箱は 3 辺のどれかが 0 以下なら断る', () => {
    expect(
      primitiveShapeRejection({ kind: 'box', sizeX: value(20), sizeY: value(0), sizeZ: value(20) }),
    ).toBe('primitiveError.boxSize');
    expect(
      primitiveShapeRejection({ kind: 'box', sizeX: value(20), sizeY: value(20), sizeZ: value(-5) }),
    ).toBe('primitiveError.boxSize');
  });

  it('円柱は半径・高さのどちらかが 0 以下なら断る', () => {
    expect(primitiveShapeRejection({ kind: 'cylinder', radius: value(0), height: value(20) })).toBe(
      'primitiveError.cylinderSize',
    );
    expect(primitiveShapeRejection({ kind: 'cylinder', radius: value(10), height: value(0) })).toBe(
      'primitiveError.cylinderSize',
    );
  });

  it('円錐は上半径 0(尖った円錐)を通し、高さ 0・負の半径・両方 0・上下同径を断る', () => {
    const cone = (bottom: number, top: number, height: number) =>
      primitiveShapeRejection({
        kind: 'cone',
        bottomRadius: value(bottom),
        topRadius: value(top),
        height: value(height),
      });
    expect(cone(10, 0, 20)).toBeNull();
    // 円錐台(上半径が 0 より大きく、下半径と違う)も通る(§0.a-0.16)。
    expect(cone(10, 5, 20)).toBeNull();
    expect(cone(10, 0, 0)).toBe('primitiveError.coneHeight');
    expect(cone(-1, 0, 20)).toBe('primitiveError.coneRadiusNegative');
    expect(cone(10, -1, 20)).toBe('primitiveError.coneRadiusNegative');
    expect(cone(0, 0, 20)).toBe('primitiveError.coneRadiusBothZero');
    expect(cone(10, 10, 20)).toBe('primitiveError.coneRadiusSame');
  });

  it('トーラスは管の半径が主半径以上なら断る(自己交差する)', () => {
    const torus = (major: number, minor: number) =>
      primitiveShapeRejection({
        kind: 'torus',
        majorRadius: value(major),
        minorRadius: value(minor),
      });
    expect(torus(20, 5)).toBeNull();
    expect(torus(20, 20)).toBe('primitiveError.torusMinorTooLarge');
    expect(torus(20, 25)).toBe('primitiveError.torusMinorTooLarge');
    expect(torus(0, 5)).toBe('primitiveError.torusRadius');
    expect(torus(20, 0)).toBe('primitiveError.torusRadius');
  });

  it('断りの文言キーはすべて ja.json に実在する(NFR-MA-5)', () => {
    const keys = [
      'primitiveError.sphereRadius',
      'primitiveError.boxSize',
      'primitiveError.cylinderSize',
      'primitiveError.coneHeight',
      'primitiveError.coneRadiusNegative',
      'primitiveError.coneRadiusBothZero',
      'primitiveError.coneRadiusSame',
      'primitiveError.torusRadius',
      'primitiveError.torusMinorTooLarge',
      'primitiveError.notPrimitive',
    ];
    for (const key of keys) {
      expect(MESSAGE_KEYS, key).toContain(key);
    }
  });
});

describe('押せる条件(NFR-UX-5)', () => {
  it('5 種とも常に押せる。理由は持たない(何も選ばずに置けるため)', () => {
    for (const tool of PRIMITIVE_TOOLS) {
      expect(primitiveToolReadiness(contextOf(), tool), tool).toEqual({
        ready: true,
        reasonKey: null,
      });
    }
  });
});

describe('確定して履歴へ積む(FR-429)', () => {
  it('何も選ばずに確定すると、原点に既定の球ができる(履歴は 1 段)', () => {
    const context = contextOf();
    const outcome = commitPrimitive(context, commitOf('sphere'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.document.solids).toHaveLength(context.document.solids.length + 1);
    const feature = primitiveAt(outcome.document, outcome.featureId);
    expect(feature.shape).toEqual({
      kind: 'sphere',
      radius: expressionValueFromNumber(DEFAULT_SPHERE_RADIUS_MM),
    });
    expect(feature.origin.kind).toBe('coordinate');
    // 向きの既定は世界の Z 軸(§0.a-0.16)。
    expect(feature.axis).toEqual({ kind: 'world', axis: 'z' });
  });

  it('頂点を選んで箱を確定すると、その頂点が中心になる(§0.a-0.18)', () => {
    const bodies = [bodyWithVertices('extrude-1')];
    const context = contextOf({
      bodies,
      selection: [subShapeElementId('extrude-1', 'vertex', 1)],
    });
    const outcome = commitPrimitive(context, commitOf('box'));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = primitiveAt(outcome.document, outcome.featureId);
    expect(feature.origin.kind).toBe('vertex');
    expect(feature.shape.kind).toBe('box');
  });

  it('スケッチの点を選んで円柱を確定すると、その点が底面の中心になる(§0.a-0.17)', () => {
    const document = documentWithPoint();
    const outcome = commitPrimitive(
      contextOf({ document, selection: ['point-1'] }),
      commitOf('cylinder'),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(primitiveAt(outcome.document, outcome.featureId).origin).toEqual({
      kind: 'sketchPoint',
      ref: { sketchId: document.sketches[0].id, pointFeatureId: 'point-1' },
    });
  });

  it('その場入力で選んだ軸を向きにする(FR-402 と同じ `AxisSpec`)', () => {
    const outcome = commitPrimitive(contextOf(), {
      ...commitOf('cone'),
      axis: { kind: 'world', axis: 'x' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(primitiveAt(outcome.document, outcome.featureId).axis).toEqual({
      kind: 'world',
      axis: 'x',
    });
  });

  it('式はそのまま保存される(FR-202。`5*2` は文字列のまま、値は 10)', () => {
    const outcome = commitPrimitive(
      contextOf(),
      commitOf('sphere', { sphereRadius: { source: '5*2', value: 10, display: '10' } }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const shape = primitiveAt(outcome.document, outcome.featureId).shape;
    expect(shape.kind).toBe('sphere');
    if (shape.kind !== 'sphere') {
      return;
    }
    expect(shape.radius.source).toBe('5*2');
    expect(shape.radius.value).toBe(10);
  });

  it('範囲の外の寸法は履歴を変えずに断る(NFR-UX-5)', () => {
    const context = contextOf();
    const outcome = commitPrimitive(
      context,
      commitOf('sphere', { sphereRadius: expressionValueFromNumber(0) }),
    );
    expect(outcome).toEqual({ ok: false, reasonKey: 'primitiveError.sphereRadius' });
  });

  it('トーラスの管の半径が主半径以上なら断る(自己交差する)', () => {
    const outcome = commitPrimitive(
      contextOf(),
      commitOf('torus', {
        torusMajorRadius: expressionValueFromNumber(10),
        torusMinorRadius: expressionValueFromNumber(10),
      }),
    );
    expect(outcome).toEqual({ ok: false, reasonKey: 'primitiveError.torusMinorTooLarge' });
  });

  it('基本形状でない道具の確定は履歴を変えずに断る(振り分けの誤りを黙って通さない)', () => {
    const outcome = commitPrimitive(contextOf(), {
      kind: 'solid',
      tool: 'extrude',
      step: 'extrudeDistance',
      values: {},
      flags: {},
    });
    expect(outcome).toEqual({ ok: false, reasonKey: 'primitiveError.notPrimitive' });
  });

  it('5 種とも別々の連番で名前と id が付く(「球1」「箱1」…、§0.a-0.19)', () => {
    let document = createEmptyPartDocument();
    for (const tool of PRIMITIVE_TOOLS) {
      const outcome = commitPrimitive(contextOf({ document }), commitOf(tool));
      expect(outcome.ok, tool).toBe(true);
      if (!outcome.ok) {
        return;
      }
      document = outcome.document;
      expect(outcome.featureId.startsWith(`${tool}-`), outcome.featureId).toBe(true);
    }
    expect(new Set(document.solids.map((solid) => solid.id)).size).toBe(document.solids.length);
  });
});

describe('プロパティの欄(FR-502、FR-201)', () => {
  const base = createEmptyPartDocument();

  function featureOf(kind: PrimitiveToolId): PrimitiveFeature {
    return createPrimitiveFeature(base, kind);
  }

  it('形ごとの欄の数は 球1・箱3・円柱2・円錐3・トーラス2', () => {
    expect(primitiveFieldSummaries(featureOf('sphere')).map((item) => item.key)).toEqual([
      'sphereRadius',
    ]);
    expect(primitiveFieldSummaries(featureOf('box')).map((item) => item.key)).toEqual([
      'boxSizeX',
      'boxSizeY',
      'boxSizeZ',
    ]);
    expect(primitiveFieldSummaries(featureOf('cylinder')).map((item) => item.key)).toEqual([
      'cylinderRadius',
      'cylinderHeight',
    ]);
    expect(primitiveFieldSummaries(featureOf('cone')).map((item) => item.key)).toEqual([
      'coneBottomRadius',
      'coneTopRadius',
      'coneHeight',
    ]);
    expect(primitiveFieldSummaries(featureOf('torus')).map((item) => item.key)).toEqual([
      'torusMajorRadius',
      'torusMinorRadius',
    ]);
  });

  it('欄の見出し・説明の文言キーはすべて ja.json に実在し、単位は mm(NFR-MA-5)', () => {
    for (const tool of PRIMITIVE_TOOLS) {
      for (const item of primitiveFieldSummaries(featureOf(tool))) {
        expect(MESSAGE_KEYS, item.labelKey).toContain(item.labelKey);
        expect(MESSAGE_KEYS, item.tooltipKey).toContain(item.tooltipKey);
        expect(item.unit, item.key).toBe('mm');
      }
    }
  });

  it('寸法の欄を書き戻せる(その形に無い欄の名前ではそのまま返す)', () => {
    const box = featureOf('box');
    const next = setPrimitiveField(box, 'boxSizeY', expressionValueFromNumber(7));
    expect(next.shape).toEqual({
      kind: 'box',
      sizeX: expressionValueFromNumber(DEFAULT_BOX_SIZE_MM),
      sizeY: expressionValueFromNumber(7),
      sizeZ: expressionValueFromNumber(DEFAULT_BOX_SIZE_MM),
    });
    expect(setPrimitiveField(box, 'sphereRadius', expressionValueFromNumber(7))).toBe(box);
  });

  it('向きを差し替えられる(FR-502)', () => {
    expect(setPrimitiveAxis(featureOf('sphere'), 'y').axis).toEqual({ kind: 'world', axis: 'y' });
  });

  it('中心が座標なら 3 欄を出し、書き戻すと 1 つだけ変わる', () => {
    const sphere = featureOf('sphere');
    const summary = primitiveOriginSummary(base, sphere);
    expect(summary.kind).toBe('coordinate');
    if (summary.kind !== 'coordinate') {
      return;
    }
    expect(summary.fields.map((item) => item.axis)).toEqual(['x', 'y', 'z']);
    const moved = setPrimitiveOriginCoordinate(sphere, 'y', expressionValueFromNumber(12));
    expect(moved.origin.kind).toBe('coordinate');
    if (moved.origin.kind !== 'coordinate' || moved.origin.value.mode !== 'absolute') {
      return;
    }
    expect(moved.origin.value.x.value).toBe(0);
    expect(moved.origin.value.y.value).toBe(12);
    expect(moved.origin.value.z.value).toBe(0);
  });

  it('中心がスケッチの点・立体の頂点なら名前を出す(見つからなければ null、FR-504)', () => {
    const document = documentWithPoint();
    const sketchId = document.sketches[0].id;
    const withPoint: PrimitiveFeature = {
      ...createPrimitiveFeature(document, 'sphere'),
      origin: { kind: 'sketchPoint', ref: { sketchId, pointFeatureId: 'point-1' } },
    };
    expect(primitiveOriginSummary(document, withPoint)).toEqual({
      kind: 'sketchPoint',
      name: 'point-1',
    });

    const missing: PrimitiveFeature = {
      ...withPoint,
      origin: { kind: 'sketchPoint', ref: { sketchId, pointFeatureId: 'point-9' } },
    };
    expect(primitiveOriginSummary(document, missing)).toEqual({
      kind: 'sketchPoint',
      name: null,
    });

    // 頂点は「その頂点を持つ立体」の名前を出す。
    const target = createPrimitiveFeature(document, 'box');
    const documentWithBox = appendSolid(document, target);
    const onVertex: PrimitiveFeature = {
      ...createPrimitiveFeature(documentWithBox, 'sphere'),
      origin: {
        kind: 'vertex',
        ref: {
          bodyFeatureId: target.id,
          index: 0,
          fingerprint: { kind: 'vertex', position: [0, 0, 0] },
        },
      },
    };
    expect(primitiveOriginSummary(documentWithBox, onVertex)).toEqual({
      kind: 'vertex',
      name: target.name,
    });
  });
});
