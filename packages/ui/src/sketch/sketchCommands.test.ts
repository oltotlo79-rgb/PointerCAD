import {
  createEmptySketchDocument,
  DEFAULT_FACE_COLOR,
  resolveSketch,
  type SketchDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS, t } from '../i18n/t.js';
import {
  commitNumericInput,
  createNumericInput,
  reduceNumericInput,
  type CoordinateMode,
  type NumericInputCommit,
  type NumericInputState,
  type NumericInputStep,
  type SketchToolId,
} from './numericInput.js';
import {
  boundaryElementKind,
  commitFace,
  commitSketchInput,
  continueFrom,
  toElementRef,
  type CommitContext,
} from './sketchCommands.js';

/** 欄へ数字を打ってから決定する。ポップアップと同じ道筋を通す。 */
function commitOf(state: NumericInputState, sources: readonly string[]): NumericInputCommit {
  let filled = state;
  sources.forEach((source, index) => {
    filled = reduceNumericInput(filled, { type: 'edit', index, source });
  });
  const transition = commitNumericInput(filled);
  if (transition.kind !== 'committed') {
    throw new Error(`確定できませんでした: ${transition.kind}`);
  }
  return transition.commit;
}

function contextOf(overrides: Partial<CommitContext> = {}): CommitContext {
  return {
    document: createEmptySketchDocument(),
    planeId: 'xy',
    chaining: false,
    pendingStart: null,
    ...overrides,
  };
}

/** 道具の 1 段階を決めて履歴へ反映する。段階をまたぐ検査を短く書くための小道具。 */
function step(
  context: CommitContext,
  toolId: SketchToolId,
  inputStep: NumericInputStep,
  mode: CoordinateMode,
  sources: readonly string[],
): CommitContext {
  const outcome = commitSketchInput(
    commitOf(createNumericInput(toolId, inputStep, mode), sources),
    context,
  );
  return { ...context, document: outcome.document, pendingStart: outcome.pendingStart };
}

/** 絶対座標の始点と終点で線分を 1 本作る。 */
function lineThrough(
  context: CommitContext,
  from: readonly [string, string, string],
  to: readonly [string, string, string],
): CommitContext {
  return step(
    step(context, 'line', 'lineStart', 'absolute', from),
    'line',
    'lineEnd',
    'absolute',
    to,
  );
}

function featureIds(document: SketchDocument): string[] {
  return document.features.map((feature) => feature.id);
}

