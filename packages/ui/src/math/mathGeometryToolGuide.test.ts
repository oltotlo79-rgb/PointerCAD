/**
 * 道具「図形の測定値」を先に押したときの段階の案内(GR-26、利用者の回答 Q11=P2、
 * 計画書 scratchpad/claude/plans/geomref-plan.md §4(a)・§5.2 GR-26)。
 *
 * 再計算は偽物(`createFakeRecompute`)を本物の `attachPartRecompute` へつなぎ、世代・ボディ・
 * 解決済みスケッチは製品と同じ経路でストアへ入れる。選ぶたびに段が進み・外すと戻ること、
 * 形の計算中、部品以外では出ないこと、状態欄の 1 文での優先順位(加工の道具の案内と同じ高さで
 * 重ならない)を確かめる。描画(`StatusBar.tsx`)は Node で検査できないので、状態欄へ渡す
 * 1 文は `StatusBar.tsx` と同じ組み立て(`mathGeometryToolGuide` → `mathGeometryToolGuideText`)で作る。
 */
import {
  appendSolid,
  createAssemblyDocument,
  createDrawingDocument,
  type PartDocument,
  type ReferenceFeature,
  type SolidBody,
  type SolidEdgeEntry,
  type SolidFaceEntry,
  type Vec3,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { describeStatus, guideKeyFor, machiningGuideText, type StatusInput } from '../shell/statusText.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
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
import { currentMathGeometry } from './mathGeometryResults.js';
import { mathGeometryCandidateRows } from './mathGeometryRows.js';
import {
  MATH_GEOMETRY_TOOL_GUIDE_KEYS,
  mathGeometryToolGuide,
  mathGeometryToolGuideText,
  type MathGeometryToolGuideStage,
} from './mathGeometryToolGuide.js';

/* ---------------------------------------------------------------------------
 * 形の材料(立体 2 つ。どちらも体積を測れる立体で、直線の辺を 2 本ずつ持つ)
 * ------------------------------------------------------------------------- */

function faceEntry(index: number, centroid: Vec3): SolidFaceEntry {
  return { index, surfaceKind: 'plane', area: 600, centroid, axis: [0, 0, 1], radius: null,
    triangleOffset: 0, triangleCount: 2 };
}

function lineEdge(index: number, start: Vec3, end: Vec3): SolidEdgeEntry {
  const midpoint: Vec3 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2];
  const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
  const axis: Vec3 = [(end[0] - start[0]) / length, (end[1] - start[1]) / length, (end[2] - start[2]) / length];
  return { index, curveKind: 'line', length, midpoint, start, end, axis, radius: null,
    segmentOffset: 0, segmentCount: 1 };
}

function solidBody(featureId: string): SolidBody {
  return {
    featureId,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 },
    volume: 24000,
    isValid: true,
    bodyKind: 'solid',
    faces: [faceEntry(0, [10, 15, 0]), faceEntry(1, [10, 15, 40])],
    edges: [lineEdge(0, [0, 0, 0], [20, 0, 0]), lineEdge(1, [0, 0, 0], [0, 30, 0])],
    vertices: [{ index: 0, position: [0, 0, 0] }, { index: 1, position: [20, 0, 0] }],
    threadMarks: [],
  };
}

/** 押し出し 2 段(押し出し1・押し出し2)と、点 1 つのスケッチを持つ部品。 */
function partWithTwoSolids(): PartDocument {
  return appendSolid(appendSolid(partWithPoint(), extrudeFeature('extrude-1')), extrudeFeature('extrude-2'));
}

const BODY_1 = 'extrude-1';
const BODY_2 = 'extrude-2';
const EDGE_1 = subShapeElementId(BODY_1, 'edge', 0);
const EDGE_2 = subShapeElementId(BODY_1, 'edge', 1);
const FRAME_ID = 'frame-1';

/**
 * partWithTwoSolids に、基準座標系を1つ足したもの(GR-22b: 「点+座標系」で状態欄の案内の件数が
 * 一覧(mathGeometryRows.ts の mathGeometryCandidateRows)の候補数と一致することを確かめる用)。
 * 座標系の原点は最初のスケッチの点を指すが、mathGeometrySelection は選択された id と
 * references の中の種類しか見ないので、原点が有効な点かどうかはこの検査の判断に関わらない。
 */
