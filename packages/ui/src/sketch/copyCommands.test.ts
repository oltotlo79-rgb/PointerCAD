import type { ExpressionValue } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptySketchDocument,
  replaceFeature,
  resolveSketch,
  WORK_PLANES,
  type SketchDocument,
  type WorkPlane,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  commitCircularArray,
  commitCopy,
  commitLinearArray,
  commitMirror,
  copyCountRejection,
  copySourceFromSelection,
  copyToolReadiness,
  directionFromAngle,
  mirrorAxisAvailability,
  mirrorAxisFromSelection,
  mirrorPlaneIdFor,
  planeDeltaCoordinate,
} from './copyCommands.js';
import type { EditInputCommit } from './numericInput.js';

/** 40×30 の矩形。`curvesByFeature` に 4 曲線が入る(§0.a-0.8)。 */
function rectangleDocument(): SketchDocument {
  return appendFeature(createEmptySketchDocument(), {
    id: 'rect1',
    name: '矩形1',
    planeId: 'xy',
    kind: 'rectangle',
    corner1: absoluteCoordinate(0, 0, 0),
    corner2: absoluteCoordinate(40, 30, 0),
    construction: false,
  });
}

/** (0,0,0)-(10,0,0) の線分 1 本。 */
function lineDocument(id = 'line1', toX = 10): SketchDocument {
  return appendFeature(createEmptySketchDocument(), {
    id,
    name: '線分1',
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(0, 0, 0),
    to: absoluteCoordinate(toX, 0, 0),
    construction: false,
  });
}

/** 矩形と、鏡にする縦の線分(x = 60)を 1 本ずつ持つ文書。 */
function rectangleAndAxisDocument(): SketchDocument {
  return appendFeature(rectangleDocument(), {
    id: 'line1',
    name: '線分1',
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(60, -10, 0),
    to: absoluteCoordinate(60, 40, 0),
    construction: false,
  });
}

/** 点 1 つだけの文書。 */
function pointDocument(): SketchDocument {
  return appendFeature(createEmptySketchDocument(), {
    id: 'point1',
    name: '点1',
    planeId: 'xy',
    kind: 'point',
    at: absoluteCoordinate(5, 5, 0),
  });
}

function value(source: string, evaluated: number): ExpressionValue {
  return { source, value: evaluated, display: source };
}

/** 欄・つまみ・選択肢がそろった確定結果を組み立てる小道具。 */
function editCommit(overrides: Partial<EditInputCommit> = {}): EditInputCommit {
  return {
    kind: 'edit',
    tool: 'copy',
    step: 'copyDelta',
    values: {},
    flags: {},
    choices: {},
    ...overrides,
  };
}

describe('複製のもと(選択 → source、FR-324)', () => {
  it('何も選ばずに複製しようとすると断る(NFR-UX-5)', () => {
    const resolved = resolveSketch(rectangleDocument());
    const outcome = copySourceFromSelection(resolved, []);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reasonKey).toBe('copy.error.emptySelection');
  });

  it('選んだ順がそのまま source の並びになる', () => {
    const document = rectangleAndAxisDocument();
    const outcome = copySourceFromSelection(resolveSketch(document), ['line1', 'rect1']);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.source : []).toEqual([{ featureId: 'line1' }, { featureId: 'rect1' }]);
  });

  it('点と曲線が混ざった選択は断る(自動で 2 つに分けない、統括への報告事項)', () => {
    let document = pointDocument();
    document = appendFeature(document, {
      id: 'line1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(0, 0, 0),
      to: absoluteCoordinate(10, 0, 0),
      construction: false,
    });
    const outcome = copySourceFromSelection(resolveSketch(document), ['point1', 'line1']);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reasonKey).toBe('copy.error.mixedSelection');
  });

  it('文書に無い要素を選んでいたら断る', () => {
    const resolved = resolveSketch(rectangleDocument());
    const outcome = copySourceFromSelection(resolved, ['face1']);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reasonKey).toBe('copy.error.unsupportedElement');
  });

  it('道具が押せる条件は選択の判定と同じ(NFR-UX-5)', () => {
    const resolved = resolveSketch(rectangleDocument());
    expect(copyToolReadiness(resolved, ['rect1'])).toEqual({ ready: true, reasonKey: null });
    expect(copyToolReadiness(resolved, [])).toEqual({
      ready: false,
      reasonKey: 'copy.error.emptySelection',
    });
  });
});

