import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { extractEdges } from '../occt/extractEdges.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { makeExtrudeSolid } from '../occt/makeSolidSweep.js';
import { makeSpring } from '../occt/makeSpring.js';
import { collectSubShapes } from '../occt/subShapes.js';
import { tessellate } from '../occt/tessellate.js';
import type {
  AppearanceQuery,
  CurveSpec,
  FilletStepSpec,
  HoleStepSpec,
  SolidEdgeInfo,
  SolidFaceInfo,
  SolidProgress,
  SolidRecomputeRequest,
  SolidStepRequest,
  SpringStepSpec,
  SubShapeQuery,
} from '../types.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache, type ShapeCache } from './shapeCache.js';

/** 原点を角とする長方形の閉ループ(z = 0 の XY 面)。押し出すと直方体になる。 */
function rectangle(width: number, depth: number): readonly CurveSpec[] {
  return [
    { kind: 'segment', from: [0, 0, 0], to: [width, 0, 0] },
    { kind: 'segment', from: [width, 0, 0], to: [width, depth, 0] },
    { kind: 'segment', from: [width, depth, 0], to: [0, depth, 0] },
    { kind: 'segment', from: [0, depth, 0], to: [0, 0, 0] },
  ];
}

/** 押し出しの段を 1 つ作る。距離は mm、向きは +Z。 */
function extrudeStep(
  id: string,
  key: string,
  width: number,
  depth: number,
  distance: number,
  visible = true,
): SolidStepRequest {
  return {
    key,
    id,
    label: id,
    visible,
    step: {
      kind: 'extrude',
      profile: rectangle(width, depth),
      direction: [0, 0, 1],
      distance,
    },
  };
}

/** ブーリアンの段を 1 つ作る。 */
function booleanStep(
  id: string,
  key: string,
  operation: 'union' | 'subtract' | 'intersect',
  targetKey: string,
  toolKey: string,
): SolidStepRequest {
  return {
    key,
    id,
    label: id,
    visible: true,
    step: { kind: 'boolean', operation, targetKey, toolKey },
  };
}

function request(steps: readonly SolidStepRequest[]): SolidRecomputeRequest {
  return { steps, generation: 1 };
}

/** 外観の面の照合(FR-1106、P5 タスク3)を頼む依頼。 */
function requestWithAppearance(
  steps: readonly SolidStepRequest[],
  appearanceQueries: readonly AppearanceQuery[],
): SolidRecomputeRequest {
  return { steps, generation: 1, appearanceQueries };
}

/** 40 × 30 を 10 押し出した体積。40·30·10 = 12000 mm³(手計算)。 */
const EXTRUDE_VOLUME = 12000;
/** 20 × 20 を 5 押し出した体積。20·20·5 = 2000 mm³(手計算)。 */
const SECOND_VOLUME = 2000;
/** 20 × 20 を 20 押し出した体積。20³ = 8000 mm³(手計算)。 */
const BIG_VOLUME = 8000;
/** 10 × 10 を 10 押し出した体積。10³ = 1000 mm³(手計算)。 */
const SMALL_VOLUME = 1000;
/** 小さい箱は大きい箱にすっかり含まれるので、差は 8000 − 1000 = 7000 mm³。 */
const SUBTRACT_VOLUME = BIG_VOLUME - SMALL_VOLUME;

/** 検査用のキャッシュ。本物を包んで「作り直した段の数」を数える。 */
interface TestCache {
  readonly cache: ShapeCache<CachedSolid>;
  /**
   * set が呼ばれた回数 = OCCT で作り直した段の数。
   * メソッドではなく関数の値として宣言する(取り出して使うため。unbound-method 対策)。
   */
  readonly built: () => number;
}

const openCaches: ShapeCache<CachedSolid>[] = [];

function newCache(): TestCache {
  const inner = createShapeCache<CachedSolid>();
  let built = 0;
  const cache: ShapeCache<CachedSolid> = {
    get: (key) => inner.get(key),
    set: (key, entry) => {
      built += 1;
      inner.set(key, entry);
    },
    has: (key) => inner.has(key),
    delete: (key) => inner.delete(key),
    retain: (liveKeys) => inner.retain(liveKeys),
    clear: () => {
      inner.clear();
    },
    get size(): number {
      return inner.size;
    },
    get capacity(): number {
      return inner.capacity;
    },
    stats: () => inner.stats(),
  };
  openCaches.push(cache);
  return { cache, built: () => built };
}