function partWithTwoSolidsAndFrame(): PartDocument {
  const base = partWithTwoSolids();
  const pointFeatureId = base.sketches[0]?.features[0]?.id ?? '';
  const frame: ReferenceFeature = {
    kind: 'referenceCoordinateSystem', id: FRAME_ID, name: '座標系1', visible: true,
    origin: { kind: 'point', pointId: pointFeatureId },
    xAxis: { kind: 'world', axis: 'x' }, yAxis: { kind: 'world', axis: 'y' },
  };
  return { ...base, references: [frame] };
}

/** 計算した文書に、立体 2 つを返す結果(図形の測定値の定義は無い)。 */
function settleWithBodies(call: PendingRecompute): void {
  call.settle({
    ...resultFor(call.document),
    generation: call.options.generation ?? 0,
    bodies: [solidBody(BODY_1), solidBody(BODY_2)],
  });
}

const detachers: (() => void)[] = [];

function attachFake(): ReturnType<typeof createFakeRecompute> {
  const fake = createFakeRecompute();
  detachers.push(attachPartRecompute(fake.recompute));
  return fake;
}

/** 部品を開いて最初の計算(世代1)を終えた状態。道具はまだ押していない。既定は立体2つの部品。 */
async function openedPart(document: PartDocument = partWithTwoSolids()): Promise<ReturnType<typeof createFakeRecompute>> {
  useAppStore.getState().resetDocument(document);
  const fake = attachFake();
  settleWithBodies(fake.calls[0]);
  await tick();
  expect(currentMathGeometry(useAppStore.getState()).status).toBe('current');
  return fake;
}

/** 部品を開き、何も選ばずに道具「図形の測定値」を押した状態(道具が先、P2)。 */
async function toolFirst(document?: PartDocument): Promise<ReturnType<typeof createFakeRecompute>> {
  const fake = await openedPart(document);
  useAppStore.getState().setSelection([]);
  useAppStore.getState().setActiveTool('mathGeometry');
  return fake;
}

/** 解決済みスケッチの点 1 つの id(スケッチの点を選ぶのに使う)。 */
function sketchPointId(): string {
  const point = useAppStore.getState().resolvedSketch.points.at(0);
  if (point === undefined) {
    throw new Error('解決済みスケッチに点がありません');
  }
  return point.id;
}

function stageNow(): MathGeometryToolGuideStage | null {
  return mathGeometryToolGuide(useAppStore.getState())?.stage ?? null;
}

/** 状態欄へ渡す 1 文(`StatusBar.tsx` と同じ組み立て)。 */
function guideTextNow(): string | null {
  const guide = mathGeometryToolGuide(useAppStore.getState());
  return guide === null ? null : mathGeometryToolGuideText(guide);
}

function countNow(): string | undefined {
  return mathGeometryToolGuide(useAppStore.getState())?.values.count;
}

/** 形の欄(立体の並び)を変えた文書を適用する。`coalesceKey` はプロパティ欄の 1 文字ごとの変更。 */
function changeShape(id: string, coalesceKey?: string): void {
  const next = appendSolid(useAppStore.getState().document, extrudeFeature(id));
  useAppStore.getState().applyDocument(next, coalesceKey === undefined ? undefined : { coalesceKey });
}

/** 状態欄の材料で、何も起きていないもの(statusText.test.ts の `quiet` と同じ既定)。 */
function quiet(): StatusInput {
  return {
    fileMessage: null,
    faceErrorKey: null,
    solidErrorKey: null,
    errorMessage: null,
    partErrors: [],
    sketchErrors: [],
    cancelled: false,
    progress: null,
    isComputing: false,
    kernelLoaded: true,
    snapKind: null,
    activeTool: 'select',
    selectedBodyCount: 0,
    selectedSubShapeCount: 0,
    selectionKind: 'body',
    springOriginSelected: false,
    springStep: null,
  };
}

const READY_TWO = '2件の量を測れます。「測る量」を選んで「選択から追加」を押してください。';

const drawingSource = {
  sourceRef: 'source-1',
  sourceKind: 'part',
  fileName: 'box.pcad',
  path: '',
  contentHash: 'hash',
  importedAt: '2026-09-09T00:00:00.000Z',
} as const;

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

