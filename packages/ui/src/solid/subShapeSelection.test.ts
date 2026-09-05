import { describe, expect, it } from 'vitest';

import { featureIdOf } from '../sketch/featureSummary.js';

import {
  commonBodyIdOf,
  isSubShapeId,
  parseSubShapeId,
  selectedBodyIds,
  selectedSubShapeRefs,
  keepsSelectionKind,
  selectionKindForTool,
  subShapeElementId,
  subShapeRefOf,
  SUB_SHAPE_SEPARATOR,
  type SubShapeBody,
} from './subShapeSelection.js';

/** 稜線の線分列。辺0 が 1 本、辺1 が 2 本(合計 3 本 = 18 個)。 */
const EDGE_POSITIONS = new Float32Array([
  0, 0, 10, 10, 0, 10,
  10, 0, 10, 10, 10, 10,
  10, 10, 10, 0, 10, 10,
]);

const BOX: SubShapeBody = {
  featureId: 'extrude-1',
  mesh: { edgePositions: EDGE_POSITIONS },
  faces: [
    {
      index: 0,
      surfaceKind: 'plane',
      area: 100,
      centroid: [5, 5, 10],
      axis: [0, 0, 1],
      radius: null,
      triangleOffset: 0,
      triangleCount: 2,
    },
    {
      index: 1,
      surfaceKind: 'cylinder',
      area: 62.5,
      centroid: [5, 0, 5],
      axis: [0, 0, 1],
      radius: 3,
      triangleOffset: 2,
      triangleCount: 4,
    },
  ],
  edges: [
    {
      index: 0,
      curveKind: 'line',
      length: 10,
      midpoint: [5, 0, 10],
      start: [0, 0, 10],
      end: [10, 0, 10],
      axis: [1, 0, 0],
      radius: null,
      segmentOffset: 0,
      segmentCount: 1,
    },
    {
      index: 1,
      curveKind: 'circle',
      length: 15,
      midpoint: [10, 5, 10],
      start: [10, 0, 10],
      end: [0, 10, 10],
      axis: [0, 0, 1],
      radius: 5,
      segmentOffset: 1,
      segmentCount: 2,
    },
  ],
  vertices: [
    { index: 0, position: [0, 0, 10] },
    { index: 1, position: [10, 0, 10] },
  ],
};

const PLATE: SubShapeBody = {
  featureId: 'extrude-2',
  mesh: { edgePositions: new Float32Array([0, 0, 0, 20, 0, 0]) },
  faces: [
    {
      index: 0,
      surfaceKind: 'plane',
      area: 400,
      centroid: [10, 10, 0],
      axis: [0, 0, -1],
      radius: null,
      triangleOffset: 0,
      triangleCount: 2,
    },
  ],
  edges: [],
  vertices: [],
};

const BODIES: readonly SubShapeBody[] = [BOX, PLATE];

