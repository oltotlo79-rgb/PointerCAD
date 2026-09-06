import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { extractEdges } from '../occt/extractEdges.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { makeExtrudeSolid } from '../occt/makeSolidSweep.js';
import { collectSubShapes } from '../occt/subShapes.js';
import { tessellate } from '../occt/tessellate.js';
import type { StepWriteEntry } from '../occt/writeStep.js';
import { writeStep } from '../occt/writeStep.js';
import type {
  CurveSpec,
  FilletStepSpec,
  HoleStepSpec,
  SolidBodyMesh,
  SolidEdgeInfo,
  SolidFaceInfo,
  SolidRecomputeRequest,
  SolidStepRequest,
  SolidStepSpec,
  SubShapeQuery,
} from '../types.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache, type ShapeCache } from './shapeCache.js';

/**
 * 決定性検査(`rules/03-品質ゲート.md` §7.1 が P6 に予定していたもの、
 * `docs/plans/P6-入出力.md` §0.a-0.62)。
 *
 * 「同じ部品文書から、いつ・何回作っても同じ形ができる」ことを、
 * ①体積・面数・辺数・頂点数・境界箱(6 値)の一致、②STEP のヘッダの時刻の行を
 * 除いたバイト列の一致、の 2 通りで固定する。段は増やさず `pnpm run test`(kernel の
 * vitest)にそのまま入る(§0.61、`recomputeSolids.test.ts` の隣に置く)。
 *
 * **手順1 の実測: STEP のヘッダで時刻が入るのは 4 行目(`FILE_NAME(...)`)だけ**
 * (`writeStep.ts` の実測コメントと `writeStep.test.ts` の既存の決定性検査(219 行目
 * 付近)のとおり)。ここでもその 1 行だけを除いて比べる。
 *
 * **改行の分け方は `/\r?\n/`(`\r\n` も `\n` も同じ 1 行の区切りとして扱う)に決める。**
 * `writeStep.test.ts` の既存の決定性検査と同じ正規表現に揃えることで、
 * 判定の基準を検査間でぶらさない。
 *
 * **別プロセス性の限界(手順3 のとおり注釈に書く)。** WASM(opencascade.js)の読み込みは
 * 1 プロセスにつき実質 1 回しかできない(`beforeAll` で 1 度だけ `loadOcctForNode` する、
 * 既存の検査と同じ流儀。`vitest.config.ts` も `fileParallelism: false` で OCCT を
 * 1 インスタンスだけ共有する前提を敷いている)。そのため「いつ作っても」のうち
 * **「別プロセスでも」までは、この検査では示せない**。ここで固定するのは
 * **「同じプロセスの中で、新しいキャッシュから独立に 2 回計算しても同じ形になる」こと**
 * だけである。2 回とも新しい `createShapeCache` を使い、`cacheHits` が 0 件であることも
 * 確かめる(キャッシュの当たりで同じ結果が返るのは決定性の証拠にならないため)。
 */
