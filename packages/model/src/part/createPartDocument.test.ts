import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import {
  absoluteCoordinate,
  appendFeature,
  createPointFeature,
  DEFAULT_FACE_COLOR,
  findFeature,
  nextFeatureId,
  nextFeatureName,
} from '../sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import type { SketchDocument, SketchFaceFeature, SketchLineFeature } from '../sketch/types.js';
import {
  addSketch,
  appendSolid,
  consumedBodyIds,
  createEmptyPartDocument,
  DEFAULT_SEW_TOLERANCE_MM,
  findSketch,
  findSolid,
  liveBodyIds,
  nextSolidId,
  nextSolidName,
  PART_SCHEMA_VERSION,
  removeSolid,
  replaceSketch,
  replaceSolid,
  setActiveSketch,
  SOLID_LABELS,
} from './createPartDocument.js';
import type {
  BooleanFeature,
  BooleanOperation,
  ExtrudeFeature,
  PartDocument,
  RevolveFeature,
  SewFeature,
  SketchFaceRef,
  SketchLineRef,
  SolidFeature,
} from './types.js';

/** テストの中で式を書くための補助。評価できない式はテストの誤りとして落とす。 */
function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`テストの式が評価できない: ${source}(${result.error.code})`);
  }
  return result.value;
}

/** 前提が崩れたら黙って進まずに落とす(テストの誤りと実装の誤りを分けるため)。 */
function activeSketch(document: PartDocument): SketchDocument {
  const sketch = findSketch(document, document.activeSketchId);
  if (sketch === undefined) {
    throw new Error('テストの前提が壊れている: activeSketchId のスケッチが無い');
  }
  return sketch;
}

/**
 * 40×30 の面を1枚だけ持つ部品文書を作る。押し出し・回転の断面に使う。
 * スケッチ側のフィーチャーは P1 の関数だけで組み立てる(面の作成関数はまだ無い)。
 */