describe('部分形状の要素 id の規約(FR-106、§0.a-0.8)', () => {
  it('種類ごとの要素 id を作る', () => {
    expect(subShapeElementId('extrude-1', 'face', 12)).toBe('extrude-1#face:12');
    expect(subShapeElementId('fillet-1', 'edge', 5)).toBe('fillet-1#edge:5');
    expect(subShapeElementId('hole-2', 'vertex', 3)).toBe('hole-2#vertex:3');
    expect(SUB_SHAPE_SEPARATOR).toBe('#');
  });

  it('作った id をそのまま読み戻せる', () => {
    expect(parseSubShapeId('extrude-1#face:12')).toEqual({
      bodyFeatureId: 'extrude-1',
      kind: 'face',
      index: 12,
    });
    expect(parseSubShapeId(subShapeElementId('fillet-1', 'edge', 0))).toEqual({
      bodyFeatureId: 'fillet-1',
      kind: 'edge',
      index: 0,
    });
    expect(parseSubShapeId(subShapeElementId('hole-2', 'vertex', 3))).toEqual({
      bodyFeatureId: 'hole-2',
      kind: 'vertex',
      index: 3,
    });
  });

  it('スケッチの点列の 1 点と立体の id は部分形状ではない', () => {
    expect(parseSubShapeId('point-1#3')).toBeNull();
    expect(parseSubShapeId('extrude-1')).toBeNull();
    expect(isSubShapeId('point-1#3')).toBe(false);
    expect(isSubShapeId('extrude-1')).toBe(false);
    expect(isSubShapeId('extrude-1#edge:0')).toBe(true);
  });

  it('番号や本体が欠けた id は受け付けない', () => {
    expect(parseSubShapeId('extrude-1#face:')).toBeNull();
    expect(parseSubShapeId('#face:1')).toBeNull();
    expect(parseSubShapeId('a#face:-1')).toBeNull();
    expect(parseSubShapeId('a#face')).toBeNull();
    expect(parseSubShapeId('a#solid:1')).toBeNull();
    expect(parseSubShapeId('')).toBeNull();
  });

  it('区切りが 2 つ以上ある id は受け付けない', () => {
    // フィーチャーの id は `#` を含まないので、受け付けると featureIdOf との対応が崩れる。
    expect(parseSubShapeId('a#b#face:1')).toBeNull();
    expect(parseSubShapeId('a#face:1#2')).toBeNull();
  });

  it('番号の書き方は 1 通りに限る', () => {
    // 同じ部分形状が 2 通りの id を持つと、選択の同一判定が壊れる。
    expect(parseSubShapeId('a#face:007')).toBeNull();
    expect(parseSubShapeId('a#face:1.5')).toBeNull();
    expect(parseSubShapeId('a#face:+1')).toBeNull();
    expect(parseSubShapeId('a#face: 1')).toBeNull();
    expect(parseSubShapeId('a#face:1e2')).toBeNull();
  });

  it('既存の featureIdOf がそのまま効く(選択の掃除を変えずに済む)', () => {
    expect(featureIdOf(subShapeElementId('extrude-1', 'edge', 3))).toBe('extrude-1');
    expect(featureIdOf(subShapeElementId('extrude-1', 'face', 12))).toBe('extrude-1');
  });
});

describe('要素 id から文書へ保存する参照を作る(FR-502、§2.2.2)', () => {
  it('面の指紋が一覧の値と一致する', () => {
    expect(subShapeRefOf(BODIES, 'extrude-1#face:1')).toEqual({
      bodyFeatureId: 'extrude-1',
      index: 1,
      fingerprint: {
        kind: 'face',
        surfaceKind: 'cylinder',
        area: 62.5,
        position: [5, 0, 5],
        axis: [0, 0, 1],
        radius: 3,
      },
    });
  });

  it('辺の指紋が一覧の値と一致する(位置は中点)', () => {
    expect(subShapeRefOf(BODIES, 'extrude-1#edge:0')).toEqual({
      bodyFeatureId: 'extrude-1',
      index: 0,
      fingerprint: {
        kind: 'edge',
        curveKind: 'line',
        length: 10,
        position: [5, 0, 10],
        axis: [1, 0, 0],
        radius: null,
      },
    });
  });

  it('頂点の指紋は位置だけを持つ', () => {
    expect(subShapeRefOf(BODIES, 'extrude-1#vertex:1')).toEqual({
      bodyFeatureId: 'extrude-1',
      index: 1,
      fingerprint: { kind: 'vertex', position: [10, 0, 10] },
    });
  });

  it('番号が範囲の外、知らないボディ、部分形状でない id は null', () => {
    expect(subShapeRefOf(BODIES, 'extrude-1#face:2')).toBeNull();
    expect(subShapeRefOf(BODIES, 'extrude-2#edge:0')).toBeNull();
    expect(subShapeRefOf(BODIES, 'revolve-9#face:0')).toBeNull();
    expect(subShapeRefOf(BODIES, 'extrude-1')).toBeNull();
    expect(subShapeRefOf(BODIES, 'point-1#3')).toBeNull();
    expect(subShapeRefOf([], 'extrude-1#face:0')).toBeNull();
  });
});

