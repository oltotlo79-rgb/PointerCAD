import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  collectVariables,
  createEmptySketchDocument,
  findFeature,
  resolveSketch,
  WORK_PLANES,
  type ConstraintTarget,
  type CoordinateInput,
  type SketchConstraint,
  type SketchDocument,
  type VariableSet,
  type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  commitDrag,
  dragRefusalMessageKey,
  dragTargetUv,
  draggableAt,
  isDraggable,
  solveWithDrag,
  type DragRefusalReason,
  type SketchDrag,
} from './dragSketch.js';

/**
 * 引っぱって形を変える(FR-313、計画書 docs/plans/P4b-スケッチの仕上げ.md タスク14)の検査。
 *
 * **どの欄を書き換えるかの取り違え**(P4 タスク14 の「頂点で終点を決めた線分が長さ 0 に
 * なる」不具合)を再発させないため、確定の検査では**触っていない欄が `===` で同じ**
 * ことまで確かめる。
 */

const num = expressionValueFromNumber;

function lineFeature(
  document: SketchDocument,
  id: string,
  from: CoordinateInput,
  to: CoordinateInput,
): SketchDocument {
  return appendFeature(document, {
    id,
    name: id,
    planeId: 'xy',
    kind: 'line',
    from,
    to,
    construction: false,
  });
}

function withConstraints(
  document: SketchDocument,
  constraints: readonly SketchConstraint[],
): SketchDocument {
  return { ...document, constraints };
}

/** 横 10mm の線分 1 本(両端とも数値リテラル = 動かせる)。 */
function oneLine(): SketchDocument {
  return lineFeature(
    createEmptySketchDocument(),
    'line-1',
    absoluteCoordinate(0, 0, 0),
    absoluteCoordinate(10, 0, 0),
  );
}

function variablesOf(document: SketchDocument): VariableSet {
  return collectVariables(document, resolveSketch(document), WORK_PLANES.xy);
}

function atVertex(featureId: string, vertex: 'start' | 'end' | 'center'): ConstraintTarget {
  return { kind: 'vertex', featureId, vertex };
}

/** 掴んだ場所は点そのものにする(掴みのずれを 0 にして、期待値を素直にする)。 */
function grab(document: SketchDocument, target: ConstraintTarget, uv: readonly [number, number]) {
  return draggableAt(document, variablesOf(document), target, uv);
}

function draggedOf(
  document: SketchDocument,
  target: ConstraintTarget,
  uv: readonly [number, number],
): SketchDrag {
  const outcome = grab(document, target, uv);
  if (!isDraggable(outcome)) {
    throw new Error('引っぱれるはずの点が掴めませんでした');
  }
  return outcome;
}

function refusalOf(
  document: SketchDocument,
  target: ConstraintTarget,
  uv: readonly [number, number] = [0, 0],
): DragRefusalReason {
  const outcome = grab(document, target, uv);
  if (outcome === null || isDraggable(outcome)) {
    throw new Error('断られるはずの点が掴めてしまいました');
  }
  return outcome.reason;
}

/** 解いてから確定するところまでを 1 度に行う(実際の離す操作と同じ順)。 */
function dragAndCommit(
  document: SketchDocument,
  drag: SketchDrag,
  target: readonly [number, number],
): SketchDocument {
  const solved = solveWithDrag(document, drag, target);
  // 画面(`attachSketchInteraction.finishDrag`)と同じ引数で呼ぶ。解いた形と作図面を
  // 渡すと、相対・極の欄は指定方法のまま書き戻る(P4b タスク22b)。
  return commitDrag(document, drag, solved.solution, solved.resolved, WORK_PLANES.xy);
}

function sourcesOf(document: SketchDocument, featureId: string, field: 'from' | 'to'): string[] {
  const feature = findFeature(document, featureId);
  if (feature === undefined || feature.kind !== 'line') {
    throw new Error(`線分 ${featureId} がありません`);
  }
  const at = feature[field];
  if (at.mode !== 'absolute') {
    throw new Error('絶対座標で書き戻されていません');
  }
  return [at.x.source, at.y.source, at.z.source];
}