function documentWithFace(): { document: PartDocument; faceRef: SketchFaceRef } {
  const base = createEmptyPartDocument();
  let sketch = activeSketch(base);
  const cornerIds: string[] = [];
  for (const [x, y] of [
    [0, 0],
    [40, 0],
    [40, 30],
    [0, 30],
  ]) {
    const point = createPointFeature(sketch, absoluteCoordinate(x, y, 0));
    sketch = appendFeature(sketch, point);
    cornerIds.push(point.id);
  }
  const face: SketchFaceFeature = {
    id: nextFeatureId(sketch, 'face'),
    name: nextFeatureName(sketch, 'face'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary: cornerIds.map((featureId) => ({ featureId })),
    color: DEFAULT_FACE_COLOR,
  };
  sketch = appendFeature(sketch, face);
  return {
    document: replaceSketch(base, sketch),
    faceRef: { sketchId: sketch.id, faceFeatureId: face.id },
  };
}

/** 回転軸に使える線分を、いま編集中のスケッチへ足す。 */
function addAxisLine(document: PartDocument): { document: PartDocument; lineRef: SketchLineRef } {
  const sketch = activeSketch(document);
  const line: SketchLineFeature = {
    id: nextFeatureId(sketch, 'line'),
    name: nextFeatureName(sketch, 'line'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'line',
    from: absoluteCoordinate(0, 0, 0),
    to: absoluteCoordinate(0, 30, 0),
  };
  const next = appendFeature(sketch, line);
  return {
    document: replaceSketch(document, next),
    lineRef: { sketchId: next.id, lineFeatureId: line.id },
  };
}

function buildExtrude(
  document: PartDocument,
  profile: SketchFaceRef,
  distance = '5*2',
): ExtrudeFeature {
  return {
    id: nextSolidId(document, 'extrude'),
    name: nextSolidName(document, 'extrude'),
    suppressed: false,
    kind: 'extrude',
    profile,
    distance: expr(distance),
    reversed: false,
    symmetric: false,
  };
}

function buildRevolve(document: PartDocument, profile: SketchFaceRef): RevolveFeature {
  return {
    id: nextSolidId(document, 'revolve'),
    name: nextSolidName(document, 'revolve'),
    suppressed: false,
    kind: 'revolve',
    profile,
    axis: { kind: 'world', axis: 'z' },
    angle: expr('360'),
    reversed: false,
  };
}

function buildSew(document: PartDocument, faces: readonly SketchFaceRef[]): SewFeature {
  return {
    id: nextSolidId(document, 'sew'),
    name: nextSolidName(document, 'sew'),
    suppressed: false,
    kind: 'sew',
    faces,
    tolerance: expr(String(DEFAULT_SEW_TOLERANCE_MM)),
  };
}

function buildBoolean(
  document: PartDocument,
  operation: BooleanOperation,
  targetFeatureId: string,
  toolFeatureId: string,
): BooleanFeature {
  return {
    id: nextSolidId(document, operation),
    name: nextSolidName(document, operation),
    suppressed: false,
    kind: 'boolean',
    operation,
    targetFeatureId,
    toolFeatureId,
  };
}

/** 押し出し2つと、その2つを消費する差を持つ文書(消費の判定の土台)。 */
function documentWithSubtract(): {
  document: PartDocument;
  target: ExtrudeFeature;
  tool: ExtrudeFeature;
  subtract: BooleanFeature;
} {
  const { document: withFace, faceRef } = documentWithFace();
  const target = buildExtrude(withFace, faceRef);
  const afterTarget = appendSolid(withFace, target);
  const tool = buildExtrude(afterTarget, faceRef, '4');
  const afterTool = appendSolid(afterTarget, tool);
  const subtract = buildBoolean(afterTool, 'subtract', target.id, tool.id);
  return { document: appendSolid(afterTool, subtract), target, tool, subtract };
}

describe('部品文書の生成(要件§8、FR-501)', () => {
  it('空の部品は、空のスケッチを1本だけ持ちソリッドは無い', () => {
    const document = createEmptyPartDocument();
    expect(document.id).toBe('part-1');
    expect(document.name).toBe('部品1');
    expect(document.sketches).toHaveLength(1);
    expect(document.sketches[0].features).toEqual([]);
    expect(document.solids).toEqual([]);
  });

  it('保存形式の版は 2(§0.a-0.3)', () => {
    expect(PART_SCHEMA_VERSION).toBe(2);
    expect(createEmptyPartDocument().schemaVersion).toBe(PART_SCHEMA_VERSION);
  });

  it('activeSketchId は実在するスケッチを指す(§0.a-0.4)', () => {
    const document = createEmptyPartDocument();
    expect(document.activeSketchId).toBe(document.sketches[0].id);
    expect(findSketch(document, document.activeSketchId)).toBe(document.sketches[0]);
    expect(findSketch(document, 'no-such-sketch')).toBeUndefined();
  });
});

describe('スケッチの追加と差し替え(不変、FR-505 の土台)', () => {
  it('足しても元の文書は変わらず、末尾へ並ぶ', () => {
    const before = createEmptyPartDocument();
    const added: SketchDocument = { id: 'sketch-2', name: 'スケッチ2', features: [] };
    const after = addSketch(before, added);
    expect(before.sketches).toHaveLength(1);
    expect(after.sketches).toHaveLength(2);
    expect(after.sketches[1]).toBe(added);
    expect(after.activeSketchId).toBe(before.activeSketchId);
  });

  it('同じ id のスケッチは足さない(id の一意性)', () => {
    const document = createEmptyPartDocument();
    const duplicate: SketchDocument = { id: document.activeSketchId, name: '別名', features: [] };
    expect(addSketch(document, duplicate)).toBe(document);
  });

  it('差し替えは該当 id だけを入れ替え、無い id なら元の文書のまま', () => {
    const { document } = documentWithFace();
    expect(activeSketch(document).features).toHaveLength(5);
    const emptied: SketchDocument = { ...activeSketch(document), features: [] };
    const after = replaceSketch(document, emptied);
    expect(activeSketch(after).features).toEqual([]);
    expect(activeSketch(document).features).toHaveLength(5);
    const stranger: SketchDocument = { id: 'sketch-9', name: 'よそ者', features: [] };
    expect(replaceSketch(document, stranger)).toBe(document);
  });

  it('編集中のスケッチは実在する id にだけ切り替わる', () => {
    const document = addSketch(createEmptyPartDocument(), {
      id: 'sketch-2',
      name: 'スケッチ2',
      features: [],
    });
    expect(setActiveSketch(document, 'sketch-2').activeSketchId).toBe('sketch-2');
    expect(setActiveSketch(document, 'no-such-sketch')).toBe(document);
  });
});

describe('ソリッドフィーチャーの履歴操作(FR-501、FR-503)', () => {
  it('足しても元の文書は変わらず、履歴の順序が保たれる', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const first = buildExtrude(withFace, faceRef);
    const afterFirst = appendSolid(withFace, first);
    const second = buildRevolve(afterFirst, faceRef);
    const afterSecond = appendSolid(afterFirst, second);
    expect(withFace.solids).toHaveLength(0);
    expect(afterFirst.solids).toHaveLength(1);
    expect(afterSecond.solids.map((solid) => solid.id)).toEqual([first.id, second.id]);
  });

  it('同じ id のフィーチャーは足さない(ボディの id が重ならない)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const feature = buildExtrude(withFace, faceRef);
    const added = appendSolid(withFace, feature);
    expect(appendSolid(added, feature)).toBe(added);
  });

  it('種類が混ざっても id は一意', () => {
    const { document: withFace, faceRef } = documentWithFace();
    let document = withFace;
    const extrude = buildExtrude(document, faceRef);
    document = appendSolid(document, extrude);
    document = appendSolid(document, buildRevolve(document, faceRef));
    document = appendSolid(document, buildSew(document, [faceRef, faceRef]));
    const union = buildBoolean(document, 'union', extrude.id, extrude.id);
    document = appendSolid(document, union);
    const ids = document.solids.map((solid) => solid.id);
    expect(ids).toEqual(['extrude-1', 'revolve-1', 'sew-1', 'union-1']);
    expect(new Set(ids).size).toBe(4);
  });

  it('差し替えは対象だけを変え、並び順は変わらない(抑制・改名もこれで行う)', () => {
    const { document, target, subtract } = documentWithSubtract();
    const suppressed: SolidFeature = { ...target, suppressed: true, name: '押し出し(止め)' };
    const after = replaceSolid(document, target.id, suppressed);
    expect(after.solids.map((solid) => solid.id)).toEqual(
      document.solids.map((solid) => solid.id),
    );
    expect(findSolid(after, target.id)).toEqual(suppressed);
    expect(findSolid(after, subtract.id)).toEqual(subtract);
    expect(findSolid(document, target.id)).toEqual(target);
    expect(replaceSolid(document, 'no-such-solid', suppressed)).toBe(document);
  });

  it('取り除いても残りの並びは変わらず、無い id なら元の文書のまま', () => {
    const { document, target, tool, subtract } = documentWithSubtract();
    const after = removeSolid(document, tool.id);
    expect(after.solids.map((solid) => solid.id)).toEqual([target.id, subtract.id]);
    expect(findSolid(after, tool.id)).toBeUndefined();
    expect(document.solids).toHaveLength(3);
    expect(removeSolid(document, 'no-such-solid')).toBe(document);
  });

  it('参照先を取り除いてもブーリアンは履歴に残る(解決のときに失敗させる、FR-504)', () => {
    const { document, target, subtract } = documentWithSubtract();
    const after = removeSolid(document, target.id);
    const remaining = findSolid(after, subtract.id);
    expect(remaining).toEqual(subtract);
    expect(remaining?.kind).toBe('boolean');
    if (remaining?.kind === 'boolean') {
      // 参照は id のままで、消えた相手を指し続ける(FR-311、FR-502)。
      expect(findSolid(after, remaining.targetFeatureId)).toBeUndefined();
    }
  });
});