describe('数値入力の結果から履歴を作る(FR-301〜309)', () => {
  it('点列の 1 点は `featureId#n`、それ以外はフィーチャーそのものを指す', () => {
    expect(toElementRef('pa1#2')).toEqual({ featureId: 'pa1', index: 2 });
    expect(toElementRef('point-1')).toEqual({ featureId: 'point-1' });
  });

  it('円弧と点列の欄は「半径・開始角・終了角」「角度・間隔・個数」の順に並ぶ', () => {
    // 欄の値は並び順で読むので、順番が変わったらこの検査で気づけるようにする。
    expect(createNumericInput('arc', 'arcShape').fields.map((field) => field.key)).toEqual([
      'radius',
      'startAngle',
      'endAngle',
    ]);
    expect(
      createNumericInput('pointArray', 'pointArrayShape').fields.map((field) => field.key),
    ).toEqual(['azimuth', 'spacing', 'count']);
  });

  it('点を作ると履歴が 1 つ増え、式も評価値も残る(FR-202、FR-301)', () => {
    const outcome = commitSketchInput(
      commitOf(createNumericInput('point', 'point'), ['1', '2+3', '4']),
      contextOf(),
    );
    expect(outcome.document.features).toHaveLength(1);
    expect(outcome.pendingStart).toBeNull();
    const resolved = resolveSketch(outcome.document);
    expect(resolved.points[0].position).toEqual([1, 5, 4]);
    expect(resolved.errors).toEqual([]);
    const feature = outcome.document.features[0];
    // 式そのものが履歴に残っている(FR-202)。
    expect(feature.kind === 'point' && feature.at.mode === 'absolute' ? feature.at.y.source : '')
      .toBe('2+3');
  });

  it('線分は始点→終点の 2 段階で 1 本になる(FR-304)', () => {
    const first = commitSketchInput(
      commitOf(createNumericInput('line', 'lineStart', 'absolute'), ['0', '0', '0']),
      contextOf(),
    );
    // 始点だけでは履歴へ積まない。
    expect(first.document.features).toHaveLength(0);
    expect(first.pendingStart).not.toBeNull();

    const second = commitSketchInput(
      commitOf(createNumericInput('line', 'lineEnd'), ['10', '0', '0']),
      contextOf({ document: first.document, pendingStart: first.pendingStart }),
    );
    const resolved = resolveSketch(second.document);
    expect(resolved.segments).toHaveLength(1);
    expect(resolved.segments[0].from).toEqual([0, 0, 0]);
    expect(resolved.segments[0].to).toEqual([10, 0, 0]);
    expect(resolved.errors).toEqual([]);
  });

  it('続けてかくなら、次の線は直前の線の終点から始まる(FR-307)', () => {
    const start = commitSketchInput(
      commitOf(createNumericInput('line', 'lineStart', 'absolute'), ['0', '0', '0']),
      contextOf({ chaining: true }),
    );
    const first = commitSketchInput(
      commitOf(createNumericInput('line', 'lineEnd'), ['10', '0', '0']),
      contextOf({ chaining: true, document: start.document, pendingStart: start.pendingStart }),
    );
    // 次の基準は「作ったばかりの線分の終点」を名指しする。
    expect(first.pendingStart).toEqual(continueFrom(featureIds(first.document)[0]));

    const second = commitSketchInput(
      commitOf(createNumericInput('line', 'lineEnd'), ['0', '10', '0']),
      contextOf({ chaining: true, document: first.document, pendingStart: first.pendingStart }),
    );
    const resolved = resolveSketch(second.document);
    expect(resolved.segments).toHaveLength(2);
    // 2 本目は 1 本目の終点 (10,0,0) から、そこから +Y に 10。
    expect(resolved.segments[1].from).toEqual([10, 0, 0]);
    expect(resolved.segments[1].to).toEqual([10, 10, 0]);
    expect(resolved.errors).toEqual([]);
  });

  it('続けてかくが切なら、次の基準を持ち越さない', () => {
    const start = commitSketchInput(
      commitOf(createNumericInput('line', 'lineStart', 'absolute'), ['0', '0', '0']),
      contextOf(),
    );
    const line = commitSketchInput(
      commitOf(createNumericInput('line', 'lineEnd'), ['10', '0', '0']),
      contextOf({ document: start.document, pendingStart: start.pendingStart }),
    );
    expect(line.pendingStart).toBeNull();
  });

  it('円弧は中心→形の 2 段階(FR-305)、点列は基準点→並べ方(FR-308)', () => {
    const arc = step(
      step(contextOf(), 'arc', 'arcCenter', 'absolute', ['0', '0', '0']),
      'arc',
      'arcShape',
      'absolute',
      ['10', '0', '360'],
    );
    const resolvedArc = resolveSketch(arc.document);
    expect(resolvedArc.arcs).toHaveLength(1);
    expect(resolvedArc.arcs[0].radius).toBe(10);
    expect(arc.pendingStart).toBeNull();

    const array = step(
      step(contextOf(), 'pointArray', 'pointArrayBase', 'absolute', ['0', '0', '0']),
      'pointArray',
      'pointArrayShape',
      'absolute',
      ['0', '10', '4'],
    );
    const resolvedArray = resolveSketch(array.document);
    expect(resolvedArray.points).toHaveLength(4);
    expect(resolvedArray.points[3].id).toBe(`${featureIds(array.document)[0]}#3`);
    expect(array.pendingStart).toBeNull();
  });

  it('前半を決めていないのに後半が来たら、壊れた形を作らずに何もしない', () => {
    const outcome = commitSketchInput(
      commitOf(createNumericInput('arc', 'arcShape'), ['10', '0', '90']),
      contextOf(),
    );
    expect(outcome.document.features).toEqual([]);
    expect(outcome.pendingStart).toBeNull();
  });
});