describe('draggableAt(掴めるか、どの欄を書き換えるか)', () => {
  it('線分の始点は from の欄になる', () => {
    const drag = draggedOf(oneLine(), atVertex('line-1', 'start'), [0, 0]);
    expect(drag.pointKey).toBe('line-1:start');
    expect(drag.featureId).toBe('line-1');
    expect(drag.field).toBe('from');
    expect(drag.index).toBeNull();
    expect(drag.startUv).toEqual([0, 0]);
  });

  it('線分の終点は to の欄になる(始点と取り違えない)', () => {
    const drag = draggedOf(oneLine(), atVertex('line-1', 'end'), [10, 0]);
    expect(drag.pointKey).toBe('line-1:end');
    expect(drag.field).toBe('to');
    expect(drag.startUv).toEqual([10, 0]);
  });

  it('点フィーチャーは at の欄になる', () => {
    const document = appendFeature(createEmptySketchDocument(), {
      id: 'point-1',
      name: 'point-1',
      planeId: 'xy',
      kind: 'point',
      at: absoluteCoordinate(3, 4, 0),
    });
    const drag = draggedOf(document, { kind: 'point', pointId: 'point-1' }, [3, 4]);
    expect(drag.field).toBe('at');
    expect(drag.startUv).toEqual([3, 4]);
  });

  it('円弧の中心は center の欄になる', () => {
    const document = appendFeature(createEmptySketchDocument(), {
      id: 'arc-1',
      name: 'arc-1',
      planeId: 'xy',
      kind: 'arc',
      center: absoluteCoordinate(2, 2, 0),
      radius: num(5),
      startAngle: num(0),
      endAngle: num(90),
      construction: false,
    });
    const drag = draggedOf(document, atVertex('arc-1', 'center'), [2, 2]);
    expect(drag.field).toBe('center');
    expect(drag.featureId).toBe('arc-1');
  });

  it('円弧の端は引っぱれない(中心と半径から決まるため)', () => {
    const document = appendFeature(createEmptySketchDocument(), {
      id: 'arc-1',
      name: 'arc-1',
      planeId: 'xy',
      kind: 'arc',
      center: absoluteCoordinate(0, 0, 0),
      radius: num(5),
      startAngle: num(0),
      endAngle: num(90),
      construction: false,
    });
    expect(refusalOf(document, atVertex('arc-1', 'start'))).toBe('arcEndpoint');
  });

  it('スプラインの n 番目は splinePoint と番号になる', () => {
    const document = appendFeature(createEmptySketchDocument(), {
      id: 'spline-1',
      name: 'spline-1',
      planeId: 'xy',
      kind: 'spline',
      mode: 'interpolate',
      points: [
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(5, 5, 0),
        absoluteCoordinate(10, 0, 0),
      ],
      closed: false,
      construction: false,
    });
    const drag = draggedOf(document, { kind: 'point', pointId: 'spline-1#1' }, [5, 5]);
    expect(drag.field).toBe('splinePoint');
    expect(drag.index).toBe(1);
  });

  it('式で書かれた座標は引っぱれない(理由は expression)', () => {
    const withExpression: ExpressionValue = { source: '5 + 5', value: 10, display: '10' };
    const document = lineFeature(
      createEmptySketchDocument(),
      'line-1',
      { mode: 'absolute', x: withExpression, y: num(0), z: num(0) },
      absoluteCoordinate(20, 0, 0),
    );
    expect(refusalOf(document, atVertex('line-1', 'start'))).toBe('expression');
  });

  it('「固定」拘束の付いた点は引っぱれない(理由は fixed)', () => {
    const document = withConstraints(oneLine(), [
      { id: 'fix-1', name: '固定1', kind: 'fix', target: atVertex('line-1', 'start') },
    ]);
    expect(refusalOf(document, atVertex('line-1', 'start'))).toBe('fixed');
  });

  it('点列の点は引っぱれない(理由は derived)', () => {
    const document = appendFeature(createEmptySketchDocument(), {
      id: 'array-1',
      name: 'array-1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'linear',
        base: absoluteCoordinate(0, 0, 0),
        azimuth: num(0),
        spacing: num(5),
        count: num(3),
      },
    });
    expect(refusalOf(document, { kind: 'point', pointId: 'array-1#1' })).toBe('derived');
  });

  it('線そのもの(曲線)を指しても掴まない', () => {
    const document = oneLine();
    const outcome = grab(document, { kind: 'curve', element: { featureId: 'line-1' } }, [5, 0]);
    expect(outcome).toBeNull();
  });

  it('実在しない点は掴まない', () => {
    const document = oneLine();
    expect(grab(document, atVertex('line-9', 'start'), [0, 0])).toBeNull();
  });

  it('理由ごとに帯の文言が決まっている(6 種すべて)', () => {
    expect(dragRefusalMessageKey('expression')).toBe('drag.error.expression');
    expect(dragRefusalMessageKey('fixed')).toBe('drag.error.fixed');
    expect(dragRefusalMessageKey('relative')).toBe('drag.error.relative');
    expect(dragRefusalMessageKey('derived')).toBe('drag.error.derived');
    expect(dragRefusalMessageKey('arcEndpoint')).toBe('drag.error.arcEndpoint');
    expect(dragRefusalMessageKey('freeSketch')).toBe('drag.error.freeSketch');
  });
});