describe('道具が先のときの段(mathGeometryToolGuide)', () => {
  it('道具が有効でなければ、選んでいても案内を出さない(null)', async () => {
    await openedPart();
    useAppStore.getState().setSelection([BODY_1]);
    expect(useAppStore.getState().activeTool).toBe('select');
    expect(mathGeometryToolGuide(useAppStore.getState())).toBeNull();

    useAppStore.getState().setActiveTool('measure');
    useAppStore.getState().setSelection([BODY_1]);
    expect(mathGeometryToolGuide(useAppStore.getState())).toBeNull();
  });

  it('段0: 何も選ばずに押すと、何を選べばよいかを案内する(道具の基本案内と同じ文)', async () => {
    await toolFirst();
    const guide = mathGeometryToolGuide(useAppStore.getState());
    expect(guide).toEqual({ stage: 'nothingSelected', key: 'statusBar.guide.mathGeometry', values: {} });
    expect(guideTextNow()).toBe(
      '測りたい点・辺・面・立体を選んでください。1つで座標・長さ・面積・体積、2つで距離・角度、3つの点で角度を測れます。',
    );
    // 状態欄がこの欄を受け取らないときの後退先(GUIDE_KEYS.mathGeometry)と同じ文。
    expect(guideTextNow()).toBe(t(guideKeyFor('mathGeometry', 0)));
  });

  it('段1: 立体を 1 つ選ぶと、体積と面積の 2 件を測れると案内する', async () => {
    await toolFirst();
    useAppStore.getState().setSelection([BODY_1]);
    expect(mathGeometryToolGuide(useAppStore.getState())).toEqual({
      stage: 'ready',
      key: 'mathGeometry.guide.ready',
      values: { count: '2' },
    });
    expect(guideTextNow()).toBe(READY_TWO);
  });

  it('段1の件数は選んだものの候補の数(スケッチの点は座標 3 件、直線の辺 2 本は距離と角度・平行・垂直・合同・相似の 6 件)', async () => {
    await toolFirst();
    useAppStore.getState().setSelection([sketchPointId()]);
    expect(stageNow()).toBe('ready');
    expect(countNow()).toBe('3');
    expect(guideTextNow()).toBe('3件の量を測れます。「測る量」を選んで「選択から追加」を押してください。');

    useAppStore.getState().setSelection([EDGE_1, EDGE_2]);
    expect(stageNow()).toBe('ready');
    expect(countNow()).toBe('6');
    expect(guideTextNow()).not.toContain('{count}');
  });

  it('段1の件数は「点+基準座標系」でも一覧(mathGeometryCandidateRows)の候補数と一致する(座標系付きの X・Y・Z の 3 件、GR-22b)', async () => {
    await toolFirst(partWithTwoSolidsAndFrame());
    useAppStore.getState().setSelection([sketchPointId(), FRAME_ID]);
    expect(stageNow()).toBe('ready');
    expect(countNow()).toBe('3');
    expect(guideTextNow()).toBe('3件の量を測れます。「測る量」を選んで「選択から追加」を押してください。');
    expect(mathGeometryCandidateRows(useAppStore.getState())).toHaveLength(3);
  });

  it('選ぶたびに段が進み、外すと同じ道筋で戻る', async () => {
    await toolFirst();
    const point = sketchPointId();
    const steps: [string, MathGeometryToolGuideStage | null, string | undefined][] = [];
    const record = (label: string): void => {
      steps.push([label, stageNow(), countNow()]);
    };
    const toggle = (id: string): void => {
      useAppStore.getState().toggleSelection(id);
    };

    record('なし');
    toggle(BODY_1);
    record('立体1');
    toggle(BODY_2);
    record('立体1+立体2');
    toggle(point);
    record('3つ');
    toggle(EDGE_1);
    record('4つ');
    toggle(EDGE_1);
    record('3つへ戻す');
    toggle(point);
    record('2つへ戻す');
    toggle(BODY_2);
    record('1つへ戻す');
    toggle(BODY_1);
    record('なしへ戻す');

    expect(steps).toEqual([
      ['なし', 'nothingSelected', undefined],
      ['立体1', 'ready', '2'],
      // 2 つの立体の間は最短距離の 1 件。
      ['立体1+立体2', 'ready', '1'],
      // 3 つの選択(3 点の角度)は GR-22 までは対応する量が無い。
      ['3つ', 'unsupportedPair', undefined],
      ['4つ', 'tooMany', undefined],
      ['3つへ戻す', 'unsupportedPair', undefined],
      ['2つへ戻す', 'ready', '1'],
      ['1つへ戻す', 'ready', '2'],
      ['なしへ戻す', 'nothingSelected', undefined],
    ]);
  });

  it('選んだ組に対応する量が無ければ、その理由を案内する(スケッチの点と立体、見つからない要素)', async () => {
    await toolFirst();
    useAppStore.getState().setSelection([sketchPointId(), BODY_1]);
    expect(stageNow()).toBe('unsupportedPair');
    expect(guideTextNow()).toBe('選んだ組み合わせから測れる量がありません。');

    useAppStore.getState().setSelection(['feature-that-does-not-exist']);
    expect(stageNow()).toBe('unsupportedPair');
  });

  it('4 つ以上選ぶと「選ぶのは3つまでです。」', async () => {
    await toolFirst();
    useAppStore.getState().setSelection([BODY_1, BODY_2, EDGE_1, EDGE_2]);
    expect(mathGeometryToolGuide(useAppStore.getState())).toEqual({
      stage: 'tooMany',
      key: 'mathGeometry.disabled.tooMany',
      values: {},
    });
    expect(guideTextNow()).toBe('選ぶのは3つまでです。');
  });

  it('形の計算中は「形の計算が終わってから追加してください。」、その世代が終わると段1へ戻る', async () => {
    const fake = await toolFirst();
    useAppStore.getState().setSelection([BODY_1]);
    expect(guideTextNow()).toBe(READY_TWO);

    changeShape('extrude-3');
    expect(fake.calls).toHaveLength(2);
    expect(currentMathGeometry(useAppStore.getState()).status).toBe('computing');
    expect(mathGeometryToolGuide(useAppStore.getState())).toEqual({
      stage: 'computing',
      key: 'mathGeometry.disabled.computing',
      values: {},
    });
    expect(guideTextNow()).toBe('形の計算が終わってから追加してください。');

    settleWithBodies(fake.calls[1]);
    await tick();
    expect(currentMathGeometry(useAppStore.getState()).status).toBe('current');
    expect(guideTextNow()).toBe(READY_TWO);
  });

  it('計算中でも、何も選んでいなければ段0、選びすぎなら選びすぎを先に出す(選択だけで決まる次の一手)', async () => {
    await toolFirst();
    changeShape('extrude-3');
    expect(currentMathGeometry(useAppStore.getState()).status).toBe('computing');

    expect(stageNow()).toBe('nothingSelected');
    useAppStore.getState().setSelection([BODY_1, BODY_2, EDGE_1, EDGE_2]);
    expect(stageNow()).toBe('tooMany');
    // 形から作る判断(組の可否・件数)は計算中は古い形に基づくので、計算中の文を先に出す。
    useAppStore.getState().setSelection([sketchPointId(), BODY_1]);
    expect(stageNow()).toBe('computing');
    useAppStore.getState().setSelection([BODY_1]);
    expect(stageNow()).toBe('computing');
  });

  it('取消・履歴の途中表示では計算中の文にせず、選択の段を出す(値を出せないだけで、追加は計算し直す)', async () => {
    const fake = await toolFirst();
    useAppStore.getState().setSelection([BODY_1]);
    changeShape('extrude-3');
    useAppStore.getState().cancelRecompute();
    fake.calls[1].settle({ ...resultFor(fake.calls[1].document), generation: 2, cancelled: true });
    await tick();
    expect(currentMathGeometry(useAppStore.getState()).status).toBe('cancelled');
    expect(stageNow()).toBe('ready');
    expect(guideTextNow()).toBe(READY_TWO);

    useAppStore.getState().setTimelineIndex(0);
    expect(currentMathGeometry(useAppStore.getState()).status).toBe('timeline');
    expect(stageNow()).toBe('ready');
  });

  it.each(['assembly', 'drawing'] as const)('%s を開いている間は、道具が残っていても案内を出さない', async (kind) => {
    await toolFirst();
    useAppStore.getState().setSelection([BODY_1]);
    expect(stageNow()).toBe('ready');
    if (kind === 'assembly') {
      useAppStore.getState().openAssembly(createAssemblyDocument('組み立て1'));
    } else {
      useAppStore.getState().openDrawing(createDrawingDocument('図面1', drawingSource));
    }
    useAppStore.setState({ activeTool: 'mathGeometry', selection: [BODY_1] });
    const state = useAppStore.getState();
    expect(currentMathGeometry(state).status).toBe('notPart');
    expect(mathGeometryToolGuide(state)).toBeNull();
  });
});

