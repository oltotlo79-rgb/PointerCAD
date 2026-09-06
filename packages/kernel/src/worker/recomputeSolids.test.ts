import { expectWithinBudget } from '@pointercad/test-utils';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { extractEdges } from '../occt/extractEdges.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { makePrimitive } from '../occt/makePrimitive.js';
import { makeExtrudeSolid } from '../occt/makeSolidSweep.js';
import { makeSpring } from '../occt/makeSpring.js';
import { buildSolidBodyMesh } from '../occt/solidMesh.js';
import { collectSubShapes } from '../occt/subShapes.js';
import { tessellate } from '../occt/tessellate.js';
import type {
  AppearanceQuery,
  CurveSpec,
  FilletStepSpec,
  HoleStepSpec,
  PrimitiveShapeSpec,
  PrimitiveStepSpec,
  SolidBodyMesh,
  SolidEdgeInfo,
  SolidFaceInfo,
  SolidProgress,
  SolidRecomputeRequest,
  SolidStepRequest,
  SolidStepSpec,
  SolidVertexInfo,
  SpringStepSpec,
  SubShapeQuery,
  ThruSectionsStepSpec,
  Vec3Tuple,
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

/**
 * 表面積(`SolidBodyMesh.area`)まで測らせる依頼(P5 タスク14、統括の決定 2026-09-05)。
 * 既定では測らないので、面積を見る検査はこちらを使う。
 */
function requestWithAreas(steps: readonly SolidStepRequest[]): SolidRecomputeRequest {
  return { steps, generation: 1, measureAreas: true };
}

/** 外観の面の照合(FR-1106、P5 タスク3)を頼む依頼。 */
function requestWithAppearance(
  steps: readonly SolidStepRequest[],
  appearanceQueries: readonly AppearanceQuery[],
  measureAreas = false,
): SolidRecomputeRequest {
  return { steps, generation: 1, appearanceQueries, measureAreas };
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

  /**
   * 基本形状の段を 1 つ作る(FR-429、P5 タスク14)。
   * 既定は原点・Z 軸で、形だけを差し替えて使う(`makePrimitive.test.ts` と同じ書き方)。
   */
  function primitiveStep(
    id: string,
    key: string,
    shape: PrimitiveShapeSpec,
    overrides: Partial<Omit<PrimitiveStepSpec, 'shape' | 'kind'>> = {},
    visible = true,
  ): SolidStepRequest {
    const step: PrimitiveStepSpec = {
      kind: 'primitive',
      origin: [0, 0, 0],
      axis: [0, 0, 1],
      shape,
      originQuery: null,
      targetKey: null,
      ...overrides,
    };
    return { key, id, label: id, visible, step };
  }

  function vertexQuery(info: SolidVertexInfo): Extract<SubShapeQuery, { kind: 'vertex' }> {
    return { kind: 'vertex', index: info.index, position: info.position };
  }

  /** 一覧の中から、その座標にある頂点を 1 つ選ぶ。 */
  function vertexAtPoint(
    vertices: readonly SolidVertexInfo[],
    point: readonly [number, number, number],
  ): SolidVertexInfo {
    const found = vertices.find(
      (vertex) =>
        Math.hypot(
          vertex.position[0] - point[0],
          vertex.position[1] - point[1],
          vertex.position[2] - point[2],
        ) < 1e-6,
    );
    if (found === undefined) {
      throw new Error(`[${point.join(',')}] の頂点が見つかりませんでした`);
    }
    return found;
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

  it('表面積を求めた依頼では、ボディに 3800 mm² と形の種類 solid が乗る(既存の欄は変わらない)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      requestWithAreas([extrudeStep('extrude-1', 'key-a', 40, 30, 10)]),
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

    await recomputeSolids({ oc, cache }, requestWithAppearance(steps, queries, true));
    const second = await recomputeSolids({ oc, cache }, requestWithAppearance(steps, queries, true));

    expect(built()).toBe(1);
    expect(second.cacheHits).toBe(1);
    expect(second.bodies[0].area).toBeCloseTo(PLATE_AREA, 6);
    expect(second.bodies[0].bodyKind).toBe('solid');
    expect(second.appearanceMatches?.[0].faceIndex).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 表面積を測るかどうかの切り替え(P5 タスク14、統括の決定 2026-09-05)
  // ---------------------------------------------------------------------------

  /*
   * 表面積は「求められたときだけ」測る。NFR-PF-2 の上限 500ms に対し、穴 20 個の板が
   * すでに 485〜510ms を使っている(P3 の実測)ところへ、誰も見ない表面積のために
   * 11.4ms(面 26 枚の板、2026-09-05 実測)を足さないための決めである。
   * 形の種類(`bodyKind`)は `hasSolid` の判定そのままで安いので、常に入る。
   */
  it('表面積を求めない依頼では area が入らず、bodyKind だけが入る(既定)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([extrudeStep('extrude-1', 'key-a', 40, 30, 10)]),
    );

    expect(result.failures).toEqual([]);
    expect(result.bodies[0].area).toBeUndefined();
    expect(result.bodies[0].bodyKind).toBe('solid');
    // 体積は表面積とは別で、常に測る(P2 からの不変条件)。
    expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
  });

  it('外観の照合だけを頼んでも表面積は測らない(照合は面ごとの面積しか使わない)', async () => {
    const { topFace } = plateFingerprints();
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      requestWithAppearance(
        [extrudeStep('extrude-1', 'key-a', 40, 30, 10)],
        [appearanceQuery('appearance-1', 'key-a', topFace)],
      ),
    );

    expect(result.appearanceMatches?.[0].faceIndex).not.toBeNull();
    expect(result.bodies[0].area).toBeUndefined();
  });

  /*
   * 先に「測らない」依頼でキャッシュへ入った段へ、あとから「測る」依頼が来る場合。
   * 覚えてある形からその場で測って足すので、段は作り直さない(`built()` が増えない)。
   */
  it('測らずに覚えた段へ後から表面積を求めると、作り直さずに測って足す', async () => {
    const { cache, built } = newCache();
    const steps = [extrudeStep('extrude-1', 'key-a', 40, 30, 10)];

    const first = await recomputeSolids({ oc, cache }, request(steps));
    expect(first.bodies[0].area).toBeUndefined();

    const second = await recomputeSolids({ oc, cache }, requestWithAreas(steps));

    expect(built()).toBe(1);
    expect(second.cacheHits).toBe(1);
    expect(second.bodies[0].area).toBeCloseTo(PLATE_AREA, 6);
  });

  // ---------------------------------------------------------------------------
  // 基本形状の段(FR-429、P5 タスク14)
  // ---------------------------------------------------------------------------

  /** 球 r=10 の体積。4/3·π·10³ = 4000π/3 mm³(手計算)。 */
  const SPHERE_VOLUME = (4 / 3) * Math.PI * 1000;
  /** 箱 40×30×10 の体積。12000 mm³(手計算。押し出しの板と同じ大きさ)。 */
  const PRIMITIVE_BOX_VOLUME = 12000;
  /** トーラス R=20 r=5 の体積。2π²·20·5² = 1000π² mm³(手計算)。 */
  const TORUS_VOLUME = 2 * Math.PI * Math.PI * 20 * 25;

  it('球 1 段だけの依頼は、対象を取らずに体積 4188.790204786391 mm³ のボディを返す', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([primitiveStep('球1', 'key-sphere', { kind: 'sphere', radius: 10 })]),
    );

    expect(result.failures).toEqual([]);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].id).toBe('球1');
    expect(result.bodies[0].volume).toBeCloseTo(SPHERE_VOLUME, 6);
    expect(result.bodies[0].bodyKind).toBe('solid');
    // 球は面 1 枚の曲面(makePrimitive.test.ts の実測と同じ値)。
    expect(result.bodies[0].faceCount).toBe(1);
    expect(result.bodies[0].faces).toHaveLength(1);
  });

  it('箱 40×30×10 の段は体積 12000 mm³・形の種類 solid・面 6 枚になる', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        primitiveStep('箱1', 'key-box', { kind: 'box', sizeX: 40, sizeY: 30, sizeZ: 10 }),
      ]),
    );

    expect(result.failures).toEqual([]);
    expect(result.bodies[0].volume).toBeCloseTo(PRIMITIVE_BOX_VOLUME, 6);
    expect(result.bodies[0].bodyKind).toBe('solid');
    expect(result.bodies[0].faceCount).toBe(6);
    expect(result.bodies[0].faces).toHaveLength(6);
    expect(result.bodies[0].edgeCount).toBe(result.bodies[0].edges.length);
  });

  it('押し出し + 球の 2 段は、球が何も消費しないので両方とも残る(§0.a-0.19)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        extrudeStep('押し出し1', 'key-a', 40, 30, 10),
        primitiveStep('球1', 'key-sphere', { kind: 'sphere', radius: 10 }),
      ]),
    );

    expect(result.failures).toEqual([]);
    expect(result.bodies.map((body) => body.id)).toEqual(['押し出し1', '球1']);
  });

  /*
   * 球と箱を作り、球から箱を引く。球(中心 原点、r=10)と箱(中心 原点、20³)は
   * 箱が球を完全に包む(箱の内接球の半径が 10 = 球の半径)ので、差は 0 になり
   * 「立体になりませんでした」で断られる…のではなく、接しているだけなので
   * **実測して報告する**(計画書 タスク14 の検証表「球 → 箱 → 差 の 3 段」)。
   * ここでは確実に一部だけ重なる配置(箱を +Z へずらす)にして、
   * 差の体積が「球 − 交わり」になることを球冠の公式で検算する。
   *
   * 箱は中心 [0,0,15] の 20³ なので z = 5 〜 25 を占める。球 r=10 のうち
   * z ≧ 5 の部分(球冠、高さ h = 5)が交わりで、その体積は
   * πh²(3r − h)/3 = π·25·25/3 = 625π/3 ≒ 654.4984694978736 mm³(手計算)。
   * 箱の x/y は ±10 で球を覆うので、球冠がそのまま交わりになる。
   */
  it('球 → 箱 → 差 の 3 段で、差の体積が 球 − 球冠 になる', async () => {
    const { cache } = newCache();
    const sphereCapVolume = (Math.PI * 25 * (3 * 10 - 5)) / 3;
    const result = await recomputeSolids(
      { oc, cache },
      request([
        primitiveStep('球1', 'key-sphere', { kind: 'sphere', radius: 10 }, {}, false),
        primitiveStep(
          '箱1',
          'key-box',
          { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 },
          { origin: [0, 0, 15] },
          false,
        ),
        booleanStep('差1', 'key-cut', 'subtract', 'key-sphere', 'key-box'),
      ]),
    );

    expect(result.failures).toEqual([]);
    expect(result.bodies.map((body) => body.id)).toEqual(['差1']);
    console.log(
      `球 r=10 − 箱(中心 [0,0,15] の 20³): 体積 実測 ${result.bodies[0].volume.toFixed(9)} / ` +
        `計算 ${(SPHERE_VOLUME - sphereCapVolume).toFixed(9)}`,
    );
    expect(result.bodies[0].volume).toBeCloseTo(SPHERE_VOLUME - sphereCapVolume, 6);
  });

  it('同じ基本形状の段をもう一度渡すと、段の数だけ命中して作り直さない', async () => {
    const { cache, built } = newCache();
    const steps = [
      primitiveStep('球1', 'key-sphere', { kind: 'sphere', radius: 10 }),
      primitiveStep('トーラス1', 'key-torus', {
        kind: 'torus',
        majorRadius: 20,
        minorRadius: 5,
      }),
    ];

    await recomputeSolids({ oc, cache }, request(steps));
    const second = await recomputeSolids({ oc, cache }, request(steps));

    expect(second.failures).toEqual([]);
    expect(second.cacheHits).toBe(steps.length);
    expect(built()).toBe(steps.length);
    // 命中した段でも覚えていた体積がそのまま返る(トーラス R=20 r=5 = 2π²·20·5²)。
    expect(second.bodies[1].volume).toBeCloseTo(TORUS_VOLUME, 6);
  });

  it('半径を変えた 2 回目は、その段だけ作り直す(鍵の連鎖)', async () => {
    const { cache, built } = newCache();
    const first = [
      primitiveStep('球1', 'key-sphere-10', { kind: 'sphere', radius: 10 }),
      primitiveStep('箱1', 'key-box', { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 }),
    ];
    const second = [
      primitiveStep('球1', 'key-sphere-20', { kind: 'sphere', radius: 20 }),
      primitiveStep('箱1', 'key-box', { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 }),
    ];

    await recomputeSolids({ oc, cache }, request(first));
    const result = await recomputeSolids({ oc, cache }, request(second));

    expect(result.failures).toEqual([]);
    // 箱の段は鍵が変わっていないので命中し、球の段だけ作り直す。
    expect(result.cacheHits).toBe(1);
    expect(built()).toBe(3);
    expect(result.bodies[0].volume).toBeCloseTo((4 / 3) * Math.PI * 8000, 6);
  });

  it('作れない基本形状は、日本語の理由を添えて失敗し、次の段は続く(FR-504)', async () => {
    const { cache } = newCache();
    const result = await recomputeSolids(
      { oc, cache },
      request([
        primitiveStep('球1', 'key-bad', { kind: 'sphere', radius: 0 }),
        primitiveStep('箱1', 'key-box', { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 }),
      ]),
    );

    expect(result.failures).toEqual([
      { id: '球1', message: '半径は 0 より大きい数にしてください。' },
    ]);
    expect(result.bodies.map((body) => body.id)).toEqual(['箱1']);
  });

  /*
   * 基本形状は掃引体ではないので、既定のテッセレーション(線形 0.1mm・角度 0.5rad)の
   * ままであることを固定する(`isRelaxableSweepStep` を広げていないことの歯止め)。
   * 2026-09-05 実測の三角形の数は 球 r=10 が 978 枚、トーラス R=20 r=5 が 2600 枚で、
   * 緩める目安(2000 枚超かつ 100ms 超)に届かないため緩めていない
   * (判断の全文は `recomputeSolids.ts` の `isRelaxableSweepStep` の注釈)。
   */
  it('球とトーラスは既定のテッセレーションのまま(掃引体向けの粗さを当てない)', async () => {
    const { cache } = newCache();
    const shapes: readonly { label: string; key: string; shape: PrimitiveShapeSpec }[] = [
      { label: '球1', key: 'key-sphere', shape: { kind: 'sphere', radius: 10 } },
      {
        label: 'トーラス1',
        key: 'key-torus',
        shape: { kind: 'torus', majorRadius: 20, minorRadius: 5 },
      },
    ];
    const result = await recomputeSolids(
      { oc, cache },
      request(shapes.map((entry) => primitiveStep(entry.label, entry.key, entry.shape))),
    );
    expect(result.failures).toEqual([]);

    shapes.forEach((entry, index) => {
      const reference = makePrimitive(oc, {
        kind: 'primitive',
        origin: [0, 0, 0],
        axis: [0, 0, 1],
        shape: entry.shape,
        originQuery: null,
        targetKey: null,
      });
      try {
        const defaultMesh = tessellate(oc, reference.shape);
        console.log(`${entry.label}: 三角形 ${result.bodies[index].triangleCount} 枚(既定のまま)`);
        expect(result.bodies[index].triangleCount).toBe(defaultMesh.triangleCount);
      } finally {
        reference.delete();
      }
    });
  });

  /*
   * 段ごとの粗さ(`SolidStepRequest.tessellation`、P5 §2.13)。
   * 呼び出し側が段に許容値を添えたら、段の種類ごとの既定より優先される。
   * これは P6 の STL / 3MF の品質指定(FR-803)の入り口でもある(計画書 §7.1-(d))。
   */
  it('段ごとの粗さを添えると、その段だけ三角形が減る', async () => {
    const { cache } = newCache();
    const shape: PrimitiveShapeSpec = { kind: 'torus', majorRadius: 20, minorRadius: 5 };
    const base = primitiveStep('トーラス1', 'key-torus', shape);
    const result = await recomputeSolids(
      { oc, cache },
      request([{ ...base, tessellation: { linearDeflection: 0.15, angularDeflection: 0.7 } }]),
    );
    expect(result.failures).toEqual([]);

    const reference = makePrimitive(oc, {
      kind: 'primitive',
      origin: [0, 0, 0],
      axis: [0, 0, 1],
      shape,
      originQuery: null,
      targetKey: null,
    });
    try {
      const defaultMesh = tessellate(oc, reference.shape);
      console.log(
        `トーラス R=20 r=5: 既定 ${defaultMesh.triangleCount} 枚 → 段ごとの指定 ${result.bodies[0].triangleCount} 枚`,
      );
      expect(result.bodies[0].triangleCount).toBeLessThan(defaultMesh.triangleCount);
    } finally {
      reference.delete();
    }
  });

  /*
   * 段ごとの粗さは、掃引体向けの既定(ばね)よりも優先される。
   * 「段ごとの指定 > 全体の指定 > 段の種類ごとの既定」の順序を固定する。
   */
  it('ばねの段に細かい粗さを添えると、掃引体向けの既定より三角形が増える', async () => {
    const { cache } = newCache();
    const relaxed = await recomputeSolids(
      { oc, cache },
      request([springStep('ばね1', 'key-spring')]),
    );
    const { cache: cache2 } = newCache();
    const fine = await recomputeSolids(
      { oc, cache: cache2 },
      request([
        {
          ...springStep('ばね1', 'key-spring'),
          tessellation: { linearDeflection: 0.1, angularDeflection: 0.5 },
        },
      ]),
    );

    expect(relaxed.failures).toEqual([]);
    expect(fine.failures).toEqual([]);
    expect(fine.bodies[0].triangleCount).toBeGreaterThan(relaxed.bodies[0].triangleCount);
  });

  /*
   * NFR-PF-2「単一フィーチャーの適用は 500ms 以内」。5 種それぞれ 1 段の所要を測る。
   * 上限は緩めない(rules/02)。並列作業中の CPU 競合で落ちないよう、判定は
   * `solidPerformance.test.ts` と同じく実測の記録を主とし、上限超過だけを固定する。
   */
  it('5 種それぞれ 1 段の所要が 500ms 未満(NFR-PF-2)', async () => {
    const cases: readonly { label: string; shape: PrimitiveShapeSpec }[] = [
      { label: '球 r=10', shape: { kind: 'sphere', radius: 10 } },
      { label: '箱 40×30×10', shape: { kind: 'box', sizeX: 40, sizeY: 30, sizeZ: 10 } },
      { label: '円柱 r=10 h=20', shape: { kind: 'cylinder', radius: 10, height: 20 } },
      {
        label: '円錐 R=10 r=0 h=20',
        shape: { kind: 'cone', bottomRadius: 10, topRadius: 0, height: 20 },
      },
      { label: 'トーラス R=20 r=5', shape: { kind: 'torus', majorRadius: 20, minorRadius: 5 } },
    ];

    for (const [index, entry] of cases.entries()) {
      const { cache } = newCache();
      const started = performance.now();
      const result = await recomputeSolids(
        { oc, cache },
        request([primitiveStep(`形${index}`, `key-shape-${index}`, entry.shape)]),
      );
      const elapsed = performance.now() - started;
      expect(result.failures).toEqual([]);
      console.log(
        `${entry.label} の 1 段の所要: ${elapsed.toFixed(1)} ms / 三角形 ${result.bodies[0].triangleCount} 枚 / 上限 500 ms`,
      );
      expectWithinBudget(elapsed, 500, entry.label);
    }
  });

  /*
   * 基準点を「立体の頂点」にする追補(FR-429、§0.a-0.18、P5 タスク14b)。
   *
   * 指紋は必ず「同じ形を実際に作って読み取る」ことで用意する(番号も座標も
   * 手でこしらえない)。段の側は `originQuery` と `targetKey` を組で受け取り、
   * **対象を消費しない**ので、結果には対象と基本形状の両方のボディが残る。
   */
  describe('基準点を立体の頂点にする(FR-429、§0.a-0.18、タスク14b)', () => {
    /** 箱 20³(中心 原点)の体積。20³ = 8000 mm³(手計算)。 */
    const CENTERED_BOX_VOLUME = 8000;
    /** 球 r=5 の体積。4/3·π·125 = 500π/3 ≒ 523.598775598299 mm³(手計算)。 */
    const SPHERE5_VOLUME = (4 / 3) * Math.PI * 125;

    /** 中心が原点の箱 20³ を実際に作り、[10,10,10] の頂点の指紋を読み取る。 */
    function centeredBoxCornerQuery(): Extract<SubShapeQuery, { kind: 'vertex' }> {
      const handle = makePrimitive(oc, {
        kind: 'primitive',
        origin: [0, 0, 0],
        axis: [0, 0, 1],
        shape: { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 },
        originQuery: null,
        targetKey: null,
      });
      try {
        return vertexQuery(vertexAtPoint(subShapesOf(handle.shape).vertices, [10, 10, 10]));
      } finally {
        handle.delete();
      }
    }

    /** 20 × 20 を distance だけ押し出した板を作り、[20,20,distance] の頂点の指紋を読み取る。 */
    function plateCornerQuery(distance: number): Extract<SubShapeQuery, { kind: 'vertex' }> {
      const handle = makeExtrudeSolid(
        oc,
        { kind: 'extrude', profile: rectangle(20, 20), direction: [0, 0, 1], distance },
        {},
      );
      try {
        return vertexQuery(vertexAtPoint(subShapesOf(handle.shape).vertices, [20, 20, distance]));
      } finally {
        handle.delete();
      }
    }

    /** 中心が原点の箱 20³ の段(頂点を貸すだけで消費されないので visible のまま)。 */
    function centeredBoxStep(id: string, key: string): SolidStepRequest {
      return primitiveStep(id, key, { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 });
    }

    it('箱 20³ の頂点を基準にした球 r=5 は、その頂点が中心になり、両方のボディが残る', async () => {
      const { cache } = newCache();
      const corner = centeredBoxCornerQuery();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          centeredBoxStep('箱1', 'key-box'),
          primitiveStep(
            '球1',
            'key-sphere',
            { kind: 'sphere', radius: 5 },
            { originQuery: corner, targetKey: 'key-box' },
          ),
        ]),
      );

      expect(result.failures).toEqual([]);
      // 対象は消費しないので 2 ボディ(ばね・穴と違い、頂点を貸した立体はそのまま残る)。
      expect(result.bodies.map((body) => body.id)).toEqual(['箱1', '球1']);
      expect(result.bodies[0].volume).toBeCloseTo(CENTERED_BOX_VOLUME, 6);
      expect(result.bodies[1].volume).toBeCloseTo(SPHERE5_VOLUME, 6);
      // 球は面 1 枚で、その面の重心が球の中心になる(subShapes.ts の CentreOfMass)。
      const center = result.bodies[1].faces[0].centroid;
      console.log(
        `箱の頂点 [10,10,10] を基準にした球 r=5 の中心: [${center.map((value) => value.toFixed(9)).join(', ')}] / ` +
          `箱 ${result.bodies[0].volume.toFixed(6)} mm³・球 ${result.bodies[1].volume.toFixed(6)} mm³`,
      );
      expect(center[0]).toBeCloseTo(10, 6);
      expect(center[1]).toBeCloseTo(10, 6);
      expect(center[2]).toBeCloseTo(10, 6);
    });

    it('オフセットを添えると、頂点からその分だけ動いた位置が中心になる', async () => {
      const { cache } = newCache();
      const corner = centeredBoxCornerQuery();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          centeredBoxStep('箱1', 'key-box'),
          primitiveStep(
            '球1',
            'key-sphere',
            { kind: 'sphere', radius: 5 },
            { origin: [0, 0, 5], originQuery: corner, targetKey: 'key-box' },
          ),
        ]),
      );

      expect(result.failures).toEqual([]);
      const center = result.bodies[1].faces[0].centroid;
      expect(center[0]).toBeCloseTo(10, 6);
      expect(center[1]).toBeCloseTo(10, 6);
      expect(center[2]).toBeCloseTo(15, 6);
    });

    /*
     * 上流の押し出しを 10 → 20 に伸ばすと、指紋が指していた角の頂点は
     * [20,20,10] から [20,20,20] へ動く。通し番号は変わらないので採点は
     * 0.5(番号)+ 0.5 ×(1 − 10 / 17.32)= 0.711 でしきい値 0.6 を超え、
     * 球はその新しい頂点へ追従する(数値は検査の中で実測して記録する)。
     */
    it('押し出しを 10 → 20 に伸ばすと、頂点が動いて球も追従する', async () => {
      const { cache } = newCache();
      const corner = plateCornerQuery(10);
      const sphereAtCorner = (key: string, targetKey: string): SolidStepRequest =>
        primitiveStep(
          '球1',
          key,
          { kind: 'sphere', radius: 5 },
          { originQuery: corner, targetKey },
        );

      const first = await recomputeSolids(
        { oc, cache },
        request([
          extrudeStep('板1', 'key-plate-10', 20, 20, 10),
          sphereAtCorner('key-sphere-10', 'key-plate-10'),
        ]),
      );
      expect(first.failures).toEqual([]);
      expect(first.bodies[1].faces[0].centroid[2]).toBeCloseTo(10, 6);

      // 押し出しの段の鍵と、頂点を参照する段の鍵の両方が変わる
      // (model は `targetKey` を鍵の材料に含めるので、対象が変われば必ずこうなる)。
      const second = await recomputeSolids(
        { oc, cache },
        request([
          extrudeStep('板1', 'key-plate-20', 20, 20, 20),
          sphereAtCorner('key-sphere-20', 'key-plate-20'),
        ]),
      );

      expect(second.failures).toEqual([]);
      const center = second.bodies[1].faces[0].centroid;
      console.log(
        `押し出し 10 → 20: 球の中心が [${center.map((value) => value.toFixed(6)).join(', ')}] へ追従`,
      );
      expect(center[0]).toBeCloseTo(20, 6);
      expect(center[1]).toBeCloseTo(20, 6);
      expect(center[2]).toBeCloseTo(20, 6);
    });

    it('頂点の指紋が当たらないときは理由を添えて断り、対象の立体は残る(FR-504)', async () => {
      const { cache } = newCache();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          centeredBoxStep('箱1', 'key-box'),
          primitiveStep(
            '球1',
            'key-sphere',
            { kind: 'sphere', radius: 5 },
            {
              originQuery: { kind: 'vertex', index: 99, position: [1000, 1000, 1000] },
              targetKey: 'key-box',
            },
          ),
        ]),
      );

      expect(result.failures).toEqual([
        {
          id: '球1',
          message: '中心にする頂点が見つかりません。形が大きく変わったため、選び直してください。',
        },
      ]);
      // 断られても対象は消費されないので、箱はそのまま画面に残る。
      expect(result.bodies.map((body) => body.id)).toEqual(['箱1']);
    });

    it('頂点の指紋があるのに対象の鍵が無いときは、頂点を選び直すよう促して断る', async () => {
      const { cache } = newCache();
      const corner = centeredBoxCornerQuery();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          centeredBoxStep('箱1', 'key-box'),
          primitiveStep(
            '球1',
            'key-sphere',
            { kind: 'sphere', radius: 5 },
            { originQuery: corner, targetKey: null },
          ),
        ]),
      );

      expect(result.failures).toEqual([
        { id: '球1', message: '中心にする頂点を持つ立体が見つかりません。頂点を選び直してください。' },
      ]);
      expect(result.bodies.map((body) => body.id)).toEqual(['箱1']);
    });

    it('頂点を借りる相手の段が作れなかったときは、その段の名前を添えて断る(FR-504)', async () => {
      const { cache } = newCache();
      const corner = centeredBoxCornerQuery();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          primitiveStep('箱1', 'key-bad-box', { kind: 'box', sizeX: 0, sizeY: 20, sizeZ: 20 }),
          primitiveStep(
            '球1',
            'key-sphere',
            { kind: 'sphere', radius: 5 },
            { originQuery: corner, targetKey: 'key-bad-box' },
          ),
        ]),
      );

      expect(result.failures).toEqual([
        { id: '箱1', message: 'X の長さは 0 より大きい数にしてください。' },
        { id: '球1', message: 'もとになる立体「箱1」を作れなかったため、この立体も作れませんでした。' },
      ]);
      expect(result.bodies).toEqual([]);
    });

    it('指紋が無ければ対象の鍵があっても見に行かず、基準点は世界座標のまま', async () => {
      const { cache } = newCache();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          centeredBoxStep('箱1', 'key-box'),
          primitiveStep(
            '球1',
            'key-sphere',
            { kind: 'sphere', radius: 5 },
            { origin: [1, 2, 3], originQuery: null, targetKey: 'key-box' },
          ),
        ]),
      );

      expect(result.failures).toEqual([]);
      const center = result.bodies[1].faces[0].centroid;
      expect(center[0]).toBeCloseTo(1, 6);
      expect(center[1]).toBeCloseTo(2, 6);
      expect(center[2]).toBeCloseTo(3, 6);
    });
  });

  /*
   * 罫線面・ロフトの輪郭に立体の面を使う(FR-430、§0.a-0.73、P5 タスク24b)。
   *
   * 指紋は「同じ形を実際に作って読み取る」ことで用意し(頂点の追補と同じ流儀)、
   * 段の側は `faceQuery`(`targetKey` + 指紋)を受け取って**対象を消費しない**。
   * 体積はロフトの台形則 h/3 ×(A1 + A2 + √(A1·A2))で担当が導出する。
   */
  describe('立体の面を輪郭にする罫線面(FR-430、§0.a-0.73、タスク24b)', () => {
    /** 板 40×30×10 の上面(z = 10、面積 1200)と、その上の矩形 20×15(z = 30)をつないだ体積。 */
    const RULED_VOLUME = (20 / 3) * (1200 + 300 + Math.sqrt(1200 * 300));

    /** 板の上面(z = 20)と矩形 20×15(z = 30)をつないだ体積(高さが 10 になった場合)。 */
    const RULED_VOLUME_SHORT = (10 / 3) * (1200 + 300 + Math.sqrt(1200 * 300));

    /** 板の中心(20, 15)に合わせた長方形の閉ループ。罫線面の相手の輪郭に使う。 */
    function centeredRectangle(width: number, depth: number, z: number): readonly CurveSpec[] {
      const corners: readonly [number, number, number][] = [
        [20 - width / 2, 15 - depth / 2, z],
        [20 + width / 2, 15 - depth / 2, z],
        [20 + width / 2, 15 + depth / 2, z],
        [20 - width / 2, 15 + depth / 2, z],
      ];
      return corners.map((from, index) => ({
        kind: 'segment',
        from,
        to: corners[(index + 1) % corners.length],
      }));
    }

    /** 面の輪郭と矩形をつなぐ段を 1 つ作る。 */
    function ruledStep(
      id: string,
      key: string,
      targetKey: string,
      face: SubShapeQuery,
      topZ: number,
    ): SolidStepRequest {
      const step: ThruSectionsStepSpec = {
        kind: 'thruSections',
        sections: [
          { kind: 'faceQuery', targetKey, query: face },
          { kind: 'curves', curves: centeredRectangle(20, 15, topZ) },
        ],
        ruled: true,
        closed: true,
        twist: 0,
        sphereSegments: 24,
      };
      return { key, id, label: id, visible: true, step };
    }

    /** 円柱 r=10 h=20 を実際に作り、側面(円柱面)の指紋を読み取る。 */
    function cylinderSideQuery(): Extract<SubShapeQuery, { kind: 'face' }> {
      const handle = makePrimitive(oc, {
        kind: 'primitive',
        origin: [0, 0, 0],
        axis: [0, 0, 1],
        shape: { kind: 'cylinder', radius: 10, height: 20 },
        originQuery: null,
        targetKey: null,
      });
      try {
        const found = subShapesOf(handle.shape).faces.find(
          (face) => face.surfaceKind === 'cylinder',
        );
        if (found === undefined) {
          throw new Error('円柱の側面が見つかりませんでした');
        }
        return faceQuery(found);
      } finally {
        handle.delete();
      }
    }

    it('板の上面と矩形をつなぐと 14000 mm³ になり、板も残って 2 ボディになる', async () => {
      const { cache } = newCache();
      const { topFace } = plateFingerprints();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          extrudeStep('板1', 'key-plate', 40, 30, 10),
          ruledStep('罫線面1', 'key-ruled', 'key-plate', topFace, 30),
        ]),
      );

      expect(result.failures).toEqual([]);
      // 輪郭を貸した立体は消費されない(§0.a-0.27)ので 2 ボディ。
      expect(result.bodies.map((body) => body.id)).toEqual(['板1', '罫線面1']);
      expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
      console.log(
        `板の上面 → 矩形 20×15 の罫線面: ${result.bodies[1].volume} mm³(手計算 ${RULED_VOLUME})`,
      );
      expect(Math.abs(result.bodies[1].volume - RULED_VOLUME) / RULED_VOLUME).toBeLessThan(1e-6);
    });

    it('同じ依頼の 2 回目は 2 段とも命中して作り直さない(NFR-PF-3)', async () => {
      const { cache, built } = newCache();
      const { topFace } = plateFingerprints();
      const steps = [
        extrudeStep('板1', 'key-plate', 40, 30, 10),
        ruledStep('罫線面1', 'key-ruled', 'key-plate', topFace, 30),
      ];

      const first = await recomputeSolids({ oc, cache }, request(steps));
      expect(first.failures).toEqual([]);
      expect(built()).toBe(2);

      const second = await recomputeSolids({ oc, cache }, request(steps));
      expect(second.failures).toEqual([]);
      expect(second.cacheHits).toBe(2);
      expect(built()).toBe(2);
      expect(second.bodies[1].volume).toBeCloseTo(first.bodies[1].volume, 9);
    });

    it('板を 10 → 20 に伸ばすと、上面が動いて罫線面も追従する(鍵の連鎖)', async () => {
      const { cache } = newCache();
      const { topFace } = plateFingerprints();

      const first = await recomputeSolids(
        { oc, cache },
        request([
          extrudeStep('板1', 'key-plate-10', 40, 30, 10),
          ruledStep('罫線面1', 'key-ruled-10', 'key-plate-10', topFace, 30),
        ]),
      );
      expect(first.failures).toEqual([]);

      const second = await recomputeSolids(
        { oc, cache },
        request([
          extrudeStep('板1', 'key-plate-20', 40, 30, 20),
          ruledStep('罫線面1', 'key-ruled-20', 'key-plate-20', topFace, 30),
        ]),
      );

      expect(second.failures).toEqual([]);
      console.log(
        `押し出し 10 → 20: 罫線面の体積が ${first.bodies[1].volume} → ${second.bodies[1].volume}(手計算 ${RULED_VOLUME_SHORT})`,
      );
      expect(
        Math.abs(second.bodies[1].volume - RULED_VOLUME_SHORT) / RULED_VOLUME_SHORT,
      ).toBeLessThan(1e-6);
    });

    it('面の指紋が当たらないときは選び直しを促して断り、対象の立体は残る(FR-504)', async () => {
      const { cache } = newCache();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          extrudeStep('板1', 'key-plate', 40, 30, 10),
          ruledStep(
            '罫線面1',
            'key-ruled',
            'key-plate',
            {
              kind: 'face',
              index: 99,
              surfaceKind: 'plane',
              area: 999999,
              position: [1000, 1000, 1000],
              axis: [0, 0, 1],
              radius: null,
            },
            30,
          ),
        ]),
      );

      expect(result.failures).toEqual([
        { id: '罫線面1', message: 'つなぐ面が見つかりません。形が変わったため、選び直してください。' },
      ]);
      expect(result.bodies.map((body) => body.id)).toEqual(['板1']);
    });

    it('円柱の側面のように縁が 1 本につながらない面は、理由を添えて断る', async () => {
      const { cache } = newCache();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          primitiveStep('円柱1', 'key-cylinder', { kind: 'cylinder', radius: 10, height: 20 }),
          ruledStep('罫線面1', 'key-ruled', 'key-cylinder', cylinderSideQuery(), 40),
        ]),
      );

      expect(result.failures).toEqual([
        {
          id: '罫線面1',
          message: 'つなぐ面は平らな面か、縁が 1 本につながる面にしてください。',
        },
      ]);
      expect(result.bodies.map((body) => body.id)).toEqual(['円柱1']);
    });

    it('輪郭を借りる相手の段が無ければ、ブーリアンと同じ理由で断る', async () => {
      const { cache } = newCache();
      const { topFace } = plateFingerprints();
      const result = await recomputeSolids(
        { oc, cache },
        request([ruledStep('罫線面1', 'key-ruled', 'key-missing', topFace, 30)]),
      );

      expect(result.failures).toEqual([
        { id: '罫線面1', message: 'もとになる立体が見つかりませんでした。' },
      ]);
      expect(result.bodies).toEqual([]);
    });

    /*
     * 輪郭を貸した立体を、あとの段が使えなくなっていないこと(2026-09-06 の実測の再現)。
     *
     * Web で「長いセッションで切断・くり抜きが失敗し、頁を読み直すと直る」が実測された。
     * 切り分けると**失敗したロフトを挟んだあと、輪郭を貸したのと同じ立体を切る段が必ず失敗**し、
     * 別の寸法の箱(キャッシュの鍵が別物)なら成功した。原因は借りた面をそのまま
     * `BRepOffsetAPI_ThruSections` へ渡していたことで、組む途中の書き込みが下地の TShape を
     * 通じてキャッシュ上の立体へ届いていた(`makeThruSections.ts` の `sectionWireFromFace`)。
     * 頁を読み直すと直るのはキャッシュが空になるためである。
     *
     * ここで確かめるのは**貸したあとの立体が無事なこと**なので、体積は
     * 「切る前の箱の半分」という手計算だけを見る(ロフトそのものの形は上の検査群が固定済み)。
     */
    describe('輪郭を貸した立体はあとの段でも無事(2026-09-06 の実測)', () => {
      /** 20 × 20 を 20 押し出した箱。体積 8000、上面は z = 20、+X の側面は x = 20。 */
      function boxStep(): SolidStepRequest {
        return extrudeStep('箱1', 'key-box', 20, 20, 20);
      }

      /** その箱を z = 10 で切って下側だけ残す段。半分の 4000 になるはず(手計算)。 */
      function cutStep(): SolidStepRequest {
        return {
          key: 'key-cut',
          id: '切断1',
          label: '切断1',
          visible: true,
          step: {
            kind: 'cut',
            targetKey: 'key-box',
            origin: [10, 10, 10],
            normal: [0, 0, 1],
            keepPositive: false,
          },
        };
      }

      /** 箱の中心(10, 10)に合わせた正方形の閉ループ。成功する罫線面の相手の輪郭に使う。 */
      function boxTopRectangle(size: number, z: number): readonly CurveSpec[] {
        const half = size / 2;
        const corners: readonly Vec3Tuple[] = [
          [10 - half, 10 - half, z],
          [10 + half, 10 - half, z],
          [10 + half, 10 + half, z],
          [10 - half, 10 + half, z],
        ];
        return corners.map((from, index) => ({
          kind: 'segment',
          from,
          to: corners[(index + 1) % corners.length],
        }));
      }

      /** 箱 20³ を実際に作り、上面(+Z)と +X の側面の指紋を読み取る。 */
      function boxFaceQueries(): {
        readonly top: Extract<SubShapeQuery, { kind: 'face' }>;
        readonly side: Extract<SubShapeQuery, { kind: 'face' }>;
      } {
        const handle = makeExtrudeSolid(
          oc,
          { kind: 'extrude', profile: rectangle(20, 20), direction: [0, 0, 1], distance: 20 },
          {},
        );
        try {
          const faces = subShapesOf(handle.shape).faces;
          return {
            top: faceQuery(planeFacing(faces, [0, 0, 1])),
            side: faceQuery(planeFacing(faces, [1, 0, 0])),
          };
        } finally {
          handle.delete();
        }
      }

      /** 箱の上面と +X の側面(直交する 2 枚)をつなぐ段。この組み合わせは必ず失敗する。 */
      function failingLoftStep(
        top: SubShapeQuery,
        side: SubShapeQuery,
      ): SolidStepRequest {
        const spec: ThruSectionsStepSpec = {
          kind: 'thruSections',
          sections: [
            { kind: 'faceQuery', targetKey: 'key-box', query: top },
            { kind: 'faceQuery', targetKey: 'key-box', query: side },
          ],
          ruled: false,
          closed: false,
          twist: 0,
          sphereSegments: 24,
        };
        return { key: 'key-loft', id: 'ロフト1', label: 'ロフト1', visible: true, step: spec };
      }

      it('ロフトを挟まなければ、箱を z = 10 で切って 4000 になる(足場の確認)', async () => {
        const { cache } = newCache();
        const result = await recomputeSolids({ oc, cache }, request([boxStep(), cutStep()]));

        expect(result.failures).toEqual([]);
        expect(result.bodies.map((body) => body.id)).toEqual(['箱1', '切断1']);
        expect(result.bodies[1].volume).toBeCloseTo(BIG_VOLUME / 2, 6);
      });

      it('失敗したロフトを挟んでも、同じ箱を切る段は 4000 のまま通る', async () => {
        const { cache } = newCache();
        const { top, side } = boxFaceQueries();
        const result = await recomputeSolids(
          { oc, cache },
          request([boxStep(), failingLoftStep(top, side), cutStep()]),
        );

        // 失敗するのはロフトの段だけ。切断は巻き添えにならない。
        expect(result.failures).toEqual([
          {
            id: 'ロフト1',
            message: '面と面をつなげませんでした。輪郭の形を見直してください。',
          },
        ]);
        expect(result.bodies.map((body) => body.id)).toEqual(['箱1', '切断1']);
        expect(result.bodies[1].volume).toBeCloseTo(BIG_VOLUME / 2, 6);
      });

      it('成功した罫線面を挟んでも、同じ箱を切る段は 4000 のまま通る', async () => {
        const { cache } = newCache();
        const { top } = boxFaceQueries();
        const spec: ThruSectionsStepSpec = {
          kind: 'thruSections',
          sections: [
            { kind: 'faceQuery', targetKey: 'key-box', query: top },
            { kind: 'curves', curves: boxTopRectangle(10, 40) },
          ],
          ruled: true,
          closed: true,
          twist: 0,
          sphereSegments: 24,
        };
        const result = await recomputeSolids(
          { oc, cache },
          request([
            boxStep(),
            { key: 'key-ruled', id: '罫線面1', label: '罫線面1', visible: true, step: spec },
            cutStep(),
          ]),
        );

        expect(result.failures).toEqual([]);
        expect(result.bodies.map((body) => body.id)).toEqual(['箱1', '罫線面1', '切断1']);
        expect(result.bodies[2].volume).toBeCloseTo(BIG_VOLUME / 2, 6);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // P5 の Should 群・Could 群の段(FR-401、FR-409、FR-415〜FR-428、FR-432。タスク42a)。
  //
  // ここで確かめるのは**段の配線**である——依頼の欄がそのまま作り手へ渡り、上流の形と
  // 部分形状の一覧をキャッシュから引き、消費の有無どおりにボディが残り、同じ依頼の
  // 2 回目が命中すること。**形そのものの期待値**(細かい体積・境界箱・断りの文言)は
  // 各 `occt/make*.test.ts` が固定済みなので、ここで同じ数値を書き写さない
  // (同じ期待値を 2 か所に置くと、片方だけ直したときに食い違う)。
  // ---------------------------------------------------------------------------
  describe('P5 の Should 群・Could 群の段(タスク42a)', () => {
    /** 高さ z に置いた長方形の閉ループ(XY 面に平行)。 */
    function rectangleAtZ(width: number, depth: number, z: number): readonly CurveSpec[] {
      const corners: readonly Vec3Tuple[] = [
        [0, 0, z],
        [width, 0, z],
        [width, depth, z],
        [0, depth, z],
      ];
      return corners.map((from, index) => ({
        kind: 'segment',
        from,
        to: corners[(index + 1) % corners.length],
      }));
    }

    /** 中心 centre のまわりの一辺 size の正方形(XY 面に平行)。 */
    function squareAt(centre: Vec3Tuple, size: number): readonly CurveSpec[] {
      const half = size / 2;
      const corners: readonly Vec3Tuple[] = [
        [centre[0] - half, centre[1] - half, centre[2]],
        [centre[0] + half, centre[1] - half, centre[2]],
        [centre[0] + half, centre[1] + half, centre[2]],
        [centre[0] - half, centre[1] + half, centre[2]],
      ];
      return corners.map((from, index) => ({
        kind: 'segment',
        from,
        to: corners[(index + 1) % corners.length],
      }));
    }

    /** 段 1 つを依頼の形にする(種類を選ばない汎用の包み)。 */
    function step(
      id: string,
      key: string,
      spec: SolidStepSpec,
      visible = true,
    ): SolidStepRequest {
      return { key, id, label: id, visible, step: spec };
    }

    /** 40 × 30 × 10 の板(体積 12000)を作る段。加工の相手なので既定では画面に出さない。 */
    function plateStep(visible = false): SolidStepRequest {
      return extrudeStep('板', 'key-plate', 40, 30, 10, visible);
    }

    /** 20 × 20 × 20 の箱(体積 8000)を作る段。 */
    function boxStep(visible = false): SolidStepRequest {
      return extrudeStep('箱', 'key-box', 20, 20, 20, visible);
    }

    /** 板の上面(z = 10)と 4 つの側面の指紋。抜き勾配・エンボス・くり抜きが使う。 */
    function plateFaces(width: number, depth: number, height: number): {
      readonly top: Extract<SubShapeQuery, { kind: 'face' }>;
      readonly sides: readonly SubShapeQuery[];
    } {
      const handle = makeExtrudeSolid(
        oc,
        { kind: 'extrude', profile: rectangle(width, depth), direction: [0, 0, 1], distance: height },
        {},
      );
      try {
        const faces = subShapesOf(handle.shape).faces;
        return {
          top: faceQuery(planeFacing(faces, [0, 0, 1])),
          sides: [
            faceQuery(planeFacing(faces, [1, 0, 0])),
            faceQuery(planeFacing(faces, [-1, 0, 0])),
            faceQuery(planeFacing(faces, [0, 1, 0])),
            faceQuery(planeFacing(faces, [0, -1, 0])),
          ],
        };
      } finally {
        handle.delete();
      }
    }

    /** 箱の縦の辺(長さ 20)を 1 本選んだ指紋。可変半径フィレットが使う。 */
    function boxVerticalEdge(): Extract<SubShapeQuery, { kind: 'edge' }> {
      const handle = makeExtrudeSolid(
        oc,
        { kind: 'extrude', profile: rectangle(20, 20), direction: [0, 0, 1], distance: 20 },
        {},
      );
      try {
        const edges = subShapesOf(handle.shape).edges;
        const found = edges.find(
          (edge) =>
            edge.curveKind === 'line' &&
            Math.abs(edge.length - 20) < 1e-6 &&
            edge.axis !== null &&
            Math.abs(Math.abs(edge.axis[2]) - 1) < 1e-9,
        );
        if (found === undefined) {
          throw new Error('箱の縦の辺が見つかりませんでした');
        }
        return edgeQuery(found);
      } finally {
        handle.delete();
      }
    }

    /** 半径 5・高さ 20 の円柱(体積 π·25·20)の側面の指紋。外ねじが使う。 */
    function shaftSideFace(): Extract<SubShapeQuery, { kind: 'face' }> {
      const handle = makePrimitive(oc, {
        kind: 'primitive',
        origin: [0, 0, 0],
        axis: [0, 0, 1],
        shape: { kind: 'cylinder', radius: 5, height: 20 },
        originQuery: null,
        targetKey: null,
      });
      try {
        const found = subShapesOf(handle.shape).faces.find(
          (face) => face.surfaceKind === 'cylinder',
        );
        if (found === undefined) {
          throw new Error('軸の円柱面が見つかりませんでした');
        }
        return faceQuery(found);
      } finally {
        handle.delete();
      }
    }

    /** 5 度(ラジアン)。抜き勾配とテーパで使う。 */
    const FIVE_DEGREES = (5 * Math.PI) / 180;

    /** 円柱の軸(半径 5・高さ 20)の体積 π·25·20 = 1570.796…(手計算)。 */
    const SHAFT_VOLUME = Math.PI * 25 * 20;

    /** φ6 の貫通穴 1 つが板から削る体積 π·3²·10(makeHole.test.ts と同じ)。 */
    const PLAIN_HOLE_VOLUME = Math.PI * 9 * 10;

    /** 1 段だけの依頼と、その結果の確かめ方。 */
    interface StepCase {
      /** 依頼(上流の対象は visible: false で前に置く)。 */
      readonly steps: readonly SolidStepRequest[];
      /** 画面に残るボディの数。ミラーは対象を消費しないので 2 になる。 */
      readonly bodyCount: number;
      /** 作り直す段の数(= キャッシュに預ける件数)。 */
      readonly built: number;
      /** 表面積を測らせるか(曲面だけ true)。 */
      readonly measureAreas?: boolean;
      readonly check: (bodies: readonly SolidBodyMesh[]) => void;
    }

    /**
     * 検査する段の名前。`it` の登録は describe の時点で行うが、指紋を読むには
     * OCCT(`beforeAll` で読む)が要るので、依頼そのものは `caseFor` が実行時に作る。
     */
    const CASE_NAMES = [
      '押し出しの終端(次の面まで)',
      '押し出しのテーパ',
      '薄板押し出し',
      '抜き勾配',
      'ミラー',
      '移動/回転',
      '拡大縮小',
      'スイープ',
      'リブ',
      'リブ(材料まで伸ばさない)',
      'エンボス',
      'ざぐり穴',
      'ざぐりのねじ穴',
      '外ねじ(簡略)',
      '曲面(押し出し面)',
      '曲面(面のオフセット)',
      '切断',
      'くり抜き',
      '可変半径フィレット',
    ] as const;

    type StepCaseName = (typeof CASE_NAMES)[number];

    function caseFor(name: StepCaseName): StepCase {
      switch (name) {
        case '押し出しの終端(次の面まで)': {
          // 40×30 の断面をすっかり覆う板を z = 10 〜 20 に置き、下から「次の面まで」押す。
          // 板の中の 40·30·10 = 12000 mm³ だけが残る(makeSolidSweep.test.ts と同じ配置)。
          return {
            steps: [
              step(
                '上の板',
                'key-above',
                { kind: 'extrude', profile: rectangleAtZ(60, 50, 10), direction: [0, 0, 1], distance: 10 },
                false,
              ),
              step('押し出し1', 'key-to-next', {
                kind: 'extrude',
                profile: rectangle(40, 30),
                direction: [0, 0, 1],
                distance: 10,
                end: { kind: 'toNext' },
                targetKey: 'key-above',
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              expect(bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
            },
          };
        }
        case '押し出しのテーパ':
          return {
            steps: [
              step('押し出し1', 'key-taper', {
                kind: 'extrude',
                profile: rectangle(40, 30),
                direction: [0, 0, 1],
                distance: 10,
                taperAngle: FIVE_DEGREES,
                taperOutward: false,
              }),
            ],
            bodyCount: 1,
            built: 1,
            check: (bodies) => {
              // 内へ絞るので、傾けない押し出し(12000)より必ず小さくなる。
              expect(bodies[0].volume).toBeGreaterThan(0);
              expect(bodies[0].volume).toBeLessThan(EXTRUDE_VOLUME);
            },
          };
        case '薄板押し出し':
          return {
            steps: [
              step('押し出し1', 'key-thin', {
                kind: 'extrude',
                profile: rectangle(40, 30),
                direction: [0, 0, 1],
                distance: 10,
                thin: { thickness: 2, side: 'inner' },
              }),
            ],
            bodyCount: 1,
            built: 1,
            check: (bodies) => {
              // (40·30 − 36·26) · 10 = 2640 mm³(計画書 §2.12 の検証表)。
              expect(bodies[0].volume).toBeCloseTo(2640, 6);
            },
          };
        case '抜き勾配': {
          const { top, sides } = plateFaces(40, 30, 10);
          return {
            steps: [
              plateStep(),
              step('抜き勾配1', 'key-draft', {
                kind: 'draft',
                targetKey: 'key-plate',
                faces: sides,
                neutralFace: top,
                angle: FIVE_DEGREES,
                reversed: false,
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              // 外向き(reversed = false)なので下へ広がり、板より大きくなる。
              expect(bodies[0].volume).toBeGreaterThan(EXTRUDE_VOLUME);
            },
          };
        }
        case 'ミラー':
          return {
            // 対象を消費しない(§0.a-0.36)ので、板と鏡像の 2 ボディが残る。
            steps: [
              plateStep(true),
              step('ミラー1', 'key-mirror', {
                kind: 'mirror',
                targetKey: 'key-plate',
                origin: [0, 0, 0],
                normal: [1, 0, 0],
              }),
            ],
            bodyCount: 2,
            built: 2,
            check: (bodies) => {
              expect(bodies.map((body) => body.id)).toEqual(['板', 'ミラー1']);
              for (const body of bodies) {
                expect(body.volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
              }
              // 鏡像は x < 0 の側へ移る(もとの板は 0 ≦ x ≦ 40)。
              const mirrored = bodies[1].vertices.map((vertex) => vertex.position[0]);
              expect(Math.max(...mirrored)).toBeLessThanOrEqual(1e-9);
            },
          };
        case '移動/回転':
          return {
            steps: [
              plateStep(),
              step('移動1', 'key-transform', {
                kind: 'transform',
                targetKey: 'key-plate',
                translation: [100, 0, 0],
                rotationOrigin: [0, 0, 0],
                rotationAxis: [0, 0, 1],
                rotationAngle: 0,
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              expect(bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
              const xs = bodies[0].vertices.map((vertex) => vertex.position[0]);
              expect(Math.min(...xs)).toBeCloseTo(100, 6);
            },
          };
        case '拡大縮小':
          return {
            steps: [
              plateStep(),
              step('拡大1', 'key-scale', {
                kind: 'scale',
                targetKey: 'key-plate',
                origin: [0, 0, 0],
                uniform: 2,
                perAxis: null,
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              // 一様 2 倍なら体積は 2³ 倍(12000 → 96000)。
              expect(bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME * 8, 6);
            },
          };
        case 'スイープ':
          return {
            // 対象を取らない「作る」段。円 r=2 を長さ 50 の直線に沿って掃く。
            steps: [
              step('スイープ1', 'key-sweep', {
                kind: 'sweep',
                profile: [
                  {
                    kind: 'arc',
                    center: [0, 0, 0],
                    normal: [0, 0, 1],
                    xAxis: [1, 0, 0],
                    radius: 2,
                    startAngle: 0,
                    endAngle: 2 * Math.PI,
                  },
                ],
                path: [{ kind: 'segment', from: [0, 0, 0], to: [0, 0, 50] }],
                frenet: true,
              }),
            ],
            bodyCount: 1,
            built: 1,
            check: (bodies) => {
              // π·2²·50 = 628.3185307179587(計画書 §2.11 の検証表)。円は分割で近似されるので
              // 許容は makeSweep.test.ts と同じ相対 0.5%。
              const expected = Math.PI * 4 * 50;
              expect(Math.abs(bodies[0].volume - expected) / expected).toBeLessThan(0.005);
            },
          };
        case 'リブ':
          return {
            steps: [
              plateStep(),
              step('リブ1', 'key-rib', {
                kind: 'rib',
                targetKey: 'key-plate',
                // 板の 20 mm 上(z = 30)を横切る長さ 40 の線。下向きに伸ばして板へ当てる。
                profile: [{ kind: 'segment', from: [0, 15, 30], to: [40, 15, 30] }],
                normal: [0, 1, 0],
                thickness: 2,
                symmetric: true,
                direction: [0, 0, -1],
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              // 板 12000 + 壁(長さ 40 × 厚み 2 × 高さ 20 = 1600)= 13600(makeRib.test.ts と同じ)。
              expect(bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME + 1600, 6);
            },
          };
        case 'リブ(材料まで伸ばさない)':
          return {
            steps: [
              plateStep(),
              step('リブ2', 'key-rib-short', {
                kind: 'rib',
                targetKey: 'key-plate',
                profile: [{ kind: 'segment', from: [0, 15, 30], to: [40, 15, 30] }],
                normal: [0, 1, 0],
                thickness: 2,
                symmetric: true,
                direction: [0, 0, -1],
                // 輪郭の長さ(40)ぶんだけ伸ばす。板(z = 0〜10)を突き抜けるので壁は立つ。
                extendToBody: false,
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              // 伸ばす長さが変わっても、採る塊は「帯に接している塊」で同じなので 13600
              // (makeRib.test.ts が同じ配置で固定している)。
              expect(bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME + 1600, 6);
            },
          };
        case 'エンボス': {
          const { top } = plateFaces(40, 30, 10);
          return {
            steps: [
              plateStep(),
              step('エンボス1', 'key-emboss', {
                kind: 'emboss',
                targetKey: 'key-plate',
                face: top,
                profiles: [squareAt([20, 15, 10], 10)],
                depth: 2,
                raised: false,
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              // 12000 − 10·10·2 = 11800(計画書 §2.11 の検証表)。
              expect(bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME - 200, 6);
            },
          };
        }
        case 'ざぐり穴': {
          const { top } = plateFaces(40, 30, 10);
          return {
            steps: [
              plateStep(),
              step('穴1', 'key-counterbore', {
                kind: 'hole',
                targetKey: 'key-plate',
                face: top,
                centers: [[20, 15, 10]],
                diameter: 6,
                depth: null,
                tiltAngle: 0,
                tiltAzimuth: 0,
                transforms: [],
                entry: { kind: 'counterbore', diameter: 11, depth: 4 },
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              // 入口の指定が makeHole まで届いていれば、真っ直ぐな穴より必ず多く削れる。
              // ざぐりぶんの正確な値は makeHole.test.ts が固定している。
              expect(bodies[0].volume).toBeLessThan(EXTRUDE_VOLUME - PLAIN_HOLE_VOLUME);
              expect(bodies[0].volume).toBeGreaterThan(0);
            },
          };
        }
        case 'ざぐりのねじ穴': {
          const { top } = plateFaces(40, 30, 10);
          return {
            steps: [
              plateStep(),
              step('ねじ穴1', 'key-thread-counterbore', {
                kind: 'thread',
                targetKey: 'key-plate',
                face: top,
                centers: [[20, 15, 10]],
                // 下穴 φ6 で入口を φ11 深さ 4 に広げる(簡略表示なので実らせんは切らない)。
                drillDiameter: 6,
                depth: null,
                tiltAngle: 0,
                tiltAzimuth: 0,
                transforms: [],
                thread: null,
                mark: { majorDiameter: 8, length: 10 },
                entry: { kind: 'counterbore', diameter: 11, depth: 4 },
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              // 入口の指定が makeThreadHole まで届いていれば、真っ直ぐな下穴より多く削れる。
              // ざぐりぶんの正確な値は makeThread.test.ts が固定している。
              expect(bodies[0].volume).toBeLessThan(EXTRUDE_VOLUME - PLAIN_HOLE_VOLUME);
              expect(bodies[0].volume).toBeGreaterThan(0);
              // 印は入口があっても変わらない(§0.a-0.15)。
              expect(bodies[0].threadMarks).toHaveLength(1);
              expect(bodies[0].threadMarks[0].origin).toEqual([20, 15, 10]);
            },
          };
        }
        case '外ねじ(簡略)':
          return {
            steps: [
              step(
                '軸',
                'key-shaft',
                {
                  kind: 'primitive',
                  origin: [0, 0, 0],
                  axis: [0, 0, 1],
                  shape: { kind: 'cylinder', radius: 5, height: 20 },
                  originQuery: null,
                  targetKey: null,
                },
                false,
              ),
              step('外ねじ1', 'key-thread-shaft', {
                kind: 'threadShaft',
                targetKey: 'key-shaft',
                face: shaftSideFace(),
                majorDiameter: 10,
                pitch: 1.5,
                length: 10,
                fromEnd: 'first',
                modeled: false,
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              // 簡略表示は B-rep に触れないので体積はそのまま。印だけが 1 本増える(§0.a-0.15)。
              expect(bodies[0].volume).toBeCloseTo(SHAFT_VOLUME, 6);
              expect(bodies[0].threadMarks).toHaveLength(1);
              expect(bodies[0].threadMarks[0].majorDiameter).toBe(10);
              expect(bodies[0].threadMarks[0].length).toBe(10);
            },
          };
        case '曲面(押し出し面)':
          return {
            steps: [
              step('曲面1', 'key-surface', {
                kind: 'surface',
                shape: {
                  kind: 'extrude',
                  profile: [{ kind: 'segment', from: [0, 0, 0], to: [0, 40, 0] }],
                  direction: [0, 0, 1],
                  distance: 10,
                },
                targetKey: null,
              }),
            ],
            bodyCount: 1,
            built: 1,
            measureAreas: true,
            check: (bodies) => {
              // 長さ 40 の線を 10 掃いた面。面積 400 mm²・立体ではない(FR-428、§0.a-0.45)。
              expect(bodies[0].bodyKind).toBe('shell');
              expect(bodies[0].area).toBeCloseTo(400, 6);
            },
          };
        case '曲面(面のオフセット)':
          // 板の上面(z = 10、面積 1200)を +5 ずらした殻。**板は消費しない**ので
          // 画面には板と殻の 2 つが残る(§0.a-0.45、タスク42b)。
          return {
            steps: [
              plateStep(true),
              step('曲面1', 'key-offset', {
                kind: 'surface',
                shape: {
                  kind: 'offset',
                  face: plateFaces(40, 30, 10).top,
                  distance: 5,
                },
                targetKey: 'key-plate',
              }),
            ],
            bodyCount: 2,
            built: 2,
            measureAreas: true,
            check: (bodies) => {
              // 板はそのまま立体で残る(対象を消費しない段)。
              expect(bodies[0].bodyKind).toBe('solid');
              expect(bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
              // ずらした面は面だけの形。面積は makeSurface が測った値がそのまま載る。
              expect(bodies[1].bodyKind).toBe('shell');
              expect(bodies[1].area).toBeCloseTo(1200, 6);
            },
          };
        case '切断':
          return {
            steps: [
              plateStep(),
              step('切断1', 'key-cut', {
                kind: 'cut',
                targetKey: 'key-plate',
                origin: [20, 15, 5],
                normal: [1, 0, 0],
                keepPositive: true,
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              // 40 の板を真ん中で切って法線の側(x ≧ 20)を残すので半分の 6000。
              expect(bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME / 2, 6);
            },
          };
        case 'くり抜き': {
          const { top } = plateFaces(20, 20, 20);
          return {
            steps: [
              boxStep(),
              step('くり抜き1', 'key-shell', {
                kind: 'shell',
                targetKey: 'key-box',
                openFaces: [top],
                thickness: 2,
                outward: false,
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              // 20³ − 16·16·18 = 3392(計画書 §2.12 の検証表)。
              expect(bodies[0].volume).toBeCloseTo(BIG_VOLUME - 16 * 16 * 18, 6);
            },
          };
        }
        case '可変半径フィレット':
          return {
            steps: [
              boxStep(),
              step('丸め1', 'key-variable-fillet', {
                kind: 'fillet',
                targetKey: 'key-box',
                targets: [boxVerticalEdge()],
                radius: { start: 2, end: 5 },
              }),
            ],
            bodyCount: 1,
            built: 2,
            check: (bodies) => {
              // 一定 R2(8000 − 17.168… = 7982.83)と一定 R5(8000 − 107.30… = 7892.70)の
              // 間に入る。この 2 つの外側なら、半径の振り分け(FilletRadiusSpec)が
              // 効いていないことになる。正確な値は makeVariableFillet.test.ts が固定済み。
              const removedR2 = (1 - Math.PI / 4) * 20 * 2 * 2;
              const removedR5 = (1 - Math.PI / 4) * 20 * 5 * 5;
              expect(bodies[0].volume).toBeLessThan(BIG_VOLUME - removedR2);
              expect(bodies[0].volume).toBeGreaterThan(BIG_VOLUME - removedR5);
            },
          };
      }
    }

    for (const name of CASE_NAMES) {
      it(`${name} の 1 段だけの依頼が動く`, async () => {
        const { cache, built } = newCache();
        const testCase = caseFor(name);
        const result = await recomputeSolids(
          { oc, cache },
          testCase.measureAreas === true
            ? requestWithAreas(testCase.steps)
            : request(testCase.steps),
        );

        expect(result.failures).toEqual([]);
        expect(result.cancelled).toBe(false);
        expect(result.cacheHits).toBe(0);
        expect(result.bodies).toHaveLength(testCase.bodyCount);
        expect(built()).toBe(testCase.built);
        testCase.check(result.bodies);
      });
    }

    it('同じ依頼の 2 回目は、どの段も全件命中して作り直さない(NFR-PF-3)', async () => {
      for (const name of CASE_NAMES) {
        const { cache, built } = newCache();
        const testCase = caseFor(name);
        const payload =
          testCase.measureAreas === true
            ? requestWithAreas(testCase.steps)
            : request(testCase.steps);

        const first = await recomputeSolids({ oc, cache }, payload);
        const second = await recomputeSolids({ oc, cache }, payload);

        expect(first.failures).toEqual([]);
        expect(second.failures, name).toEqual([]);
        // 2 回目は 1 段も作り直さない(預けた件数が増えない)。
        expect(second.cacheHits, name).toBe(testCase.steps.length);
        expect(built(), name).toBe(testCase.built);
        expect(second.bodies, name).toHaveLength(testCase.bodyCount);
      }
    });

    it('「次の面まで」なのに相手の鍵が無ければ、理由を添えて断る(FR-504)', async () => {
      const { cache } = newCache();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          step('押し出し1', 'key-no-target', {
            kind: 'extrude',
            profile: rectangle(40, 30),
            direction: [0, 0, 1],
            distance: 10,
            end: { kind: 'toNext' },
            targetKey: null,
          }),
        ]),
      );

      expect(result.failures).toEqual([
        {
          id: '押し出し1',
          message: '「次の面まで」の相手になる立体が見つかりません。相手の立体を選び直してください。',
        },
      ]);
      expect(result.bodies).toEqual([]);
    });

    it('薄板押し出しに終端やテーパを一緒に頼まれたら、黙って無視せずに断る(FR-504)', async () => {
      const { cache } = newCache();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          step('押し出し1', 'key-thin-end', {
            kind: 'extrude',
            profile: rectangle(40, 30),
            direction: [0, 0, 1],
            distance: 10,
            thin: { thickness: 2, side: 'inner' },
            end: { kind: 'symmetric', forward: 5, backward: 5 },
          }),
        ]),
      );

      expect(result.failures).toEqual([
        {
          id: '押し出し1',
          message:
            '薄い板の押し出しでは、終端の指定と側面の傾きは使えません。厚みを外すか、指定を外してください。',
        },
      ]);
      expect(result.bodies).toEqual([]);
    });

    it('作れない段があっても後の段は続く(P5 の段も FR-504 の扱いは同じ)', async () => {
      const { cache } = newCache();
      const result = await recomputeSolids(
        { oc, cache },
        request([
          // 対象がどこにも無い切断。ブーリアン・加工と同じ文言で断る。
          step('切断1', 'key-cut-missing', {
            kind: 'cut',
            targetKey: 'key-missing',
            origin: [0, 0, 0],
            normal: [1, 0, 0],
            keepPositive: true,
          }),
          extrudeStep('押し出し1', 'key-after', 40, 30, 10),
        ]),
      );

      expect(result.failures).toEqual([
        { id: '切断1', message: 'もとになる立体が見つかりませんでした。' },
      ]);
      expect(result.bodies).toHaveLength(1);
      expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
    });

    it('スイープと実らせんの外ねじは掃引体向けの粗いテッセレーションを使う(§2.13)', async () => {
      const { cache } = newCache();
      const sweep: SolidStepSpec = {
        kind: 'sweep',
        profile: [
          {
            kind: 'arc',
            center: [0, 0, 0],
            normal: [0, 0, 1],
            xAxis: [1, 0, 0],
            radius: 2,
            startAngle: 0,
            endAngle: 2 * Math.PI,
          },
        ],
        path: [{ kind: 'segment', from: [0, 0, 0], to: [0, 0, 50] }],
        frenet: true,
      };

      const relaxed = await recomputeSolids({ oc, cache }, request([step('掃引1', 'key-sweep-a', sweep)]));
      // 段ごとの指定(P5 §2.13)は種類ごとの既定より優先されるので、細かい値を添えると増える。
      const fine = await recomputeSolids(
        { oc, cache },
        request([
          {
            ...step('掃引2', 'key-sweep-b', sweep),
            tessellation: { linearDeflection: 0.1, angularDeflection: 0.5 },
          },
        ]),
      );

      expect(relaxed.failures).toEqual([]);
      expect(fine.failures).toEqual([]);
      expect(fine.bodies[0].triangleCount).toBeGreaterThan(relaxed.bodies[0].triangleCount);
    });
  });

  /*
   * 読み込んだ形(FR-802、P6 §2.8、タスク10)。
   *
   * 三角形の形(`bodyKind: 'mesh'`)は B-rep へ変換しない(§0.a-0.23)ので、
   * **段の材料にできない**。断りは `findStepInput` の 1 か所だけにあり、上流の形を
   * 触る段は例外なくそこを通る——だから「削る段」と「借りるだけの段」の両方が
   * 同じ文言で断ることを、この 1 つの検査で確かめる。
   *
   * `bodyKind: 'mesh'` のボディを作るのは model 側(`importedMesh`、タスク20)で
   * kernel の段には無いため、キャッシュへ直に預けて作る(検査がキャッシュを
   * 注入できるようにしてあるのはこのためでもある。`SolidRecomputeDeps` の注釈)。
   */
  describe('読み込んだ三角形の形(bodyKind: mesh)は段の材料にできない(P6 §0.a-0.23)', () => {
    /** 段 1 つを組み立てる(上の入れ子の describe の `step` と同じ形)。 */
    function meshStep(id: string, key: string, spec: SolidStepSpec): SolidStepRequest {
      return { key, id, label: id, visible: true, step: spec };
    }

    /** 40×30×10 の板を、`bodyKind` だけ `'mesh'` に差し替えてキャッシュへ預ける。 */
    function putMeshBody(cache: ShapeCache<CachedSolid>, key: string): void {
      const handle = makeExtrudeSolid(
        oc,
        { kind: 'extrude', profile: rectangle(40, 30), direction: [0, 0, 1], distance: 10 },
        {},
      );
      const mesh = buildSolidBodyMesh(oc, '読み込んだ三角形の形', handle.shape);
      cache.set(key, {
        shape: handle.shape,
        mesh: { ...mesh, bodyKind: 'mesh' },
        delete(): void {
          handle.delete();
        },
      });
    }

    it('削る段(切断)も借りるだけの段(ミラー)も、同じ 1 つの文言で断る', async () => {
      const { cache } = newCache();
      putMeshBody(cache, 'key-mesh-body');

      const result = await recomputeSolids(
        { oc, cache },
        request([
          meshStep('切断1', 'key-mesh-cut', {
            kind: 'cut',
            targetKey: 'key-mesh-body',
            origin: [20, 15, 5],
            normal: [0, 0, 1],
            keepPositive: false,
          }),
          meshStep('ミラー1', 'key-mesh-mirror', {
            kind: 'mirror',
            targetKey: 'key-mesh-body',
            origin: [0, 0, 0],
            normal: [1, 0, 0],
          }),
          // 断りが下流を巻き込まないことも一緒に確かめる(FR-504)。
          extrudeStep('押し出し1', 'key-mesh-after', 40, 30, 10),
        ]),
      );

      expect(result.failures).toEqual([
        { id: '切断1', message: '読み込んだ三角形の形には、穴あけや面取りはできません。' },
        { id: 'ミラー1', message: '読み込んだ三角形の形には、穴あけや面取りはできません。' },
      ]);
      expect(result.bodies).toHaveLength(1);
      expect(result.bodies[0].id).toBe('押し出し1');
      expect(result.bodies[0].volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
    });
  });

});