describe('dragTargetUv(掴んだずれを保つ)', () => {
  it('点の真上を掴んだときは、ポインタの位置がそのまま目標になる', () => {
    const drag = draggedOf(oneLine(), atVertex('line-1', 'end'), [10, 0]);
    expect(dragTargetUv(drag, [14, 6])).toEqual([14, 6]);
  });

  it('少しずれて掴んだときは、そのずれを保ったまま動く(点が指へ飛びつかない)', () => {
    // 点は (10, 0) で、掴んだのは (11, 1)。ポインタが (14, 6) なら目標は (13, 5)。
    const drag = draggedOf(oneLine(), atVertex('line-1', 'end'), [11, 1]);
    expect(dragTargetUv(drag, [14, 6])).toEqual([13, 5]);
  });
});

describe('solveWithDrag(引っぱっている間の形)', () => {
  /** 水平拘束を付けた線分 1 本。 */
  function horizontalLine(): SketchDocument {
    return withConstraints(oneLine(), [
      { id: 'h-1', name: '水平1', kind: 'horizontal', target: { kind: 'curve', element: { featureId: 'line-1' } } },
    ]);
  }

  it('水平拘束を保ったまま追従する', () => {
    const document = horizontalLine();
    const drag = draggedOf(document, atVertex('line-1', 'end'), [10, 0]);
    const solved = solveWithDrag(document, drag, [14, 6]);
    const end = solved.solution.get('line-1:end');
    const start = solved.solution.get('line-1:start');
    expect(end?.[0]).toBeCloseTo(14, 6);
    // 水平(2 点の縦が等しい)が保たれている。
    expect(end?.[1]).toBeCloseTo(start?.[1] ?? Number.NaN, 6);
  });

  it('引っぱっている間、文書は 1 か所も変わらない(取り消しの段が増えない)', () => {
    const document = horizontalLine();
    const before = findFeature(document, 'line-1');
    const drag = draggedOf(document, atVertex('line-1', 'end'), [10, 0]);
    solveWithDrag(document, drag, [14, 6]);
    expect(findFeature(document, 'line-1')).toBe(before);
  });

  it('拘束が 0 個のスケッチでも点が動く(連立は解かない)', () => {
    const document = oneLine();
    const drag = draggedOf(document, atVertex('line-1', 'end'), [10, 0]);
    const solved = solveWithDrag(document, drag, [4, 8]);
    expect(solved.outcome).toBeNull();
    expect(solved.solution.get('line-1:end')?.[0]).toBeCloseTo(4, 9);
    expect(solved.solution.get('line-1:end')?.[1]).toBeCloseTo(8, 9);
    // 引っぱっていない側は上書きされない。
    expect(solved.solution.has('line-1:start')).toBe(false);
  });
});