describe('決定性検査(recomputeSolids と writeStep、§0.62)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  // OCCT の形は JavaScript の回収の対象外なので、検査ごとに預けたキャッシュを手放す
  // (recomputeSolids.test.ts の openCaches / afterEach と同じ流儀)。
  const openCaches: ShapeCache<CachedSolid>[] = [];

  afterEach(() => {
    for (const cache of openCaches.splice(0)) {
      cache.clear();
    }
  });

  function newCache(): ShapeCache<CachedSolid> {
    const cache = createShapeCache<CachedSolid>();
    openCaches.push(cache);
    return cache;
  }

  // ---------------------------------------------------------------------------
  // ここから下は `recomputeSolids.test.ts` の同名の道具を写したもの(このファイルから
  // import できる形で輸出されていないため。指示により他のファイルは変えない)。
  // ---------------------------------------------------------------------------

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

  /** 段 1 つを依頼の形にする(種類を選ばない汎用の包み)。 */
  function step(id: string, key: string, spec: SolidStepSpec, visible = true): SolidStepRequest {
    return { key, id, label: id, visible, step: spec };
  }

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
   * 40 × 30 を 10 押し出した板(体積 12000)を実際に作り、上の面(z = 10)の指紋と、
   * 原点の角の垂直辺の指紋を読み取る(`recomputeSolids.test.ts` の `plateFingerprints` と
   * 同じ考え方。別々に作っても TopExp.MapShapes_2 の並びは一致する、決定的な構築)。
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
    const spec: HoleStepSpec = {
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
    return { key, id, label: id, visible, step: spec };
  }

  /** R 面取りの段を 1 つ作る。 */
  function filletStep(
    id: string,
    key: string,
    targetKey: string,
    targets: readonly SubShapeQuery[],
    radius: number,
  ): SolidStepRequest {
    const spec: FilletStepSpec = { kind: 'fillet', targetKey, targets, radius };
    return { key, id, label: id, visible: true, step: spec };
  }

  /**
   * y = 0 の平面(XZ 面)に置いた長方形。x: 10 → 20、z: 0 → 5。
   * `makeSolidSweep.test.ts` の `RECTANGLE_XZ` と同じ値(Z 軸まわりに 1 周回すと
   * 中空の円筒になり、体積はパップスの定理で 2π·15·50 = 1500π = 4712.3889803846896、
   * 同ファイルの実測と一致する)。
   */
  const RECTANGLE_XZ: readonly CurveSpec[] = [
    { kind: 'segment', from: [10, 0, 0], to: [20, 0, 0] },
    { kind: 'segment', from: [20, 0, 0], to: [20, 0, 5] },
    { kind: 'segment', from: [20, 0, 5], to: [10, 0, 5] },
    { kind: 'segment', from: [10, 0, 5], to: [10, 0, 0] },
  ];

  /**
   * この決定性検査で使う部品文書(5 段、計画書の指示どおり押し出し→穴→フィレット→
   * 鏡像→回転): ①押し出し(40×30×10 の板、消費される)②穴(φ6 貫通、消費される)
   * ③ R 面取り(原点の角、半径 2)④鏡像(x < 0 側へ、対象を消費しない、§0.a-0.36)
   * ⑤回転(中空円筒、対象を取らない「作る」段)。
   *
   * 呼ぶたびに新しい配列・新しい指紋(`plateFingerprints()`)を組み立てる
   * (同じオブジェクトの使い回しで決定性を偽装しないため)。
   */
  function buildSteps(): readonly SolidStepRequest[] {
    const { topFace, cornerEdge } = plateFingerprints();
    return [
      extrudeStep('押し出し1', 'key-plate', 40, 30, 10, false),
      holeStep('穴1', 'key-hole', 'key-plate', topFace, {}, false),
      filletStep('面取り1', 'key-fillet', 'key-hole', [cornerEdge], 2),
      step('鏡像1', 'key-mirror', {
        kind: 'mirror',
        targetKey: 'key-fillet',
        origin: [0, 0, 0],
        normal: [1, 0, 0],
      }),
      step('回転1', 'key-revolve', {
        kind: 'revolve',
        profile: RECTANGLE_XZ,
        axisOrigin: [0, 0, 0],
        axisDirection: [0, 0, 1],
        angle: 2 * Math.PI,
      }),
    ];
  }

  function request(): SolidRecomputeRequest {
    return { steps: buildSteps(), generation: 1 };
  }

  /** 最終形として画面に出るボディの鍵(文書の並びのまま)。STEP の書き出しにも使う。 */
  const VISIBLE_KEYS = ['key-fillet', 'key-mirror', 'key-revolve'] as const;

  /**
   * ボディの境界箱(6 値: [minX, minY, minZ, maxX, maxY, maxZ])。
   *
   * `SolidBodyMesh` に境界箱の欄は無いので、`positions`(頂点座標、実測して固定した形)
   * から実測する。テッセレーションが決定的であれば(§0.a-0.62 が前提とするとおり)、
   * 2 回の再計算で同じ Float32Array の値になるので、6 値もビットまで一致するはず。
   */
  function boundingBoxOf(
    body: SolidBodyMesh,
  ): readonly [number, number, number, number, number, number] {
    const positions = body.positions;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < positions.length; index += 3) {
      const x = positions[index];
      const y = positions[index + 1];
      const z = positions[index + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    return [minX, minY, minZ, maxX, maxY, maxZ];
  }

  /** 決定性の比較に使う 1 ボディぶんの指紋(体積・面数・辺数・頂点数・境界箱)。 */
  interface BodyFingerprint {
    readonly id: string;
    readonly volume: number;
    readonly faceCount: number;
    readonly edgeCount: number;
    readonly vertexCount: number;
    readonly boundingBox: readonly [number, number, number, number, number, number];
  }

  function fingerprintOf(body: SolidBodyMesh): BodyFingerprint {
    return {
      id: body.id,
      volume: body.volume,
      faceCount: body.faceCount,
      edgeCount: body.edgeCount,
      vertexCount: body.vertices.length,
      boundingBox: boundingBoxOf(body),
    };
  }

  it('同じ文書を2回再計算すると体積・面数・辺数・頂点数・境界箱が一致する(決定性、§0.62)', async () => {
    const first = await recomputeSolids({ oc, cache: newCache() }, request());
    const second = await recomputeSolids({ oc, cache: newCache() }, request());

    expect(first.failures).toEqual([]);
    expect(second.failures).toEqual([]);
    // 新しいキャッシュから2回とも作っている(キャッシュの当たりで同じ結果が返るのは
    // 決定性の証拠にならないため、当たりが0件であることも確かめる)。
    expect(first.cacheHits).toBe(0);
    expect(second.cacheHits).toBe(0);
    expect(first.bodies.map((body) => body.id)).toEqual(['面取り1', '鏡像1', '回転1']);
    expect(second.bodies.map((body) => body.id)).toEqual(['面取り1', '鏡像1', '回転1']);

    const firstFingerprints = first.bodies.map(fingerprintOf);
    const secondFingerprints = second.bodies.map(fingerprintOf);

    // 報告のための実測値(体積・面数・辺数・頂点数・境界箱)を残す。
    for (const fingerprint of firstFingerprints) {
      console.log(
        `決定性検査(形状)の実測: ${fingerprint.id} 体積=${fingerprint.volume} ` +
          `面=${fingerprint.faceCount} 辺=${fingerprint.edgeCount} 頂点=${fingerprint.vertexCount} ` +
          `境界箱=[${fingerprint.boundingBox.join(', ')}]`,
      );
    }

    // 近似ではなく完全一致(toEqual)で固定する。ここが崩れたら「事実として記録して
    // 報告」し、許容誤差を足して通す形にはしない(指示・rules/02-禁止事項.md)。
    expect(secondFingerprints).toEqual(firstFingerprints);
  });

  it('同じ文書を2回STEPへ書き出すと、時刻の行(4行目)を除いてバイト列が一致する(決定性、§0.62)', async () => {
    const cacheA = newCache();
    const cacheB = newCache();
    const resultA = await recomputeSolids({ oc, cache: cacheA }, request());
    const resultB = await recomputeSolids({ oc, cache: cacheB }, request());

    expect(resultA.failures).toEqual([]);
    expect(resultB.failures).toEqual([]);

    // 最終形の3ボディだけを書き出す(押し出し・穴の中間段は消費されて画面に出ない
    // ので書かない)。鍵はこの検査で自分で決めた文書のものなので、直接キャッシュから引く。
    function entriesFrom(cache: ShapeCache<CachedSolid>): readonly StepWriteEntry[] {
      return VISIBLE_KEYS.map((key) => {
        const cached = cache.get(key);
        if (cached === undefined) {
          throw new Error(`決定性検査: キャッシュに ${key} がありませんでした`);
        }
        return { shape: cached.shape, name: key, color: null };
      });
    }

    const bytesA = writeStep(oc, entriesFrom(cacheA)).bytes;
    const bytesB = writeStep(oc, entriesFrom(cacheB)).bytes;

    const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
    // 改行は \r\n も \n も同一視して split する(writeStep.test.ts の既存の決定性検査と
    // 同じ /\r?\n/ に揃える。上の説明のとおり、この判断は注釈に固定した)。
    const linesA = decode(bytesA).split(/\r?\n/);
    const linesB = decode(bytesB).split(/\r?\n/);

    // 手順1: まず4行目が本当にFILE_NAMEで始まり時刻を含むことを確かめる
    // (writeStep.test.ts の既存の決定性検査と同じ正規表現)。
    const fileNamePattern = /^FILE_NAME\('Open CASCADE Shape Model','\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'/;
    expect(linesA[3]).toMatch(fileNamePattern);
    expect(linesB[3]).toMatch(fileNamePattern);

    expect(linesB).toHaveLength(linesA.length);
    const differingLines: number[] = [];
    for (let index = 0; index < linesA.length; index += 1) {
      if (linesA[index] !== linesB[index]) {
        differingLines.push(index + 1);
      }
    }
    // 違ってよいのは時刻を含む4行目だけ(同じ秒に書ければ0行のこともある)。
    expect(differingLines.filter((line) => line !== 4)).toEqual([]);

    console.log(
      `決定性検査(STEP)の実測: ${bytesA.length} バイト / 4行目: ${linesA[3]} / ` +
        `違う行: [${differingLines.join(', ')}]`,
    );
  });
});