describe('選択から加工の材料を取り出す(§0.a-0.20)', () => {
  const SELECTION = [
    'extrude-1#edge:1',
    'extrude-1#face:0',
    'point-1#3',
    'extrude-2',
    'extrude-1#edge:0',
  ];

  it('指定した種類の参照だけが選んだ順に返る', () => {
    const edges = selectedSubShapeRefs(BODIES, SELECTION, 'edge');
    expect(edges.map((ref) => ref.index)).toEqual([1, 0]);
    expect(edges.every((ref) => ref.fingerprint.kind === 'edge')).toBe(true);

    const faces = selectedSubShapeRefs(BODIES, SELECTION, 'face');
    expect(faces.map((ref) => ref.index)).toEqual([0]);
    expect(selectedSubShapeRefs(BODIES, SELECTION, 'vertex')).toEqual([]);
  });

  it('引けなかった参照(消えたボディ・範囲外の番号)は飛ばす', () => {
    const refs = selectedSubShapeRefs(BODIES, ['extrude-9#face:0', 'extrude-1#face:5'], 'face');
    expect(refs).toEqual([]);
  });

  it('立体の id だけを取り出す(部分形状とスケッチの要素は外れる)', () => {
    expect(selectedBodyIds(SELECTION, ['extrude-1', 'extrude-2'])).toEqual(['extrude-2']);
    // いま画面に無いボディは選択に残っていても返さない。
    expect(selectedBodyIds(['extrude-1', 'extrude-2'], ['extrude-2'])).toEqual(['extrude-2']);
    expect(selectedBodyIds([], ['extrude-1'])).toEqual([]);
  });

  it('部分形状が属するボディが 1 つに定まるときだけその id を返す', () => {
    expect(commonBodyIdOf(['extrude-1#face:0', 'extrude-1#face:1'])).toBe('extrude-1');
    // 立体やスケッチの要素が混ざっていても、部分形状だけを見る。
    expect(commonBodyIdOf(['extrude-2', 'extrude-1#edge:0', 'point-1#3'])).toBe('extrude-1');
    expect(commonBodyIdOf(['extrude-1#face:0', 'extrude-2#face:0'])).toBeNull();
    expect(commonBodyIdOf(['extrude-1', 'point-1#3'])).toBeNull();
    expect(commonBodyIdOf([])).toBeNull();
  });
});

describe('道具ごとの選択の種類(§0.a-0.6、§2.3.2)', () => {
  it('穴とねじ穴は面を選ぶ', () => {
    expect(selectionKindForTool('hole')).toBe('face');
    expect(selectionKindForTool('threadHole')).toBe('face');
  });

  it('R 面取りと C 面取りは辺を選ぶ', () => {
    expect(selectionKindForTool('fillet')).toBe('edge');
    expect(selectionKindForTool('chamfer')).toBe('edge');
  });

  it('パターンとばねと、それ以外の道具は立体を選ぶ', () => {
    // ばねはスケッチの点と線分を選ぶので、部分形状の選択には入らない(§0.36)。
    expect(selectionKindForTool('linearPattern')).toBe('body');
    expect(selectionKindForTool('circularPattern')).toBe('body');
    expect(selectionKindForTool('spring')).toBe('body');
    expect(selectionKindForTool('select')).toBe('body');
    expect(selectionKindForTool('point')).toBe('body');
    expect(selectionKindForTool('line')).toBe('body');
    expect(selectionKindForTool('arc')).toBe('body');
    expect(selectionKindForTool('pointArray')).toBe('body');
    expect(selectionKindForTool('face')).toBe('body');
    expect(selectionKindForTool('extrude')).toBe('body');
    expect(selectionKindForTool('revolve')).toBe('body');
    expect(selectionKindForTool('sew')).toBe('body');
  });

  it('面をつなぐ・ロフトは種類を切り替えない(§2.15 の「測る」と同じ扱い、P5 タスク27)', () => {
    /*
      輪郭にできるのはスケッチの面(種類に依らず選べる)・立体の面(`face` のとき)・
      球(`body` でも `face` でも)の 3 通りで、**どの種類でも何かしら選べる**。
      決め打ちで切り替えると、押した瞬間に材料の選択が消える(2026-09-05 の実測)。
    */
    expect(keepsSelectionKind('ruled')).toBe(true);
    expect(keepsSelectionKind('loft')).toBe(true);
  });

  it('「測る」も切り替えない(§2.15 の表、P5 タスク32)', () => {
    /*
      測れる種類は「いま選んでいるものが何か」で決まる(頂点 2 つなら距離、面 2 枚なら
      距離と角度、立体 2 つなら隙間)。決め打ちで種類を切り替えると押した瞬間に材料が
      消え、必ず「測りたいものを 1 つか 2 つ選んでください。」になってしまう。
    */
    expect(keepsSelectionKind('measure')).toBe(true);
  });

  it('それ以外の道具は今までどおり切り替える(既存の振る舞いを狭めない)', () => {
    for (const tool of ['hole', 'fillet', 'appearance', 'select', 'extrude'] as const) {
      expect(keepsSelectionKind(tool), tool).toBe(false);
    }
  });
});