describe('ミラーの鏡(FR-324)', () => {
  it('作図面の軸で折り返す平面は、基準の 3 面の組み合わせで決まる', () => {
    expect(mirrorPlaneIdFor('xy', 'u')).toBe('xz');
    expect(mirrorPlaneIdFor('xy', 'v')).toBe('yz');
    expect(mirrorPlaneIdFor('xz', 'u')).toBe('xy');
    expect(mirrorPlaneIdFor('xz', 'v')).toBe('yz');
    expect(mirrorPlaneIdFor('yz', 'u')).toBe('xy');
    expect(mirrorPlaneIdFor('yz', 'v')).toBe('xz');
  });

  it('任意の作業平面・3D スケッチでは作図面の軸を鏡にできない', () => {
    expect(mirrorPlaneIdFor('referencePlane-1', 'u')).toBeNull();
    expect(mirrorPlaneIdFor('free', 'v')).toBeNull();
  });

  it('鏡になるのは最後に選んだ線分で、矩形の輪郭は鏡にしない', () => {
    const resolved = resolveSketch(rectangleAndAxisDocument());
    expect(mirrorAxisFromSelection(resolved, ['rect1', 'line1'])).toBe('line1');
    expect(mirrorAxisFromSelection(resolved, ['rect1'])).toBeNull();
  });

  it('鏡に使えるものを、道具を押す前に見分けられる(NFR-UX-5)', () => {
    const resolved = resolveSketch(rectangleAndAxisDocument());
    expect(mirrorAxisAvailability('xy', resolved, ['rect1'])).toEqual({
      planeAxes: true,
      selectedLine: false,
    });
    expect(mirrorAxisAvailability('referencePlane-1', resolved, ['rect1', 'line1'])).toEqual({
      planeAxes: false,
      selectedLine: true,
    });
  });
});