describe('履歴の再計算(recomputeSolids)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  // OCCT の形は JavaScript の回収の対象外なので、検査ごとに預けたものを手放す。
  afterEach(() => {
    for (const cache of openCaches.splice(0)) {
      cache.clear();
    }
  });

  // ここから下は加工の段(穴・R 面取り・ばね、計画書 タスク10)の検査が使う道具。
  // makeHole.test.ts と同じ考え方: 面・辺の指紋は「実際にその形を作って読み取る」ことで、
  // 手で数値を作らない(通し番号・面積・重心は実測でしか決まらないため)。

  /** tessellate / extractEdges と同じ形から一覧を作る(実際の使われ方と同じ順序)。 */
  function subShapesOf(shape: Parameters<typeof collectSubShapes>[1]) {
    const mesh = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges);
  }

  function faceQuery(info: SolidFaceInfo): Extract<SubShapeQuery, { kind: 'face' }> {
    return {
      kind: 'face',
      index: info.index,
      surfaceKind: info.surfaceKind,
      area: info.area,
      position: info.centroid,
      axis: info.axis,
      radius: info.radius,
    };
  }

  function edgeQuery(info: SolidEdgeInfo): Extract<SubShapeQuery, { kind: 'edge' }> {
    return {
      kind: 'edge',
      index: info.index,
      curveKind: info.curveKind,
      length: info.length,
      position: info.midpoint,
      axis: info.axis,
      radius: info.radius,
    };
  }

  /** 軸が axis に最も近い平面の面を 1 枚選ぶ。 */
  function planeFacing(faces: readonly SolidFaceInfo[], axis: readonly [number, number, number]): SolidFaceInfo {
    const found = faces.find(
      (face) =>
        face.surfaceKind === 'plane' &&
        face.axis !== null &&
        Math.abs(face.axis[0] - axis[0]) < 1e-9 &&
        Math.abs(face.axis[1] - axis[1]) < 1e-9 &&
        Math.abs(face.axis[2] - axis[2]) < 1e-9,
    );
    if (found === undefined) {
      throw new Error(`向き [${axis.join(',')}] の平面が見つかりませんでした`);
    }
    return found;
  }

  /** 原点にある角の垂直辺(長さ 10)を選ぶ。 */
  function cornerEdgeAtOrigin(edges: readonly SolidEdgeInfo[]): SolidEdgeInfo {
    const found = edges.find(
      (edge) =>
        edge.curveKind === 'line' &&
        Math.abs(edge.length - 10) < 1e-6 &&
        Math.abs(edge.midpoint[0]) < 1e-6 &&
        Math.abs(edge.midpoint[1]) < 1e-6,
    );
    if (found === undefined) {
      throw new Error('原点の角の辺が見つかりませんでした');
    }
    return found;
  }

  /**
   * 40 × 30 を 10 押し出した板(EXTRUDE_VOLUME = 12000)を実際に作り、
   * 上の面(z = 10)の指紋と、原点の角の垂直辺の指紋を読み取る。
   *
   * この板を作る extrudeStep('40x30x10 の押し出し', ...) と同じ形になるので、
   * 別々に作っても TopExp.MapShapes_2 の並びは一致する(2026-09-03 実測。決定的な構築)。
   */
  function plateFingerprints(): {
    readonly topFace: Extract<SubShapeQuery, { kind: 'face' }>;
    readonly cornerEdge: Extract<SubShapeQuery, { kind: 'edge' }>;
  } {
    const handle = makeExtrudeSolid(
      oc,
      { kind: 'extrude', profile: rectangle(40, 30), direction: [0, 0, 1], distance: 10 },
      {},
    );
    try {
      const tables = subShapesOf(handle.shape);
      return {
        topFace: faceQuery(planeFacing(tables.faces, [0, 0, 1])),
        cornerEdge: edgeQuery(cornerEdgeAtOrigin(tables.edges)),
      };
    } finally {
      handle.delete();
    }
  }

  /** 穴の段を 1 つ作る。既定は板の中心 [20,15,10] に φ6 の貫通穴。 */
  function holeStep(
    id: string,
    key: string,
    targetKey: string,
    face: SubShapeQuery,
    overrides: Partial<HoleStepSpec> = {},
    visible = true,
  ): SolidStepRequest {
    const step: HoleStepSpec = {
      kind: 'hole',
      targetKey,
      face,
      centers: [[20, 15, 10]],
      diameter: 6,
      depth: null,
      tiltAngle: 0,
      tiltAzimuth: 0,
      transforms: [],
      ...overrides,
    };
    return { key, id, label: id, visible, step };
  }

  /** R 面取りの段を 1 つ作る。 */
  function filletStep(
    id: string,
    key: string,
    targetKey: string,
    targets: readonly SubShapeQuery[],
    radius: number,
  ): SolidStepRequest {
    const step: FilletStepSpec = { kind: 'fillet', targetKey, targets, radius };
    return { key, id, label: id, visible: true, step };
  }

  /** ばねの段を 1 つ作る。既定はコイル径 20・線径 2・ピッチ 5・巻数 4(計画書 §2.7b.5)。 */
  function springStep(id: string, key: string, overrides: Partial<SpringStepSpec> = {}): SolidStepRequest {
    const step: SpringStepSpec = {
      kind: 'spring',
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      coilDiameter: 20,
      wireDiameter: 2,
      pitch: 5,
      turns: 4,
      handedness: 'right',
      ...overrides,
    };
    return { key, id, label: id, visible: true, step };
  }

  it('1 段の押し出しから体積 12000 mm³ のボディを 1 つ返す', async () => {
    const { cache, built } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([extrudeStep('extrude-1', 'key-a', 40, 30, 10)]),
    );

    expect(result.failures).toEqual([]);
    expect(result.cancelled).toBe(false);
    expect(result.cacheHits).toBe(0);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].id).toBe('extrude-1');
    expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
    expect(result.bodies[0].faceCount).toBe(6);
    expect(result.bodies[0].edgeCount).toBe(12);
    // Comlink 越しに渡せる型(TypedArray と純データ)だけを使っている。
    expect(result.bodies[0].positions).toBeInstanceOf(Float32Array);
    expect(result.bodies[0].indices).toBeInstanceOf(Uint32Array);
    expect(result.bodies[0].edgePositions).toBeInstanceOf(Float32Array);
    expect(built()).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('押し出しを 2 段続けると、履歴の順にボディが 2 つ並ぶ', async () => {
    const { cache, built } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-a', 40, 30, 10),
        extrudeStep('extrude-2', 'key-b', 20, 20, 5),
      ]),
    );

    expect(result.failures).toEqual([]);
    expect(result.cacheHits).toBe(0);
    expect(result.bodies.map((body) => body.id)).toEqual(['extrude-1', 'extrude-2']);
    expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
    expect(result.bodies[1].volume).toBeCloseTo(SECOND_VOLUME, 6);
    expect(built()).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('同じ依頼をもう一度渡すと、1 段も作り直さずにキャッシュから返す(NFR-PF-3)', async () => {
    const { cache, built } = newCache();
    const steps = [
      extrudeStep('extrude-1', 'key-a', 40, 30, 10),
      extrudeStep('extrude-2', 'key-b', 20, 20, 5),
    ];

    const first = await recomputeSolids({ oc, cache }, request(steps));
    expect(first.cacheHits).toBe(0);
    expect(built()).toBe(2);

    const second = await recomputeSolids({ oc, cache }, request(steps));
    expect(second.cacheHits).toBe(2);
    // 作り直しが起きていないこと。件数も増えない。
    expect(built()).toBe(2);
    expect(cache.size).toBe(2);
    expect(cache.stats().released).toBe(0);
    expect(second.bodies.map((body) => body.id)).toEqual(['extrude-1', 'extrude-2']);
    expect(second.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
    expect(second.bodies[1].volume).toBeCloseTo(SECOND_VOLUME, 6);
  });

  it('鍵が同じで id が違う段には、キャッシュのメッシュを id だけ差し替えて返す', async () => {
    const { cache, built } = newCache();
    await recomputeSolids({ oc, cache }, request([extrudeStep('extrude-1', 'key-a', 40, 30, 10)]));

    const result = await recomputeSolids(
      { oc, cache },
      request([extrudeStep('extrude-9', 'key-a', 40, 30, 10)]),
    );

    expect(result.cacheHits).toBe(1);
    expect(built()).toBe(1);
    expect(result.bodies[0].id).toBe('extrude-9');
    expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
  });

  it('押し出し 2 段と差で、消費された 2 つは返さず 7000 mm³ のボディだけを返す', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-big', 20, 20, 20, false),
        extrudeStep('extrude-2', 'key-small', 10, 10, 10, false),
        booleanStep('boolean-1', 'key-cut', 'subtract', 'key-big', 'key-small'),
      ]),
    );

    expect(result.failures).toEqual([]);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].id).toBe('boolean-1');
    expect(result.bodies[0].volume).toBeCloseTo(SUBTRACT_VOLUME, 6);
    // 消費された 2 つも次の再計算のためにキャッシュには残る。
    expect(cache.size).toBe(3);
  });

  it('作れない段があっても、後ろの段は計算する(FR-504)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-a', 40, 30, 10),
        extrudeStep('extrude-2', 'key-bad', 20, 20, 0),
        extrudeStep('extrude-3', 'key-c', 20, 20, 5),
      ]),
    );

    expect(result.failures).toEqual([
      { id: 'extrude-2', message: '押し出す長さは 0 より大きい数にしてください。' },
    ]);
    expect(result.bodies.map((body) => body.id)).toEqual(['extrude-1', 'extrude-3']);
    expect(result.bodies[1].volume).toBeCloseTo(SECOND_VOLUME, 6);
    expect(result.cancelled).toBe(false);
    // 失敗した段はキャッシュに入らない。
    expect(cache.has('key-bad')).toBe(false);
    expect(cache.size).toBe(2);
  });

  it('作れなかった段を入力にする段も、上流の名前を添えた理由で失敗して続く(FR-504)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('押し出し1', 'key-bad', 20, 20, 0),
        extrudeStep('押し出し2', 'key-small', 10, 10, 10, false),
        booleanStep('組み合わせ1', 'key-cut', 'subtract', 'key-bad', 'key-small'),
        extrudeStep('押し出し3', 'key-c', 20, 20, 5),
      ]),
    );

    expect(result.failures).toEqual([
      { id: '押し出し1', message: '押し出す長さは 0 より大きい数にしてください。' },
      {
        id: '組み合わせ1',
        message: 'もとになる立体「押し出し1」を作れなかったため、この立体も作れませんでした。',
      },
    ]);
    // 巻き添えにならない段は最後まで計算される。
    expect(result.bodies.map((body) => body.id)).toEqual(['押し出し3']);
    expect(result.cancelled).toBe(false);
  });

  it('どこにも無い鍵を指すブーリアンは、もとになる立体が無いと断る', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-big', 20, 20, 20, false),
        booleanStep('boolean-1', 'key-cut', 'subtract', 'key-big', 'key-nowhere'),
      ]),
    );

    expect(result.failures).toEqual([
      { id: 'boolean-1', message: 'もとになる立体が見つかりませんでした。' },
    ]);
    expect(result.bodies).toEqual([]);
  });

  it('段ごとに進捗を 1 回ずつ知らせる(NFR-PF-4)', async () => {
    const { cache } = newCache();
    const progress: SolidProgress[] = [];
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-a', 40, 30, 10),
        extrudeStep('extrude-2', 'key-b', 20, 20, 5),
        extrudeStep('extrude-3', 'key-bad', 20, 20, 0),
      ]),
      {},
      (value) => {
        progress.push(value);
      },
      () => false,
    );

    // 失敗する段も含めて、段の数だけ知らせる。
    expect(progress).toEqual([
      { stepId: 'extrude-1', index: 0, total: 3, label: 'extrude-1' },
      { stepId: 'extrude-2', index: 1, total: 3, label: 'extrude-2' },
      { stepId: 'extrude-3', index: 2, total: 3, label: 'extrude-3' },
    ]);
    expect(result.cancelled).toBe(false);
    expect(result.bodies).toHaveLength(2);
  });

  it('2 段目の前で中止すると、1 段目までを返して中止の印を立てる(NFR-PF-4)', async () => {
    const { cache } = newCache();
    const progress: SolidProgress[] = [];
    let asked = 0;
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-a', 40, 30, 10),
        extrudeStep('extrude-2', 'key-b', 20, 20, 5),
        extrudeStep('extrude-3', 'key-c', 10, 10, 10),
      ]),
      {},
      (value) => {
        progress.push(value);
      },
      () => {
        asked += 1;
        return true;
      },
    );

    expect(result.cancelled).toBe(true);
    expect(result.bodies.map((body) => body.id)).toEqual(['extrude-1']);
    expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
    expect(result.failures).toEqual([]);
    // 尋ねるのは段と段の間だけ。1 段目は必ず計算する。
    expect(asked).toBe(1);
    expect(progress).toHaveLength(1);
    expect(cache.size).toBe(1);
  });

  it('中止の口が Promise を返しても受け取れる(Comlink 越しの形)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('extrude-1', 'key-a', 40, 30, 10),
        extrudeStep('extrude-2', 'key-b', 20, 20, 5),
      ]),
      {},
      undefined,
      () => Promise.resolve(true),
    );

    expect(result.cancelled).toBe(true);
    expect(result.bodies).toHaveLength(1);
  });

  it('段が 1 つも無い依頼は、何もせずに空の結果を返す', async () => {
    const { cache, built } = newCache();
    const result = await recomputeSolids({ oc, cache }, request([]));

    // appearanceMatches は P5 タスク3 で足した欄。外観を頼んでいないので必ず空配列。
    expect(result).toEqual({
      bodies: [],
      failures: [],
      cacheHits: 0,
      cancelled: false,
      appearanceMatches: [],
    });
    expect(built()).toBe(0);
  });

  it('再計算のたびにキャッシュを掃除しない(Undo で作り直さないため。統括判断)', async () => {
    const { cache } = newCache();
    await recomputeSolids({ oc, cache }, request([extrudeStep('extrude-1', 'key-a', 40, 30, 10)]));

    // 前の段を含まない依頼を流しても、前の鍵は残っている(retain を呼ばない)。
    await recomputeSolids({ oc, cache }, request([extrudeStep('extrude-2', 'key-b', 20, 20, 5)]));

    expect(cache.has('key-a')).toBe(true);
    expect(cache.has('key-b')).toBe(true);
    expect(cache.size).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // 加工の段(穴・R 面取り・ばね、計画書 P3 タスク10)。
  // 加工の段が上流のキャッシュから面・辺の一覧を引けていることを確かめる(手順4)。
  // ---------------------------------------------------------------------------

  /** φ6 の貫通穴 1 つが 40×30×10 の板から削る体積。π·3²·10 = 282.743338823…(makeHole.test.ts と同じ)。 */
  const THROUGH_HOLE_VOLUME = Math.PI * 3 * 3 * 10;

  it('押し出し → 穴(貫通)の 2 段で、板から穴ぶんを引いた体積になる', async () => {
    const { cache, built } = newCache();
    const { topFace } = plateFingerprints();

    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('押し出し1', 'key-plate', 40, 30, 10, false),
        holeStep('穴1', 'key-hole', 'key-plate', topFace),
      ]),
    );

    expect(result.failures).toEqual([]);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].id).toBe('穴1');
    expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME - THROUGH_HOLE_VOLUME, 6);
    expect(built()).toBe(2);
  });

  it('押し出し → 穴 → R 面取りの 3 段が続けて成功する(面・辺の一覧を上流から引く)', async () => {
    const { cache } = newCache();
    const { topFace, cornerEdge } = plateFingerprints();

    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('押し出し1', 'key-plate', 40, 30, 10, false),
        holeStep('穴1', 'key-hole', 'key-plate', topFace, {}, false),
        filletStep('面取り1', 'key-fillet', 'key-hole', [cornerEdge], 2),
      ]),
    );

    expect(result.failures).toEqual([]);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].id).toBe('面取り1');
  });

  it('同じ 3 段をもう一度渡すと、3 段とも命中する', async () => {
    const { cache } = newCache();
    const { topFace, cornerEdge } = plateFingerprints();
    const steps = [
      extrudeStep('押し出し1', 'key-plate', 40, 30, 10, false),
      holeStep('穴1', 'key-hole', 'key-plate', topFace, {}, false),
      filletStep('面取り1', 'key-fillet', 'key-hole', [cornerEdge], 2),
    ];

    await recomputeSolids({ oc, cache }, request(steps));
    const second = await recomputeSolids({ oc, cache }, request(steps));

    expect(second.failures).toEqual([]);
    expect(second.cacheHits).toBe(3);
  });

  it('穴の段だけ径を変えると、押し出しだけ命中して体積が変わる', async () => {
    const { cache } = newCache();
    const { topFace } = plateFingerprints();

    await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('押し出し1', 'key-plate', 40, 30, 10, false),
        holeStep('穴1', 'key-hole-6', 'key-plate', topFace, { diameter: 6 }),
      ]),
    );

    const second = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('押し出し1', 'key-plate', 40, 30, 10, false),
        holeStep('穴1', 'key-hole-10', 'key-plate', topFace, { diameter: 10 }),
      ]),
    );

    expect(second.failures).toEqual([]);
    expect(second.cacheHits).toBe(1);
    const largerHoleVolume = EXTRUDE_VOLUME - Math.PI * 5 * 5 * 10;
    expect(second.bodies[0].volume).toBeCloseTo(largerHoleVolume, 6);
    expect(second.bodies[0].volume).not.toBeCloseTo(EXTRUDE_VOLUME - THROUGH_HOLE_VOLUME, 3);
  });

  it('面が見つからない穴は理由つきで失敗し、後の段は計算される(FR-504)', async () => {
    const { cache } = newCache();
    // 円柱面の指紋にしてある(板には円柱面が 1 枚も無いので、候補が 0 件で必ず見つからない)。
    const bogusFace: SubShapeQuery = {
      kind: 'face',
      index: 99,
      surfaceKind: 'cylinder',
      area: 1,
      position: [0, 0, 0],
      axis: [0, 0, 1],
      radius: 1,
    };

    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('押し出し1', 'key-plate', 40, 30, 10, false),
        holeStep('穴1', 'key-hole', 'key-plate', bogusFace),
        extrudeStep('押し出し2', 'key-b', 20, 20, 5),
      ]),
    );

    expect(result.failures).toEqual([
      {
        id: '穴1',
        message: '穴をあけるもとの面が見つかりません。形が大きく変わったため、選び直してください。',
      },
    ]);
    // 巻き添えにならない段は最後まで計算される。
    expect(result.bodies.map((body) => body.id)).toEqual(['押し出し2']);
  });

  it('丸め切れない半径の R 面取りは、例外にならず理由つきで失敗する(NFR-RE-1)', async () => {
    const { cache } = newCache();
    const { cornerEdge } = plateFingerprints();

    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('押し出し1', 'key-plate', 40, 30, 10, false),
        // 辺の長さ(10)よりずっと大きい半径は丸め切れない。
        filletStep('面取り1', 'key-fillet', 'key-plate', [cornerEdge], 100),
      ]),
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].id).toBe('面取り1');
    expect(result.bodies).toEqual([]);
  });

  it('加工の段が「もとになる立体」を失っていると、同じ理由で断る(ブーリアンと共通)', async () => {
    const { cache } = newCache();
    const bogusFace: SubShapeQuery = {
      kind: 'face',
      index: 0,
      surfaceKind: 'plane',
      area: 1,
      position: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
    };

    const result = await recomputeSolids(
      { oc, cache },
      request([holeStep('穴1', 'key-hole', 'key-nowhere', bogusFace)]),
    );

    expect(result.failures).toEqual([
      { id: '穴1', message: 'もとになる立体が見つかりませんでした。' },
    ]);
  });

  it('ばね 1 段だけの依頼は、対象を取らずに体積 792.064406711 mm³ 前後のボディを返す(FR-414)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids({ oc, cache }, request([springStep('ばね1', 'key-spring')]));

    expect(result.failures).toEqual([]);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].id).toBe('ばね1');
    const expectedVolume = 792.064406711;
    expect(Math.abs(result.bodies[0].volume - expectedVolume) / expectedVolume).toBeLessThan(0.005);
  });

  it('押し出し + ばねの 2 段は、ばねが何も消費しないので両方とも残る(§0.36)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([extrudeStep('押し出し1', 'key-a', 40, 30, 10), springStep('ばね1', 'key-spring')]),
    );

    expect(result.failures).toEqual([]);
    expect(result.bodies.map((body) => body.id)).toEqual(['押し出し1', 'ばね1']);
  });

  it('同じ押し出し + ばねの 2 段をもう一度渡すと、2 段とも命中する', async () => {
    const { cache } = newCache();
    const steps = [extrudeStep('押し出し1', 'key-a', 40, 30, 10), springStep('ばね1', 'key-spring')];

    await recomputeSolids({ oc, cache }, request(steps));
    const second = await recomputeSolids({ oc, cache }, request(steps));

    expect(second.failures).toEqual([]);
    expect(second.cacheHits).toBe(2);
  });

  /**
   * P3 仕上げ(2026-09-04)の回帰検査: ばねは掃引体向けに粗くした許容値
   * (線形 0.15mm・角度 0.7rad)でテッセレーションする。既定(線形 0.1mm・角度 0.5rad)の
   * 半分未満の三角形数になることを確かめる(実測は 10114 枚 → 2066 枚、recomputeSolids.ts の
   * `SWEEP_TESSELLATION_OPTIONS` の注釈に検証表がある)。この検査が壊れたら、
   * 掃引体向けの粗い許容値が既定へ巻き戻っていないか確認すること。
   */
  it('ばねは既定より粗いテッセレーションを使い、三角形が既定の半分未満になる(P3 仕上げ)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids({ oc, cache }, request([springStep('ばね1', 'key-spring')]));
    expect(result.failures).toEqual([]);

    const reference = makeSpring(oc, {
      kind: 'spring',
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      coilDiameter: 20,
      wireDiameter: 2,
      pitch: 5,
      turns: 4,
      handedness: 'right',
    });
    try {
      const defaultMesh = tessellate(oc, reference.shape);
      expect(result.bodies[0].triangleCount).toBeLessThan(defaultMesh.triangleCount / 2);
    } finally {
      reference.delete();
    }
  });

  /**
   * 対照検査: 掃引体ではない段(押し出し)は、既定のテッセレーション(線形 0.1mm・角度
   * 0.5rad)のままであることを確かめる。`resolveTessellationOptions` が対象を
   * ばね・実らせんの溝だけに絞れているかの歯止め(広げすぎて穴等が粗くなる事故を防ぐ)。
   */
  it('押し出しは既定のテッセレーションのまま(掃引体向けの粗さを適用しない)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([extrudeStep('押し出し1', 'key-a', 40, 30, 10)]),
    );
    expect(result.failures).toEqual([]);

    const reference = makeExtrudeSolid(oc, {
      kind: 'extrude',
      profile: rectangle(40, 30),
      direction: [0, 0, 1],
      distance: 10,
    });
    try {
      const defaultMesh = tessellate(oc, reference.shape);
      expect(result.bodies[0].triangleCount).toBe(defaultMesh.triangleCount);
    } finally {
      reference.delete();
    }
  });

  // ---------------------------------------------------------------------------
  // 表面積・形の種類・外観の面の照合(P5 タスク3、FR-1102・FR-428・FR-1106)
  // ---------------------------------------------------------------------------

  /** 40 × 30 × 10 の板の表面積。2(40·30 + 40·10 + 30·10) = 3800 mm²(手計算)。 */
  const PLATE_AREA = 3800;
  /** φ6 の貫通穴を 1 つあけた板の上の面の面積。1200 − π·3² = 1200 − 9π mm²(手計算)。 */
  const HOLED_TOP_FACE_AREA = 1200 - 9 * Math.PI;

  /** 外観の依頼を 1 件作る。 */
  function appearanceQuery(id: string, bodyKey: string, face: SubShapeQuery): AppearanceQuery {
    return { id, bodyKey, query: face };
  }

  it('ボディに表面積 3800 mm² と形の種類 solid が乗る(既存の欄は変わらない)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([extrudeStep('extrude-1', 'key-a', 40, 30, 10)]),
    );

    expect(result.failures).toEqual([]);
    expect(result.bodies[0].area).toBeCloseTo(PLATE_AREA, 6);
    expect(result.bodies[0].bodyKind).toBe('solid');
    // P3 の不変条件(faceCount = faces.length、edgeCount = edges.length)を壊していない。
    expect(result.bodies[0].faceCount).toBe(result.bodies[0].faces.length);
    expect(result.bodies[0].edgeCount).toBe(result.bodies[0].edges.length);
    expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
  });

  it('外観を頼まなければ照合の結果は空になる(費用ゼロ)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([extrudeStep('extrude-1', 'key-a', 40, 30, 10)]),
    );

    expect(result.appearanceMatches).toEqual([]);
  });

  /*
   * 押し出しの距離を 10 → 20 に変えても、上の面へ付けた外観が同じ面に残る(FR-1106)。
   *
   * 点の内訳(P3 §2.2.3 の検算表 1 行目、手計算): 物差しは 20 mm 高い板の境界箱の
   * 対角長の半分 √(40² + 30² + 20²) / 2 = √2900 / 2 ≒ 26.9258。位置のずれは 10 mm なので
   * 位置の点は 1 − 10 / 26.9258 ≒ 0.6286。軸 1・大きさ 1・番号 1 と合わせて
   * 0.35 + 0.25 + 0.2 + 0.2 × 0.6286 ≒ 0.9257 で、しきい値 0.6 を大きく超える。
   */
  it('押し出しの距離を 10 → 20 に変えても、上の面の指紋が同じ面を選び直す(FR-1106)', async () => {
    const { topFace } = plateFingerprints();
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      requestWithAppearance(
        [extrudeStep('extrude-1', 'key-a', 40, 30, 20)],
        [appearanceQuery('appearance-1', 'key-a', topFace)],
      ),
    );

    expect(result.failures).toEqual([]);
    expect(result.appearanceMatches).toHaveLength(1);
    const match = result.appearanceMatches?.[0];
    expect(match?.id).toBe('appearance-1');
    expect(match?.bodyId).toBe('extrude-1');
    expect(match?.faceIndex).not.toBeNull();

    // 選ばれたのが「上の面」であること(裏の面ではないこと)を、面の素性で確かめる。
    const chosen = result.bodies[0].faces[match?.faceIndex ?? -1];
    expect(chosen.surfaceKind).toBe('plane');
    expect(chosen.axis?.[2]).toBeCloseTo(1, 9);
    expect(chosen.centroid[2]).toBeCloseTo(20, 6);
  });

  /*
   * 穴をあけて面が 6 枚 → 7 枚に増えても、上の面へ付けた外観が残る(FR-1106)。
   * 面積は穴のぶんだけ減る(1200 → 1200 − 9π ≒ 1171.7256)ので、大きさの点は
   * 0.9764 まで下がるが、軸と位置が満点なので 0.6 を割らない。
   */
  it('穴をあけて面が増えても、上の面の指紋が穴の分だけ小さくなった同じ面を選び直す', async () => {
    const { topFace } = plateFingerprints();
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      requestWithAppearance(
        [
          extrudeStep('extrude-1', 'key-a', 40, 30, 10, false),
          holeStep('hole-1', 'key-b', 'key-a', topFace),
        ],
        [appearanceQuery('appearance-1', 'key-b', topFace)],
      ),
    );

    expect(result.failures).toEqual([]);
    const match = result.appearanceMatches?.[0];
    expect(match?.bodyId).toBe('hole-1');
    expect(match?.faceIndex).not.toBeNull();

    const chosen = result.bodies[0].faces[match?.faceIndex ?? -1];
    expect(chosen.axis?.[2]).toBeCloseTo(1, 9);
    // 穴 1 つぶんだけ面積が減った上の面である(1200 − 9π、手計算)。
    expect(chosen.area).toBeCloseTo(HOLED_TOP_FACE_AREA, 6);
  });

  /*
   * 「見つからない」側の歯止め。大きさだけを 100 倍にした指紋は
   * 0.35 + 0.25 × 0.01 + 0.2 + 0.2 = 0.7525 でしきい値を超えてしまう
   * (docs/報告記録.md 2026-09-03 の P3 タスク5 の実測)ので、
   * 番号・大きさ・位置をすべて外した指紋で固定する。
   */
  it('番号・大きさ・位置がすべて外れた指紋は見つからず faceIndex が null になる', async () => {
    const { topFace } = plateFingerprints();
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      requestWithAppearance(
        [extrudeStep('extrude-1', 'key-a', 40, 30, 10)],
        [
          appearanceQuery('appearance-1', 'key-a', {
            ...topFace,
            index: 99,
            area: topFace.area * 100,
            position: [1000, 1000, 1000],
          }),
        ],
      ),
    );

    expect(result.appearanceMatches).toEqual([
      { id: 'appearance-1', bodyId: 'extrude-1', faceIndex: null },
    ]);
  });

  it('消費されて画面に出ないボディの面には照合しない(bodyId が空・faceIndex が null)', async () => {
    const { topFace } = plateFingerprints();
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      requestWithAppearance(
        [
          extrudeStep('extrude-1', 'key-a', 40, 30, 10, false),
          holeStep('hole-1', 'key-b', 'key-a', topFace),
        ],
        [appearanceQuery('appearance-1', 'key-a', topFace)],
      ),
    );

    expect(result.failures).toEqual([]);
    expect(result.appearanceMatches).toEqual([
      { id: 'appearance-1', bodyId: '', faceIndex: null },
    ]);
  });

  it('ボディが 1 つも無い依頼でも、依頼の件数だけ「見つからない」を返して落ちない', async () => {
    const { topFace } = plateFingerprints();
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      requestWithAppearance(
        [],
        [
          appearanceQuery('appearance-1', 'key-a', topFace),
          appearanceQuery('appearance-2', 'key-b', topFace),
        ],
      ),
    );

    expect(result.bodies).toEqual([]);
    expect(result.appearanceMatches).toEqual([
      { id: 'appearance-1', bodyId: '', faceIndex: null },
      { id: 'appearance-2', bodyId: '', faceIndex: null },
    ]);
  });

  it('キャッシュに命中した段でも、表面積・形の種類と外観の照合がそろって返る', async () => {
    const { topFace } = plateFingerprints();
    const { cache, built } = newCache();
    const steps = [extrudeStep('extrude-1', 'key-a', 40, 30, 10)];
    const queries = [appearanceQuery('appearance-1', 'key-a', topFace)];

    await recomputeSolids({ oc, cache }, requestWithAppearance(steps, queries));
    const second = await recomputeSolids({ oc, cache }, requestWithAppearance(steps, queries));

    expect(built()).toBe(1);
    expect(second.cacheHits).toBe(1);
    expect(second.bodies[0].area).toBeCloseTo(PLATE_AREA, 6);
    expect(second.bodies[0].bodyKind).toBe('solid');
    expect(second.appearanceMatches?.[0].faceIndex).not.toBeNull();
  });
});