describe('選んだ要素から面を張る(FR-309、FR-310)', () => {
  it('要素が点か線かを見分ける', () => {
    const points = step(contextOf(), 'point', 'point', 'absolute', ['0', '0', '0']);
    const withLine = lineThrough(points, ['0', '0', '0'], ['10', '0', '0']);
    const resolved = resolveSketch(withLine.document);
    const [pointId, lineId] = featureIds(withLine.document);
    expect(boundaryElementKind(resolved, pointId)).toBe('point');
    expect(boundaryElementKind(resolved, lineId)).toBe('curve');
    expect(boundaryElementKind(resolved, 'このidはない')).toBe('unknown');
  });

  it('点を 3 つ選ぶと面が張れる。既定の色が付く(FR-310)', () => {
    let context = contextOf();
    for (const at of [['0', '0', '0'], ['10', '0', '0'], ['10', '10', '0']]) {
      context = step(context, 'point', 'point', 'absolute', at);
    }
    const outcome = commitFace(
      context.document,
      resolveSketch(context.document),
      'xy',
      featureIds(context.document),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const resolved = resolveSketch(outcome.document);
    expect(resolved.faces).toHaveLength(1);
    expect(resolved.faces[0].color).toBe(DEFAULT_FACE_COLOR);
    expect(resolved.errors).toEqual([]);
  });

  it('線を順に選んでも面が張れる。選んだ順がそのまま境界の順になる', () => {
    let context = lineThrough(contextOf(), ['0', '0', '0'], ['10', '0', '0']);
    context = lineThrough(context, ['10', '0', '0'], ['10', '10', '0']);
    context = lineThrough(context, ['10', '10', '0'], ['0', '0', '0']);
    const ids = featureIds(context.document);
    const outcome = commitFace(context.document, resolveSketch(context.document), 'xy', ids);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const face = outcome.document.features[outcome.document.features.length - 1];
    expect(face.kind === 'face' ? face.boundary : []).toEqual(
      ids.map((featureId) => ({ featureId })),
    );
    expect(resolveSketch(outcome.document).faces).toHaveLength(1);
  });

  it('点と線をまぜた選択は理由を返して断る(§0.a-0.13)', () => {
    const withPoint = step(contextOf(), 'point', 'point', 'absolute', ['0', '0', '0']);
    const context = lineThrough(withPoint, ['0', '0', '0'], ['10', '0', '0']);
    const outcome = commitFace(
      context.document,
      resolveSketch(context.document),
      'xy',
      featureIds(context.document),
    );
    expect(outcome).toEqual({ ok: false, reasonKey: 'face.error.mixedBoundary' });
    // 断ったときは履歴を変えない。
    expect(context.document.features).toHaveLength(2);
  });

  it('選択なし・点が足りない・面そのものの選択も理由を返して断る', () => {
    const empty = createEmptySketchDocument();
    expect(commitFace(empty, resolveSketch(empty), 'xy', [])).toEqual({
      ok: false,
      reasonKey: 'face.error.emptySelection',
    });

    let context = contextOf();
    for (const at of [['0', '0', '0'], ['10', '0', '0'], ['10', '10', '0']]) {
      context = step(context, 'point', 'point', 'absolute', at);
    }
    expect(
      commitFace(
        context.document,
        resolveSketch(context.document),
        'xy',
        featureIds(context.document).slice(0, 2),
      ),
    ).toEqual({ ok: false, reasonKey: 'face.error.tooFewPoints' });

    const withFace = commitFace(
      context.document,
      resolveSketch(context.document),
      'xy',
      featureIds(context.document),
    );
    if (!withFace.ok) {
      throw new Error('面を張れませんでした');
    }
    const faceId = featureIds(withFace.document)[3];
    expect(
      commitFace(withFace.document, resolveSketch(withFace.document), 'xy', [faceId]),
    ).toEqual({ ok: false, reasonKey: 'face.error.unsupportedElement' });
  });

  it('断る理由の文言は ja.json から引く(NFR-MA-5)', () => {
    for (const key of [
      'face.error.emptySelection',
      'face.error.mixedBoundary',
      'face.error.tooFewPoints',
      'face.error.unsupportedElement',
    ] as const) {
      expect(MESSAGE_KEYS).toContain(key);
      expect(t(key).length, key).toBeGreaterThan(0);
    }
  });
});