describe('commitMirror(FR-324)', () => {
  it('矩形を作図面の縦軸で折り返すと、複製フィーチャーが 1 つ増える', () => {
    const document = rectangleDocument();
    const outcome = commitMirror(document, resolveSketch(document), 'xy', ['rect1'], {
      ...editCommit({ tool: 'mirror', step: 'mirrorBasis' }),
      choices: { mirrorBasis: 'axisV' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.document.features).toHaveLength(2);
    const feature = outcome.document.features[1];
    expect(feature.kind).toBe('copy');
    expect(feature.name).toBe('複製1');
    if (feature.kind !== 'copy') {
      return;
    }
    expect(feature.placement).toEqual({
      kind: 'mirror',
      basis: { kind: 'plane', planeId: 'yz' },
    });
    expect(feature.source).toEqual([{ featureId: 'rect1' }]);
  });

  it('選んだ線を鏡にすると、その線は複製のもとから外れる', () => {
    const document = rectangleAndAxisDocument();
    const outcome = commitMirror(
      document,
      resolveSketch(document),
      'xy',
      ['rect1', 'line1'],
      { ...editCommit({ tool: 'mirror', step: 'mirrorBasis' }), choices: { mirrorBasis: 'line' } },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = outcome.document.features[2];
    if (feature.kind !== 'copy') {
      throw new Error('複製フィーチャーが積まれていません');
    }
    expect(feature.source).toEqual([{ featureId: 'rect1' }]);
    expect(feature.placement).toEqual({
      kind: 'mirror',
      basis: { kind: 'axis', axis: { featureId: 'line1' } },
    });
  });

  it('鏡にする線しか選んでいなければ、履歴を変えずに断る', () => {
    const document = lineDocument();
    const outcome = commitMirror(document, resolveSketch(document), 'xy', ['line1'], {
      ...editCommit({ tool: 'mirror', step: 'mirrorBasis' }),
      choices: { mirrorBasis: 'line' },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reasonKey).toBe('copy.error.emptySelection');
  });

  it('任意の作業平面で作図面の軸を選んでいたら断る', () => {
    const document = rectangleDocument();
    const outcome = commitMirror(document, resolveSketch(document), 'referencePlane-1', ['rect1'], {
      ...editCommit({ tool: 'mirror', step: 'mirrorBasis' }),
      choices: { mirrorBasis: 'axisU' },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reasonKey).toBe('mirror.error.noPlaneAxis');
  });
});

describe('複写の移動量(FR-324、FR-202)', () => {
  it('XY 作図面では入力した式がそのまま残る', () => {
    const delta = planeDeltaCoordinate(WORK_PLANES.xy, value('40/2', 20), value('0', 0));
    expect(delta.mode).toBe('absolute');
    if (delta.mode !== 'absolute') {
      return;
    }
    expect(delta.x.source).toBe('40/2');
    expect(delta.y.source).toBe('0');
    expect([delta.x.value, delta.y.value, delta.z.value]).toEqual([20, 0, 0]);
  });

  it('XZ 作図面では 2 つ目の欄がワールドの Z へ入る(作図面から浮かせない)', () => {
    const delta = planeDeltaCoordinate(WORK_PLANES.xz, value('10', 10), value('5', 5));
    if (delta.mode !== 'absolute') {
      throw new Error('絶対座標として組み立てられていません');
    }
    expect([delta.x.value, delta.y.value, delta.z.value]).toEqual([10, 0, 5]);
    expect(delta.z.source).toBe('5');
  });

  it('斜めを向いた作業平面では評価値から数を作る', () => {
    const tilted: WorkPlane = {
      id: 'referencePlane-1',
      origin: [0, 0, 0],
      axisU: [0.6, 0.8, 0],
      axisV: [0, 0, 1],
      normal: [0.8, -0.6, 0],
    };
    const delta = planeDeltaCoordinate(tilted, value('10', 10), value('0', 0));
    if (delta.mode !== 'absolute') {
      throw new Error('絶対座標として組み立てられていません');
    }
    expect(delta.x.value).toBeCloseTo(6, 9);
    expect(delta.y.value).toBeCloseTo(8, 9);
    expect(delta.z.value).toBeCloseTo(0, 9);
  });

  it('commitCopy は移動の複製を 1 つ積む', () => {
    const document = rectangleDocument();
    const outcome = commitCopy(
      document,
      resolveSketch(document),
      'xy',
      WORK_PLANES.xy,
      ['rect1'],
      { ...editCommit(), values: { dx: value('50', 50), dy: value('0', 0) } },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = outcome.document.features[1];
    if (feature.kind !== 'copy' || feature.placement.kind !== 'translate') {
      throw new Error('移動の複製になっていません');
    }
    expect(feature.placement.delta.mode).toBe('absolute');
  });

  it('3D スケッチでは 3 つ目の欄(ΔZ)をそのままワールドの Z にする', () => {
    const document = lineDocument();
    const outcome = commitCopy(document, resolveSketch(document), 'free', WORK_PLANES.xy, ['line1'], {
      ...editCommit(),
      values: { dx: value('1', 1), dy: value('2', 2), dz: value('3', 3) },
    });
    if (!outcome.ok) {
      throw new Error('複写できていません');
    }
    const feature = outcome.document.features[1];
    if (feature.kind !== 'copy' || feature.placement.kind !== 'translate') {
      throw new Error('移動の複製になっていません');
    }
    const delta = feature.placement.delta;
    if (delta.mode !== 'absolute') {
      throw new Error('絶対座標として組み立てられていません');
    }
    expect([delta.x.value, delta.y.value, delta.z.value]).toEqual([1, 2, 3]);
  });

  it('選択が空なら履歴を変えずに理由だけを返す', () => {
    const document = rectangleDocument();
    const outcome = commitCopy(document, resolveSketch(document), 'xy', WORK_PLANES.xy, [], editCommit());
    expect(outcome.ok).toBe(false);
    expect(document.features).toHaveLength(1);
  });
});

describe('配列複写(FR-324)', () => {
  it('向きの角度は原点から見た長さ 1 の向きになる', () => {
    const direction = directionFromAngle(value('90', 90));
    expect(direction.mode).toBe('polar');
    if (direction.mode !== 'polar') {
      return;
    }
    expect(direction.base).toEqual({ kind: 'origin' });
    expect(direction.distance.value).toBe(1);
    expect(direction.azimuth.source).toBe('90');
  });

  it('個数は 2 以上 100 以下の整数に限る(NFR-UX-5)', () => {
    expect(copyCountRejection(1)).toBe('copy.error.count');
    expect(copyCountRejection(101)).toBe('copy.error.count');
    expect(copyCountRejection(2.5)).toBe('copy.error.count');
    expect(copyCountRejection(2)).toBeNull();
    expect(copyCountRejection(100)).toBeNull();
  });

  it('直線配列は向き・間隔・個数をそのまま持つ', () => {
    const document = lineDocument();
    const outcome = commitLinearArray(document, resolveSketch(document), 'xy', ['line1'], {
      ...editCommit({ tool: 'linearArray', step: 'linearArrayCount' }),
      values: { angle: value('0', 0), spacing: value('10', 10), count: value('3', 3) },
    });
    if (!outcome.ok) {
      throw new Error('直線配列を作れていません');
    }
    const feature = outcome.document.features[1];
    if (feature.kind !== 'copy' || feature.placement.kind !== 'linearArray') {
      throw new Error('直線配列になっていません');
    }
    expect(feature.placement.spacing.value).toBe(10);
    expect(feature.placement.count.value).toBe(3);
  });

  it('個数 1 の直線配列は履歴を変えずに断る', () => {
    const document = lineDocument();
    const outcome = commitLinearArray(document, resolveSketch(document), 'xy', ['line1'], {
      ...editCommit({ tool: 'linearArray', step: 'linearArrayCount' }),
      values: { count: value('1', 1) },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reasonKey).toBe('copy.error.count');
    expect(document.features).toHaveLength(1);
  });

  it('円形配列は既定で全周・中心は原点(NFR-UX-4)', () => {
    const document = lineDocument();
    const outcome = commitCircularArray(document, resolveSketch(document), 'xy', ['line1'], {
      ...editCommit({ tool: 'circularArray', step: 'circularArrayShape' }),
      values: { count: value('4', 4) },
    });
    if (!outcome.ok) {
      throw new Error('円形配列を作れていません');
    }
    const feature = outcome.document.features[1];
    if (feature.kind !== 'copy' || feature.placement.kind !== 'circularArray') {
      throw new Error('円形配列になっていません');
    }
    expect(feature.placement.fullCircle).toBe(true);
    expect(feature.placement.count.value).toBe(4);
    expect(feature.placement.center.mode).toBe('absolute');
  });

  it('中心をその場で入れたときは、その座標を持つ', () => {
    const document = lineDocument();
    const outcome = commitCircularArray(document, resolveSketch(document), 'xy', ['line1'], {
      ...editCommit({ tool: 'circularArray', step: 'circularArrayShape' }),
      values: { count: value('6', 6) },
      coordinate: absoluteCoordinate(20, 20, 0),
      flags: { fullCircle: false },
    });
    if (!outcome.ok) {
      throw new Error('円形配列を作れていません');
    }
    const feature = outcome.document.features[1];
    if (feature.kind !== 'copy' || feature.placement.kind !== 'circularArray') {
      throw new Error('円形配列になっていません');
    }
    expect(feature.placement.fullCircle).toBe(false);
    expect(feature.placement.center).toEqual(absoluteCoordinate(20, 20, 0));
  });
});

describe('作った複製が実際に解ける(model との突き合わせ)', () => {
  it('線分を作図面の縦軸(Y 軸)で折り返すと、X が反転した複製ができる', () => {
    const document = lineDocument();
    const outcome = commitMirror(document, resolveSketch(document), 'xy', ['line1'], {
      ...editCommit({ tool: 'mirror', step: 'mirrorBasis' }),
      choices: { mirrorBasis: 'axisV' },
    });
    if (!outcome.ok) {
      throw new Error('ミラーを作れていません');
    }
    const resolved = resolveSketch(outcome.document);
    expect(resolved.errors).toEqual([]);
    const copies = resolved.segments.filter((segment) => segment.featureId === outcome.featureId);
    expect(copies).toHaveLength(1);
    expect(copies[0].from).toEqual([0, 0, 0]);
    expect(copies[0].to).toEqual([-10, 0, 0]);
  });

  it('直線配列 3 個で複製の曲線は 2 本(もとは含めない)', () => {
    const document = lineDocument();
    const outcome = commitLinearArray(document, resolveSketch(document), 'xy', ['line1'], {
      ...editCommit({ tool: 'linearArray', step: 'linearArrayCount' }),
      values: { angle: value('90', 90), spacing: value('20', 20), count: value('3', 3) },
    });
    if (!outcome.ok) {
      throw new Error('直線配列を作れていません');
    }
    const resolved = resolveSketch(outcome.document);
    expect(resolved.errors).toEqual([]);
    const copies = resolved.curvesByFeature.get(outcome.featureId) ?? [];
    expect(copies).toHaveLength(2);
  });

  it('円形配列 4 個は 90 度ずつ回った 3 本になる', () => {
    const document = lineDocument();
    const outcome = commitCircularArray(document, resolveSketch(document), 'xy', ['line1'], {
      ...editCommit({ tool: 'circularArray', step: 'circularArrayShape' }),
      values: { count: value('4', 4) },
      flags: { fullCircle: true },
    });
    if (!outcome.ok) {
      throw new Error('円形配列を作れていません');
    }
    const resolved = resolveSketch(outcome.document);
    expect(resolved.errors).toEqual([]);
    const copies = resolved.curvesByFeature.get(outcome.featureId) ?? [];
    expect(copies).toHaveLength(3);
    const first = copies[0];
    if (first.kind !== 'segment') {
      throw new Error('線分として複製されていません');
    }
    // 原点まわりに 90 度回すと (10,0,0) は (0,10,0) へ。
    expect(first.to[0]).toBeCloseTo(0, 9);
    expect(first.to[1]).toBeCloseTo(10, 9);
  });

  it('もとの線を動かすと複製もついて動く(参照で追従、FR-311)', () => {
    const document = lineDocument();
    const outcome = commitMirror(document, resolveSketch(document), 'xy', ['line1'], {
      ...editCommit({ tool: 'mirror', step: 'mirrorBasis' }),
      choices: { mirrorBasis: 'axisV' },
    });
    if (!outcome.ok) {
      throw new Error('ミラーを作れていません');
    }
    const moved = replaceFeature(outcome.document, 'line1', {
      id: 'line1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(0, 0, 0),
      to: absoluteCoordinate(25, 0, 0),
      construction: false,
    });
    const resolved = resolveSketch(moved);
    const copies = resolved.segments.filter((segment) => segment.featureId === outcome.featureId);
    expect(copies).toHaveLength(1);
    expect(copies[0].to).toEqual([-25, 0, 0]);
  });

  it('複製のもとを消すと、複製が理由つきで赤くなる(FR-504)', () => {
    const document = lineDocument();
    const outcome = commitLinearArray(document, resolveSketch(document), 'xy', ['line1'], {
      ...editCommit({ tool: 'linearArray', step: 'linearArrayCount' }),
      values: { count: value('3', 3) },
    });
    if (!outcome.ok) {
      throw new Error('直線配列を作れていません');
    }
    const withoutSource = {
      ...outcome.document,
      features: outcome.document.features.filter((feature) => feature.id !== 'line1'),
    };
    const resolved = resolveSketch(withoutSource);
    expect(resolved.errors.map((error) => error.featureId)).toContain(outcome.featureId);
  });
});