describe('名前と id の採番(§0.a-0.19、FR-501)', () => {
  it('同じ種類の既存の最大連番+1(削除しても重ならない)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    expect(nextSolidName(withFace, 'extrude')).toBe('押し出し1');
    const first = buildExtrude(withFace, faceRef);
    const afterFirst = appendSolid(withFace, first);
    const second = buildExtrude(afterFirst, faceRef);
    const afterSecond = appendSolid(afterFirst, second);
    expect([first.name, second.name]).toEqual(['押し出し1', '押し出し2']);
    expect(nextSolidName(afterSecond, 'extrude')).toBe('押し出し3');
    expect(nextSolidId(afterSecond, 'extrude')).toBe('extrude-3');
    // 押し出し1 を消しても、残る 押し出し2 の次は 押し出し3。
    const removed = removeSolid(afterSecond, first.id);
    expect(nextSolidName(removed, 'extrude')).toBe('押し出し3');
    expect(nextSolidId(removed, 'extrude')).toBe('extrude-3');
    // 全部消せば 1 に戻る(重複する相手がいない)。
    const emptied = removeSolid(removed, second.id);
    expect(nextSolidName(emptied, 'extrude')).toBe('押し出し1');
    expect(nextSolidId(emptied, 'extrude')).toBe('extrude-1');
  });

  it('種類ごとに独立して数え、ブーリアンは演算ごとに別の連番', () => {
    const { document, target, tool } = documentWithSubtract();
    expect(SOLID_LABELS).toEqual({
      extrude: '押し出し',
      revolve: '回転',
      sew: '縫合',
      union: '和',
      subtract: '差',
      intersect: '積',
    });
    expect(findSolid(document, 'subtract-1')?.name).toBe('差1');
    expect(nextSolidName(document, 'subtract')).toBe('差2');
    expect(nextSolidName(document, 'union')).toBe('和1');
    expect(nextSolidName(document, 'intersect')).toBe('積1');
    expect(nextSolidName(document, 'revolve')).toBe('回転1');
    expect(nextSolidName(document, 'sew')).toBe('縫合1');
    expect(nextSolidName(document, 'extrude')).toBe('押し出し3');
    expect(buildBoolean(document, 'union', target.id, tool.id).id).toBe('union-1');
  });
});