describe('状態欄の 1 文での優先順位(describeStatus の mathGeometryGuide)', () => {
  it('道具が有効なら段の文をそのまま案内として出す(断りの文でも赤くしない)', () => {
    for (const text of [READY_TWO, '選んだ組み合わせから測れる量がありません。', '形の計算が終わってから追加してください。']) {
      const line = describeStatus({ ...quiet(), activeTool: 'mathGeometry', mathGeometryGuide: text });
      expect(line.kind).toBe('guide');
      expect(line.text).toBe(text);
      expect(line.hint).toBeNull();
    }
  });

  it('欄を渡さない・null のときは道具の基本案内(段0と同じ文)へ後退する', () => {
    const stage0 = mathGeometryToolGuideText({ stage: 'nothingSelected', key: MATH_GEOMETRY_TOOL_GUIDE_KEYS.nothingSelected, values: {} });
    expect(describeStatus({ ...quiet(), activeTool: 'mathGeometry' }).text).toBe(stage0);
    expect(describeStatus({ ...quiet(), activeTool: 'mathGeometry', mathGeometryGuide: null }).text).toBe(stage0);
  });

  it('加工の道具の案内と重ならない(道具が違えば渡されても使わず、この道具に加工の案内は無い)', () => {
    const filleting = describeStatus({
      ...quiet(),
      activeTool: 'fillet',
      selectionKind: 'edge',
      selectedSubShapeCount: 2,
      mathGeometryGuide: READY_TWO,
    });
    expect(filleting.text).toBe('辺を 2 本選んでいます。');
    expect(describeStatus({ ...quiet(), activeTool: 'select', mathGeometryGuide: READY_TWO }).text).toBe(
      t('statusBar.ready'),
    );
    expect(describeStatus({ ...quiet(), activeTool: 'measure', mathGeometryGuide: READY_TWO }).text).toBe(
      t('statusBar.guide.measure'),
    );
    expect(machiningGuideText('mathGeometry', 2, 2)).toBeNull();
  });

  it('加工の案内と同じ高さ: 失敗・中止・計算中・吸着・引っぱり・拘束の次の一手が先で、拘束の決まり具合より先に出る', () => {
    const base: StatusInput = { ...quiet(), activeTool: 'mathGeometry', mathGeometryGuide: READY_TWO };
    expect(describeStatus({ ...base, errorMessage: '計算できません' }).kind).toBe('failure');
    expect(describeStatus({ ...base, cancelled: true }).kind).toBe('cancelled');
    expect(describeStatus({ ...base, isComputing: true }).kind).toBe('computing');
    expect(describeStatus({ ...base, snapKind: 'endpoint' }).kind).toBe('snap');
    expect(describeStatus({ ...base, dragging: true }).text).toBe(t('statusBar.guide.dragging'));
    expect(describeStatus({ ...base, constraintPickMessage: '次の点を押してください' }).text).toBe('次の点を押してください');
    expect(describeStatus({ ...base, constraintSummaryText: 'あと 2 か所決まっていません' }).text).toBe(READY_TWO);
  });

  it('プロパティ欄の 1 文字ごとの変更で計算中の札が立たない間も、状態欄に計算中の文が出る', async () => {
    const fake = await toolFirst();
    useAppStore.getState().setSelection([BODY_1]);
    changeShape('extrude-3', 'width');
    const state = useAppStore.getState();
    // 束ねる変更では計算中の札を立てない(documentSlice の applyDocument)が、計算は走っている。
    expect(state.isComputing).toBe(false);
    expect(fake.calls).toHaveLength(2);
    const line = describeStatus({
      ...quiet(),
      isComputing: state.isComputing,
      activeTool: state.activeTool,
      mathGeometryGuide: guideTextNow(),
    });
    expect(line.kind).toBe('guide');
    expect(line.text).toBe('形の計算が終わってから追加してください。');

    settleWithBodies(fake.calls[1]);
    await tick();
    expect(describeStatus({ ...quiet(), activeTool: 'mathGeometry', mathGeometryGuide: guideTextNow() }).text).toBe(READY_TWO);
  });
});

describe('段ごとの文の表(MATH_GEOMETRY_TOOL_GUIDE_KEYS)', () => {
  it('5 つの段それぞれに空でない別々の文があり、段1だけが件数を差し込む', () => {
    const stages = Object.keys(MATH_GEOMETRY_TOOL_GUIDE_KEYS);
    expect([...stages].sort()).toEqual(['computing', 'nothingSelected', 'ready', 'tooMany', 'unsupportedPair']);
    const texts = Object.values(MATH_GEOMETRY_TOOL_GUIDE_KEYS).map((key) => t(key));
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
    }
    expect(new Set(texts).size).toBe(texts.length);
    expect(MATH_GEOMETRY_TOOL_GUIDE_KEYS.nothingSelected).toBe(guideKeyFor('mathGeometry', 0));
    for (const [stage, key] of Object.entries(MATH_GEOMETRY_TOOL_GUIDE_KEYS)) {
      expect(t(key).split('{count}').length - 1, stage).toBe(stage === 'ready' ? 1 : 0);
    }
  });
});