describe('commitDrag(離したときの書き戻し)', () => {
  it('線分の終点を引いたら to だけが変わり、from は === で同じ(過去の失敗の再発防止)', () => {
    const document = oneLine();
    const before = findFeature(document, 'line-1');
    const drag = draggedOf(document, atVertex('line-1', 'end'), [10, 0]);
    const next = dragAndCommit(document, drag, [14, 6]);
    const after = findFeature(next, 'line-1');
    if (before?.kind !== 'line' || after?.kind !== 'line') {
      throw new Error('線分ではありません');
    }
    expect(after.from).toBe(before.from);
    expect(after.to).not.toBe(before.to);
    expect(sourcesOf(next, 'line-1', 'to')).toEqual(['14', '6', '0']);
  });

  it('線分の始点を引いたら from だけが変わり、to は === で同じ', () => {
    const document = oneLine();
    const before = findFeature(document, 'line-1');
    const drag = draggedOf(document, atVertex('line-1', 'start'), [0, 0]);
    const next = dragAndCommit(document, drag, [-3, 5]);
    const after = findFeature(next, 'line-1');
    if (before?.kind !== 'line' || after?.kind !== 'line') {
      throw new Error('線分ではありません');
    }
    expect(after.to).toBe(before.to);
    expect(sourcesOf(next, 'line-1', 'from')).toEqual(['-3', '5', '0']);
  });

  it('書き戻す座標は丸めない(exactExpressionValueFromNumber)', () => {
    const document = oneLine();
    const drag = draggedOf(document, atVertex('line-1', 'end'), [10, 0]);
    // 有効数字 12 桁へ丸めると落ちる桁を持つ値。
    const next = dragAndCommit(document, drag, [1.2345678901234567, 0]);
    expect(sourcesOf(next, 'line-1', 'to')[0]).toBe('1.2345678901234567');
  });

  it('数で書いた相対座標の点は掴める(統括の決定 2026-09-05、案 A。タスク22b)', () => {
    /*
      **仕様変更**: 線分の道具の既定は「終点は直前の点からの相対」なので、ふつうに引いた
      線分の終点はここへ来る(2026-09-05 のヘッドレス実測)。以前は model が相対・極を
      点列などとまとめて `derived` と言うため掴めなかったが、統括の決定(案 A)で
      **数で書かれた相対・極も変数**になり、書き戻しは Δ のまま行うようになった。
    */
    const document = lineFeature(oneLine(), 'line-2', absoluteCoordinate(0, 5, 0), {
      mode: 'relative',
      base: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
      dx: num(2),
      dy: num(3),
      dz: num(0),
    });
    const outcome = grab(document, atVertex('line-2', 'end'), [12, 3]);
    expect(isDraggable(outcome)).toBe(true);
  });

  it('式で書いた相対座標の点は掴めず、expression を返す', () => {
    const document = lineFeature(oneLine(), 'line-2', absoluteCoordinate(0, 5, 0), {
      mode: 'relative',
      base: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
      dx: { source: '1 + 1', value: 2, display: '2' },
      dy: num(3),
      dz: num(0),
    });
    expect(refusalOf(document, atVertex('line-2', 'end'))).toBe('expression');
  });

  it('ふつうに引いた線分(終点が相対)は、相対の delta のまま書き戻る(タスク22b)', () => {
    /*
      線分の道具の既定は「終点は直前の点からの相対」。引っぱった後も**指定方法は相対のまま**
      で、delta =(解いた位置 - 基準の位置)だけが新しくなる(統括の決定 2026-09-05、案 A)。
      基準(直前の点)は、線分の終点ではその線分の始点(`resolveSketch.ts` の規約)。
    */
    const document = lineFeature(
      createEmptySketchDocument(),
      'line-1',
      absoluteCoordinate(0, 0, 0),
      { mode: 'relative', base: { kind: 'previous' }, dx: num(10), dy: num(0), dz: num(0) },
    );
    const drag = draggedOf(document, atVertex('line-1', 'end'), [10, 0]);
    const next = dragAndCommit(document, drag, [14, 3]);
    const after = findFeature(next, 'line-1');
    if (after?.kind !== 'line' || after.to.mode !== 'relative') {
      throw new Error('相対のまま書き戻っていません');
    }
    // 始点は (0, 0, 0) のままなので delta はそのまま新しい位置。
    expect([after.to.dx.source, after.to.dy.source, after.to.dz.source]).toEqual(['14', '3', '0']);
    // 基準の指し先も、始点の欄も触っていない。
    expect(after.to.base).toEqual({ kind: 'previous' });
    expect(after.from).toBe(document.features[0].kind === 'line' ? document.features[0].from : null);
  });

  it('極(距離+角度)で書いた点は、距離と角度のまま書き戻る(角度は度、丸めない)', () => {
    const document = lineFeature(
      createEmptySketchDocument(),
      'line-1',
      absoluteCoordinate(0, 0, 0),
      {
        mode: 'polar',
        base: { kind: 'previous' },
        distance: num(10),
        azimuth: num(0),
        elevation: num(0),
      },
    );
    const drag = draggedOf(document, atVertex('line-1', 'end'), [10, 0]);
    // (0, 20) へ引っぱる = 始点から 20mm、90 度。
    const next = dragAndCommit(document, drag, [0, 20]);
    const after = findFeature(next, 'line-1');
    if (after?.kind !== 'line' || after.to.mode !== 'polar') {
      throw new Error('極のまま書き戻っていません');
    }
    expect(after.to.distance.value).toBeCloseTo(20, 9);
    expect(after.to.azimuth.value).toBeCloseTo(90, 9);
    expect(after.to.elevation.value).toBeCloseTo(0, 9);
  });

  it('解いた形を渡さなければ、従来どおり絶対座標で書き戻る(既存の呼び出しの互換)', () => {
    const document = lineFeature(
      createEmptySketchDocument(),
      'line-1',
      absoluteCoordinate(0, 0, 0),
      { mode: 'relative', base: { kind: 'previous' }, dx: num(10), dy: num(0), dz: num(0) },
    );
    const drag = draggedOf(document, atVertex('line-1', 'end'), [10, 0]);
    const next = commitDrag(document, drag, solveWithDrag(document, drag, [14, 3]).solution);
    expect(sourcesOf(next, 'line-1', 'to')).toEqual(['14', '3', '0']);
  });

  it('点フィーチャーは at だけが変わる', () => {
    const document = appendFeature(createEmptySketchDocument(), {
      id: 'point-1',
      name: 'point-1',
      planeId: 'xy',
      kind: 'point',
      at: absoluteCoordinate(3, 4, 0),
    });
    const drag = draggedOf(document, { kind: 'point', pointId: 'point-1' }, [3, 4]);
    const after = findFeature(dragAndCommit(document, drag, [7, 1]), 'point-1');
    if (after?.kind !== 'point' || after.at.mode !== 'absolute') {
      throw new Error('点ではありません');
    }
    expect([after.at.x.source, after.at.y.source]).toEqual(['7', '1']);
  });

  it('スプラインは引いた 1 点だけが変わり、他の点は === で同じ', () => {
    const document = appendFeature(createEmptySketchDocument(), {
      id: 'spline-1',
      name: 'spline-1',
      planeId: 'xy',
      kind: 'spline',
      mode: 'interpolate',
      points: [
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(5, 5, 0),
        absoluteCoordinate(10, 0, 0),
      ],
      closed: false,
      construction: false,
    });
    const before = findFeature(document, 'spline-1');
    const drag = draggedOf(document, { kind: 'point', pointId: 'spline-1#1' }, [5, 5]);
    const after = findFeature(dragAndCommit(document, drag, [6, 9]), 'spline-1');
    if (before?.kind !== 'spline' || after?.kind !== 'spline') {
      throw new Error('スプラインではありません');
    }
    expect(after.points[0]).toBe(before.points[0]);
    expect(after.points[2]).toBe(before.points[2]);
    const moved = after.points[1];
    if (moved.mode !== 'absolute') {
      throw new Error('絶対座標ではありません');
    }
    expect([moved.x.source, moved.y.source]).toEqual(['6', '9']);
  });

  it('拘束につられて動いた点は書き戻さない(引っぱった点だけ)', () => {
    const document = withConstraints(oneLine(), [
      { id: 'h-1', name: '水平1', kind: 'horizontal', target: { kind: 'curve', element: { featureId: 'line-1' } } },
    ]);
    const before = findFeature(document, 'line-1');
    const drag = draggedOf(document, atVertex('line-1', 'end'), [10, 0]);
    const next = dragAndCommit(document, drag, [14, 6]);
    const after = findFeature(next, 'line-1');
    if (before?.kind !== 'line' || after?.kind !== 'line') {
      throw new Error('線分ではありません');
    }
    // 始点は水平拘束につられて縦へ動くが、**文書は (0, 0) のまま**。
    // 開き直せば同じ拘束から同じ形へ解き直る(rules/04「導出できるものは保存しない」)。
    expect(after.from).toBe(before.from);
  });

  it('解の表にその点が無ければ文書をそのまま返す', () => {
    const document = oneLine();
    const drag = draggedOf(document, atVertex('line-1', 'end'), [10, 0]);
    const empty: ReadonlyMap<string, Vec3> = new Map<string, Vec3>();
    expect(commitDrag(document, drag, empty)).toBe(document);
  });

  it('消えたフィーチャーを指していたら文書をそのまま返す', () => {
    const document = oneLine();
    const drag = draggedOf(document, atVertex('line-1', 'end'), [10, 0]);
    const solution: ReadonlyMap<string, Vec3> = new Map<string, Vec3>([
      ['line-1:end', [1, 2, 0]],
    ]);
    const withoutLine = { ...document, features: [] };
    expect(commitDrag(withoutLine, drag, solution)).toBe(withoutLine);
  });
});

describe('isDraggable', () => {
  it('掴めたときだけ真', () => {
    const drag = draggedOf(oneLine(), atVertex('line-1', 'end'), [10, 0]);
    expect(isDraggable(drag)).toBe(true);
    expect(isDraggable(null)).toBe(false);
    expect(isDraggable({ reason: 'fixed' })).toBe(false);
  });
});