describe('ソリッドフィーチャーの型(FR-202、FR-311)', () => {
  it('全パラメータは式と評価値のペアで、断面は id で参照する', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const extrude = buildExtrude(withFace, faceRef);
    expect(extrude.distance.source).toBe('5*2');
    expect(extrude.distance.value).toBe(10);
    expect(extrude.reversed).toBe(false);
    expect(extrude.symmetric).toBe(false);
    // 参照先が実在する(座標は複製しない)。
    const sketch = findSketch(withFace, extrude.profile.sketchId);
    expect(sketch).toBeDefined();
    expect(sketch === undefined ? undefined : findFeature(sketch, extrude.profile.faceFeatureId))
      .toBeDefined();
  });

  it('縫合の既定の許容量は 0.01 mm で、面を2枚以上並べる(§0.a-0.7)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    expect(DEFAULT_SEW_TOLERANCE_MM).toBe(0.01);
    const sew = buildSew(withFace, [faceRef, faceRef]);
    expect(sew.tolerance.value).toBe(0.01);
    expect(sew.faces).toHaveLength(2);
    expect(sew.faces.every((face) => face.sketchId === withFace.activeSketchId)).toBe(true);
  });

  it('回転軸はワールドの軸かスケッチの線分の2通り(§0.a-0.9)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const revolve = buildRevolve(withFace, faceRef);
    expect(revolve.axis).toEqual({ kind: 'world', axis: 'z' });
    expect(revolve.angle.value).toBe(360);

    const { document, lineRef } = addAxisLine(withFace);
    const onLine: RevolveFeature = { ...revolve, axis: { kind: 'line', line: lineRef } };
    expect(onLine.axis.kind).toBe('line');
    if (onLine.axis.kind === 'line') {
      const sketch = findSketch(document, onLine.axis.line.sketchId);
      expect(sketch).toBeDefined();
      const line =
        sketch === undefined ? undefined : findFeature(sketch, onLine.axis.line.lineFeatureId);
      expect(line?.kind).toBe('line');
    }
  });
});

describe('ボディの消費と、いま画面に出るボディ(§0.a-0.5)', () => {
  it('ブーリアンは対象と相手を消費し、自分だけが残る', () => {
    const { document, target, tool, subtract } = documentWithSubtract();
    expect([...consumedBodyIds(document)].sort()).toEqual([target.id, tool.id].sort());
    expect(liveBodyIds(document)).toEqual([subtract.id]);
  });

  it('ブーリアンが無ければ何も消費されず、履歴順に全部残る', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const first = buildExtrude(withFace, faceRef);
    const afterFirst = appendSolid(withFace, first);
    const second = buildRevolve(afterFirst, faceRef);
    const document = appendSolid(afterFirst, second);
    expect(consumedBodyIds(document).size).toBe(0);
    expect(liveBodyIds(document)).toEqual([first.id, second.id]);
  });

  it('抑制したフィーチャーはボディを作らず、抑制したブーリアンは何も消費しない(FR-503)', () => {
    const { document, target, tool, subtract } = documentWithSubtract();
    const suppressedBoolean = replaceSolid(document, subtract.id, {
      ...subtract,
      suppressed: true,
    });
    expect(consumedBodyIds(suppressedBoolean).size).toBe(0);
    expect(liveBodyIds(suppressedBoolean)).toEqual([target.id, tool.id]);

    const suppressedTool = replaceSolid(document, tool.id, { ...tool, suppressed: true });
    // 抑制された相手はボディが無いので消費されない(解決のときに missingBody になる)。
    expect([...consumedBodyIds(suppressedTool)]).toEqual([target.id]);
    expect(liveBodyIds(suppressedTool)).toEqual([subtract.id]);
  });

  it('消えた参照先は消費に数えず、ブーリアン自身は残る(FR-504)', () => {
    const { document, target, tool, subtract } = documentWithSubtract();
    const after = removeSolid(document, target.id);
    expect([...consumedBodyIds(after)]).toEqual([tool.id]);
    expect(liveBodyIds(after)).toEqual([subtract.id]);
  });

  it('履歴で自分より後ろのボディは消費できない(前方参照は無効)', () => {
    const { document: withFace, faceRef } = documentWithFace();
    const first = buildExtrude(withFace, faceRef);
    const afterFirst = appendSolid(withFace, first);
    const second = buildExtrude(afterFirst, faceRef, '4');
    const later = buildExtrude(appendSolid(afterFirst, second), faceRef, '6');
    // まだ足していない later を参照するブーリアンを、later より前に置く。
    const union = buildBoolean(afterFirst, 'union', first.id, later.id);
    const document = appendSolid(appendSolid(afterFirst, union), later);
    expect([...consumedBodyIds(document)]).toEqual([first.id]);
    expect(liveBodyIds(document)).toEqual([union.id, later.id]);
  });
});
