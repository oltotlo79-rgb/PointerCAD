/**
 * `buildSolidGeometry` と、サムネイルの純関数部分(`file/thumbnail.ts`)の検査
 * (計画書 docs/plans/P2-ソリッド基礎.md タスク20)。
 *
 * どちらも three.js にも DOM にも触れないので Node のまま検査できる。
 * サムネイルの検査をここへ同居させているのは、タスク20 で作ってよいファイルが
 * 6 つに限られているため(統括の指示書 §1)。canvas を触る `captureThumbnailPng` は
 * 実ブラウザでしか動かないので、E2E と統括の目視に任せる。
 *
 * P5 タスク7(計画書 docs/plans/P5-高度なソリッド・外観と測定.md)で、箱投影 UV
 * (`buildBoxProjectedUv`、FR-1108)と面のまとまり(FR-1106)の検査を足した。
 */

import {
  appearanceFromPreset,
  DEFAULT_APPEARANCE,
  type AppearanceSpec,
  type SolidBody,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { dataUrlToBytes, THUMBNAIL_SIZE, thumbnailFitRect } from '../file/thumbnail.js';
import type { SolidFaceEntry } from '../solid/subShapeSelection.js';

import {
  buildBoxProjectedUv,
  buildSolidGeometry,
  EMPTY_SOLID_GEOMETRY,
  solidEmphasisOf,
  type AppearanceInput,
  type BodyAppearanceInput,
  type SolidBodyWithSubShapes,
  type SolidGeometryBundle,
} from './buildSolidGeometry.js';

/**
 * 性能上限の判定を「厳密」と「参考」で切り替える窓口。
 *
 * `packages/kernel/src/worker/solidPerformance.test.ts` の `expectWithinBudget` と同じ形。
 * ui 側にはまだ同等の共有ヘルパーが無いため、この検査ファイルの中に同じ形の小さな補助を
 * 置く(2 か所目。既存の前例を再利用せず複製したことを報告する)。
 * 環境変数 `POINTERCAD_PERF_STRICT` が `'1'` のときだけ `expect(...).toBeLessThan(...)` で
 * 厳密に判定してテストを落とす(push前検査・CI。rules/03-品質ゲート.md §7.1)。
 * それ以外(コミット前検査の既定)は実測値の記録にとどめ、上限超過でも失敗にしない
 * (rules/06-過去の失敗と対策.md 10.3)。上限の数値と検査内容は変えない。
 */
function expectWithinBudget(actualMs: number, limitMs: number, label: string): void {
  if (process.env.POINTERCAD_PERF_STRICT === '1') {
    expect(actualMs).toBeLessThan(limitMs);
    return;
  }
  if (actualMs >= limitMs) {
    console.log(
      `[参考] 上限超過: ${label}(実測 ${actualMs.toFixed(3)} ms ≥ 上限 ${limitMs} ms。コミット前検査のため失敗にしません)`,
    );
  }
}

/**
 * 検査用のボディ。三角形の数と稜線の本数だけを指定し、中身は 0 のままにする
 * (組み立てが見ているのは長さと参照だけで、座標の値は見ていない)。
 */
function makeBody(
  featureId: string,
  triangleCount: number,
  edgeCount: number,
  isValid = true,
): SolidBody {
  const indices = new Uint32Array(triangleCount * 3);
  for (let position = 0; position < indices.length; position += 1) {
    indices[position] = position;
  }
  return {
    featureId,
    mesh: {
      positions: new Float32Array(triangleCount * 9),
      normals: new Float32Array(triangleCount * 9),
      indices,
      edgePositions: new Float32Array(edgeCount * 6),
      triangleCount,
    },
    volume: 1000,
    isValid,
    // P3 タスク17 で SolidBody に必須で足された欄。この検査では中身を使わない。
    faces: [],
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

/** 数値だけを取り出して比べる(Float32Array の中身は別に確かめる)。 */
function shapeOf(bundle: SolidGeometryBundle): unknown {
  return {
    triangleCount: bundle.triangleCount,
    edgeCount: bundle.edgeCount,
    entries: bundle.entries.map((entry) => ({
      featureId: entry.featureId,
      emphasis: entry.emphasis,
      drawIndex: entry.drawIndex,
      triangleOffset: entry.triangleOffset,
      triangleCount: entry.triangleCount,
      edgeOffset: entry.edgeOffset,
      edgeCount: entry.edgeCount,
    })),
  };
}

describe('buildSolidGeometry(FR-105、FR-106)', () => {
  it('ボディが 1 つも無ければ空の結果になる', () => {
    const bundle = buildSolidGeometry([], null, []);
    expect(bundle.entries).toEqual([]);
    expect(bundle.triangleCount).toBe(0);
    expect(bundle.edgeCount).toBe(0);
    expect(bundle.index.size).toBe(0);
    expect(shapeOf(bundle)).toEqual(shapeOf(EMPTY_SOLID_GEOMETRY));
  });

  it('ボディ 2 つの三角形と稜線を合計し、通し番号の始まりを持つ', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 4, 12), makeBody('revolve-1', 2, 6)],
      null,
      [],
    );
    expect(bundle.entries.length).toBe(2);
    expect(bundle.triangleCount).toBe(6);
    expect(bundle.edgeCount).toBe(18);
    expect(shapeOf(bundle)).toEqual({
      triangleCount: 6,
      edgeCount: 18,
      entries: [
        {
          featureId: 'extrude-1',
          emphasis: 'none',
          drawIndex: 0,
          triangleOffset: 0,
          triangleCount: 4,
          edgeOffset: 0,
          edgeCount: 12,
        },
        {
          featureId: 'revolve-1',
          emphasis: 'none',
          drawIndex: 1,
          triangleOffset: 4,
          triangleCount: 2,
          edgeOffset: 12,
          edgeCount: 6,
        },
      ],
    });
  });

  it('バッファの長さが三角形・稜線の数と合う', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 4, 12)], null, []);
    const entry = bundle.entries[0];
    expect(entry.indices.length).toBe(12);
    expect(entry.positions.length).toBe(36);
    expect(entry.normals.length).toBe(36);
    expect(entry.edgePositions.length).toBe(72);
    expect(entry.edgeCount).toBe(entry.edgePositions.length / 6);
  });

  it('並びは写さずカーネルが返したものをそのまま指す(NFR-PF-1)', () => {
    const body = makeBody('extrude-1', 2, 3);
    const entry = buildSolidGeometry([body], null, []).entries[0];
    expect(entry.positions).toBe(body.mesh.positions);
    expect(entry.normals).toBe(body.mesh.normals);
    expect(entry.indices).toBe(body.mesh.indices);
    expect(entry.edgePositions).toBe(body.mesh.edgePositions);
  });

  it('対応表から featureId で描画の範囲を引ける', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 4, 12), makeBody('revolve-1', 2, 6)],
      null,
      [],
    );
    expect([...bundle.index.keys()]).toEqual(['extrude-1', 'revolve-1']);
    expect(bundle.index.get('revolve-1')).toBe(bundle.entries[1]);
    expect(bundle.index.get('revolve-1')?.triangleOffset).toBe(4);
    expect(bundle.index.get('missing')).toBeUndefined();
  });

  it('ホバー中のボディだけが hovered になる', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 1, 1), makeBody('revolve-1', 1, 1)],
      'revolve-1',
      [],
    );
    expect(bundle.entries.map((entry) => entry.emphasis)).toEqual(['none', 'hovered']);
  });

  it('選択中のボディが selected になり、ホバーと重なったら選択を優先する', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 1, 1), makeBody('revolve-1', 1, 1), makeBody('cut-1', 1, 1)],
      'revolve-1',
      ['revolve-1', 'cut-1'],
    );
    expect(bundle.entries.map((entry) => entry.emphasis)).toEqual([
      'none',
      'selected',
      'selected',
    ]);
  });

  it('スケッチの要素 id が混ざっていてもボディは強調されない', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 1, 1)],
      'point-1',
      ['point-1', 'pa1#0', 'extrude-10'],
    );
    expect(bundle.entries[0].emphasis).toBe('none');
  });

  it('立体になっていないボディ(isValid が false)は描かない', () => {
    const bundle = buildSolidGeometry(
      [makeBody('extrude-1', 4, 12, false), makeBody('revolve-1', 2, 6)],
      null,
      [],
    );
    expect(bundle.entries.map((entry) => entry.featureId)).toEqual(['revolve-1']);
    expect(bundle.triangleCount).toBe(2);
    expect(bundle.entries[0].drawIndex).toBe(0);
  });

  it('三角形も稜線も無いボディは描かない', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 0, 0)], null, []);
    expect(bundle.entries).toEqual([]);
    expect(bundle.index.size).toBe(0);
  });

  it('稜線だけのボディは描く(ワイヤーフレーム表示のため)', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 0, 4)], null, []);
    expect(bundle.entries.length).toBe(1);
    expect(bundle.entries[0].triangleCount).toBe(0);
    expect(bundle.entries[0].edgeCount).toBe(4);
  });

  it('同じ id のボディが 2 つ来たら先のものだけを描く(§0.a-0.5)', () => {
    const first = makeBody('extrude-1', 4, 12);
    const bundle = buildSolidGeometry([first, makeBody('extrude-1', 2, 6)], null, []);
    expect(bundle.entries.length).toBe(1);
    expect(bundle.entries[0].indices).toBe(first.mesh.indices);
    expect(bundle.triangleCount).toBe(4);
  });

  it('同じ入力を 2 回組み立てると同じ結果になる(決定性)', () => {
    const bodies = [makeBody('extrude-1', 4, 12), makeBody('revolve-1', 2, 6)];
    const first = buildSolidGeometry(bodies, 'extrude-1', ['revolve-1']);
    const second = buildSolidGeometry(bodies, 'extrude-1', ['revolve-1']);
    expect(shapeOf(second)).toEqual(shapeOf(first));
    expect(second.entries[0].positions).toBe(first.entries[0].positions);
  });

  it('faces/edges/vertices を持たないボディ(タスク17 前)は、エントリの範囲表が空配列になる(計画書タスク22)', () => {
    const bundle = buildSolidGeometry([makeBody('extrude-1', 4, 12)], null, []);
    expect(bundle.entries[0].faces).toEqual([]);
    expect(bundle.entries[0].edges).toEqual([]);
    expect(bundle.entries[0].vertices).toEqual([]);
  });

  it('faces/edges/vertices を持つボディは、エントリがその参照をそのまま持つ(タスク22、写さない)', () => {
    const face: SolidFaceEntry = {
      index: 0,
      surfaceKind: 'plane',
      area: 10,
      centroid: [0, 0, 0],
      axis: [0, 0, 1],
      radius: null,
      triangleOffset: 0,
      triangleCount: 4,
    };
    const body: SolidBodyWithSubShapes = { ...makeBody('extrude-1', 4, 12), faces: [face], edges: [], vertices: [] };
    const bundle = buildSolidGeometry([body], null, []);
    expect(bundle.entries[0].faces).toBe(body.faces);
    expect(bundle.entries[0].edges).toBe(body.edges);
    expect(bundle.entries[0].vertices).toBe(body.vertices);
  });
});

describe('solidEmphasisOf(FR-106)', () => {
  it('選択 > ホバー > なし の順に強い', () => {
    expect(solidEmphasisOf('extrude-1', null, new Set())).toBe('none');
    expect(solidEmphasisOf('extrude-1', 'extrude-1', new Set())).toBe('hovered');
    expect(solidEmphasisOf('extrude-1', 'extrude-1', new Set(['extrude-1']))).toBe('selected');
    expect(solidEmphasisOf('extrude-1', 'revolve-1', new Set(['extrude-1']))).toBe('selected');
  });
});

describe('サムネイルの大きさ(§0.a-0.18)', () => {
  it('一辺の上限は 256', () => {
    expect(THUMBNAIL_SIZE).toBe(256);
  });

  it('横長の絵は幅を合わせ、上下を余白にする', () => {
    expect(thumbnailFitRect(800, 600)).toEqual({ x: 0, y: 32, width: 256, height: 192 });
  });

  it('縦長の絵は高さを合わせ、左右を余白にする', () => {
    expect(thumbnailFitRect(600, 800)).toEqual({ x: 32, y: 0, width: 192, height: 256 });
  });

  it('正方形は余白なしで埋まる', () => {
    expect(thumbnailFitRect(512, 512)).toEqual({ x: 0, y: 0, width: 256, height: 256 });
  });

  it('元が小さいときは拡大せず中央に置く', () => {
    expect(thumbnailFitRect(100, 50)).toEqual({ x: 78, y: 103, width: 100, height: 50 });
  });

  it('大きさが決められないときは null', () => {
    expect(thumbnailFitRect(0, 600)).toBeNull();
    expect(thumbnailFitRect(800, -1)).toBeNull();
    expect(thumbnailFitRect(800, 600, 0)).toBeNull();
    expect(thumbnailFitRect(Number.NaN, 600)).toBeNull();
  });
});

describe('サムネイルのバイト列(§0.a-0.18)', () => {
  it('PNG の data URL をバイト列へ直す', () => {
    // "iVBORw0KGgo=" は PNG の署名 8 バイトそのもの。
    const bytes = dataUrlToBytes('data:image/png;base64,iVBORw0KGgo=');
    expect(bytes).not.toBeNull();
    expect([...(bytes ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('中身が空でも空のバイト列を返す', () => {
    expect(dataUrlToBytes('data:image/png;base64,')?.length).toBe(0);
  });

  it('PNG でない data URL は受け取らない', () => {
    expect(dataUrlToBytes('data:image/jpeg;base64,iVBORw0KGgo=')).toBeNull();
    expect(dataUrlToBytes('')).toBeNull();
  });

  it('base64 が壊れていたら例外を投げずに null を返す', () => {
    expect(dataUrlToBytes('data:image/png;base64,!!!!')).toBeNull();
  });
});

/** 箱の面 1 枚(頂点 4・三角形 2)。角が原点の w×d×h の箱を面 6 枚で作るための材料。 */
interface BoxFace {
  readonly corners: readonly (readonly [number, number, number])[];
  readonly normal: readonly [number, number, number];
}

/**
 * 角が原点の w×d×h の箱。面の並びは 上(+Z)・下(-Z)・前(-Y)・後(+Y)・左(-X)・右(+X)。
 * 面ごとに頂点 4・三角形 2 で、面の範囲表(`SolidFaceEntry`)も同じ並びで作る。
 */
function makeBoxBody(
  featureId: string,
  width: number,
  depth: number,
  height: number,
): SolidBodyWithSubShapes {
  const w = width;
  const d = depth;
  const h = height;
  const boxFaces: readonly BoxFace[] = [
    { corners: [[0, 0, h], [w, 0, h], [w, d, h], [0, d, h]], normal: [0, 0, 1] },
    { corners: [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0]], normal: [0, 0, -1] },
    { corners: [[0, 0, 0], [w, 0, 0], [w, 0, h], [0, 0, h]], normal: [0, -1, 0] },
    { corners: [[0, d, 0], [w, d, 0], [w, d, h], [0, d, h]], normal: [0, 1, 0] },
    { corners: [[0, 0, 0], [0, d, 0], [0, d, h], [0, 0, h]], normal: [-1, 0, 0] },
    { corners: [[w, 0, 0], [w, d, 0], [w, d, h], [w, 0, h]], normal: [1, 0, 0] },
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faces: SolidFaceEntry[] = [];
  boxFaces.forEach((face, faceIndex) => {
    const base = faceIndex * 4;
    for (const corner of face.corners) {
      positions.push(corner[0], corner[1], corner[2]);
      normals.push(face.normal[0], face.normal[1], face.normal[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    faces.push({
      index: faceIndex,
      surfaceKind: 'plane',
      area: 1,
      centroid: [0, 0, 0],
      axis: [face.normal[0], face.normal[1], face.normal[2]],
      radius: null,
      triangleOffset: faceIndex * 2,
      triangleCount: 2,
    });
  });

  return {
    featureId,
    mesh: {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      indices: Uint32Array.from(indices),
      edgePositions: new Float32Array(12 * 6),
      triangleCount: 12,
    },
    volume: w * d * h,
    isValid: true,
    faces,
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

/** 面 1 枚だけに外観を割り当てた入力を作る。 */
function appearanceInputFor(
  featureId: string,
  faceAppearances: ReadonlyMap<number, AppearanceSpec>,
  bodyAppearance: AppearanceSpec | null = null,
): AppearanceInput {
  const entry: BodyAppearanceInput = { bodyAppearance, faceAppearances };
  return {
    defaultAppearance: DEFAULT_APPEARANCE,
    byBody: new Map([[featureId, entry]]),
  };
}

/** 頂点 1 つぶんの UV を読み出す。 */
function uvAt(uv: Float32Array, vertex: number): readonly [number, number] {
  return [uv[vertex * 2], uv[vertex * 2 + 1]];
}

describe('buildBoxProjectedUv(FR-1108、§0.a-0.7)', () => {
  it('法線 [0,0,1] の頂点は (x, y) を UV にする', () => {
    const uv = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([0, 0, 1]));
    expect([...uv]).toEqual([3, 4]);
  });

  it('法線 [0,-1,0] の頂点は (x, z) を UV にする(符号では規則を変えない)', () => {
    const uv = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([0, -1, 0]));
    expect([...uv]).toEqual([3, 5]);
  });

  it('法線 [1,0,0] の頂点は (y, z) を UV にする', () => {
    const uv = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([1, 0, 0]));
    expect([...uv]).toEqual([4, 5]);
  });

  it('法線 [0,0,-1] は [0,0,1] と同じ UV になる(継ぎ目で柄が反転しない)', () => {
    const front = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([0, 0, 1]));
    const back = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([0, 0, -1]));
    expect([...back]).toEqual([...front]);
  });

  it('法線 [0,0,0] の頂点は [0, 0] にする(投影面を選べない)', () => {
    const uv = buildBoxProjectedUv(Float32Array.from([3, 4, 5]), Float32Array.from([0, 0, 0]));
    expect([...uv]).toEqual([0, 0]);
  });

  it('法線が数でない頂点も [0, 0] にする(落ちない)', () => {
    const uv = buildBoxProjectedUv(
      Float32Array.from([3, 4, 5]),
      Float32Array.from([Number.NaN, Number.NaN, Number.NaN]),
    );
    expect([...uv]).toEqual([0, 0]);
  });

  it('法線の並びが足りなくても落ちず、足りない頂点は [0, 0] になる', () => {
    const uv = buildBoxProjectedUv(Float32Array.from([3, 4, 5, 6, 7, 8]), Float32Array.from([0, 0, 1]));
    expect([...uv]).toEqual([3, 4, 0, 0]);
  });

  it('45°の面(絶対値が並ぶ)は z → y → x の順で投影面を選ぶ', () => {
    const diagonal = Math.SQRT1_2;
    const xy = buildBoxProjectedUv(
      Float32Array.from([3, 4, 5]),
      Float32Array.from([diagonal, diagonal, 0]),
    );
    expect([...xy]).toEqual([3, 5]);
    const yz = buildBoxProjectedUv(
      Float32Array.from([3, 4, 5]),
      Float32Array.from([0, diagonal, diagonal]),
    );
    expect([...yz]).toEqual([3, 4]);
  });

  it('UV の長さは頂点数 × 2 になる', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const uv = buildBoxProjectedUv(body.mesh.positions, body.mesh.normals);
    expect(uv.length).toBe((body.mesh.positions.length / 3) * 2);
    expect(uv.length).toBe(48);
  });

  it('40×30×10 の箱は、上面が (x, y)・前面が (x, z) の mm 値になる', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const uv = buildBoxProjectedUv(body.mesh.positions, body.mesh.normals);
    // 上面(面 0)の頂点 0〜3 = (0,0,10) (40,0,10) (40,30,10) (0,30,10)。
    expect(uvAt(uv, 0)).toEqual([0, 0]);
    expect(uvAt(uv, 1)).toEqual([40, 0]);
    expect(uvAt(uv, 2)).toEqual([40, 30]);
    expect(uvAt(uv, 3)).toEqual([0, 30]);
    // 前面(面 2、頂点 8〜11)= (0,0,0) (40,0,0) (40,0,10) (0,0,10)。
    expect(uvAt(uv, 8)).toEqual([0, 0]);
    expect(uvAt(uv, 9)).toEqual([40, 0]);
    expect(uvAt(uv, 10)).toEqual([40, 10]);
    // 右面(面 5、頂点 20〜23)= (40,0,0) …。(y, z) を使う。
    expect(uvAt(uv, 20)).toEqual([0, 0]);
    expect(uvAt(uv, 21)).toEqual([30, 0]);
    expect(uvAt(uv, 22)).toEqual([30, 10]);
  });

  it('20³ の箱の UV はすべて [0, 20] の中に入る(mm 単位)', () => {
    const body = makeBoxBody('box-1', 20, 20, 20);
    const uv = buildBoxProjectedUv(body.mesh.positions, body.mesh.normals);
    for (const value of uv) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(20);
    }
  });

  it('頂点 10 万の UV を 16ms 未満で作れる(NFR-PF-1)', () => {
    const vertexCount = 100_000;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const base = vertex * 3;
      positions[base] = vertex % 97;
      positions[base + 1] = vertex % 89;
      positions[base + 2] = vertex % 83;
      normals[base + (vertex % 3)] = vertex % 2 === 0 ? 1 : -1;
    }
    // 暖機 1 回を計測の外へ出す。JIT の初回コンパイルが乗ると、並列作業中の CPU 競合と
    // 重なって初回の実測が跳ねる(2026-09-05 実測: 暖機なしで初回 33.8ms / 2 回目 2.0ms)。
    // 暖機の結果そのものは使わない(solidPerformance.test.ts の beforeAll の捨て計算と同じ理由)。
    buildBoxProjectedUv(positions, normals);
    const startedAt = performance.now();
    const uv = buildBoxProjectedUv(positions, normals);
    const elapsed = performance.now() - startedAt;
    // 2 回目(暖機後にもう一段速くなるか)も測る。実際の呼び出しは文書を開くたびに何度も起きる。
    const warmStartedAt = performance.now();
    buildBoxProjectedUv(positions, normals);
    const warmElapsed = performance.now() - warmStartedAt;
    // 実測値を報告できるよう出力に残す(`pickSolidSubShapePerformance.test.ts` と同じ流儀)。
    console.log(
      `buildBoxProjectedUv: 頂点 ${vertexCount} で 暖機後1回目 ${elapsed.toFixed(3)}ms / 2回目 ${warmElapsed.toFixed(3)}ms`,
    );
    expect(uv.length).toBe(vertexCount * 2);
    expectWithinBudget(elapsed, 16, 'buildBoxProjectedUv 暖機後1回目');
    expectWithinBudget(warmElapsed, 16, 'buildBoxProjectedUv 2回目');
  });
});

describe('buildSolidGeometry の外観(FR-1106、計画書 P5 タスク7)', () => {
  it('外観を渡さないと、まとまりも材質も 1 つで既定の外観になる(§0.a-0.12)', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const entry = buildSolidGeometry([body], null, []).entries[0];
    expect(entry.appearances).toEqual([DEFAULT_APPEARANCE]);
    expect(entry.groups).toEqual([{ start: 0, count: 36, materialIndex: 0 }]);
    expect(entry.appearanceLimitExceeded).toBe(false);
  });

  it('割り当ての無いボディも既定の外観 1 つになる', () => {
    const body = makeBoxBody('box-1', 20, 20, 20);
    const other = makeBoxBody('box-2', 10, 10, 10);
    const red = appearanceFromPreset('custom', '#ff0000');
    const bundle = buildSolidGeometry(
      [body, other],
      null,
      [],
      appearanceInputFor('box-1', new Map([[0, red]])),
    );
    expect(bundle.entries[1].appearances).toEqual([DEFAULT_APPEARANCE]);
    expect(bundle.entries[1].groups.length).toBe(1);
  });

  it('上面(面 0)だけに別の色を割り当てるとまとまりが 2 つになる', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const red = appearanceFromPreset('custom', '#ff0000');
    const entry = buildSolidGeometry(
      [body],
      null,
      [],
      appearanceInputFor('box-1', new Map([[0, red]])),
    ).entries[0];
    expect(entry.appearances.length).toBe(2);
    expect(entry.appearances[0]).toBe(DEFAULT_APPEARANCE);
    expect(entry.appearances[1]).toBe(red);
    expect(entry.groups).toEqual([
      { start: 0, count: 6, materialIndex: 1 },
      { start: 6, count: 30, materialIndex: 0 },
    ]);
  });

  it('まとまりが索引の全体をちょうど覆う(three の addGroup の約束)', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const red = appearanceFromPreset('custom', '#ff0000');
    const entry = buildSolidGeometry(
      [body],
      null,
      [],
      appearanceInputFor('box-1', new Map([[2, red]])),
    ).entries[0];
    let cursor = 0;
    for (const group of entry.groups) {
      expect(group.start).toBe(cursor);
      cursor += group.count;
    }
    expect(cursor).toBe(body.mesh.indices.length);
  });

  it('面の範囲表に隙間があっても、覆われない索引が残らない(描かれない三角形を作らない)', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const red = appearanceFromPreset('custom', '#ff0000');
    // 面 3〜5 を落とした範囲表(索引 18 以降が範囲表から外れる)。
    const gapped: SolidBodyWithSubShapes = { ...body, faces: body.faces.slice(0, 3) };
    const entry = buildSolidGeometry(
      [gapped],
      null,
      [],
      appearanceInputFor('box-1', new Map([[1, red]])),
    ).entries[0];
    const total = entry.groups.reduce((sum, group) => sum + group.count, 0);
    expect(total).toBe(36);
    expect(entry.groups[entry.groups.length - 1].materialIndex).toBe(0);
  });

  it('立体全体の割り当てがあると、材質 1 つのまま色だけ変わる', () => {
    const body = makeBoxBody('box-1', 20, 20, 20);
    const green = appearanceFromPreset('custom', '#00ff00');
    const entry = buildSolidGeometry(
      [body],
      null,
      [],
      appearanceInputFor('box-1', new Map(), green),
    ).entries[0];
    expect(entry.appearances).toEqual([green]);
    expect(entry.groups).toEqual([{ start: 0, count: 36, materialIndex: 0 }]);
  });

  it('箱の 6 面に別々の色(既定 + 6 = 7 種類)は上限の中で作れる(§0.a-0.11)', () => {
    const body = makeBoxBody('box-1', 20, 20, 20);
    const faceAppearances = new Map<number, AppearanceSpec>();
    for (let faceIndex = 0; faceIndex < 6; faceIndex += 1) {
      faceAppearances.set(faceIndex, appearanceFromPreset('custom', `#00000${faceIndex + 1}`));
    }
    const entry = buildSolidGeometry(
      [body],
      null,
      [],
      appearanceInputFor('box-1', faceAppearances),
    ).entries[0];
    expect(entry.appearanceLimitExceeded).toBe(false);
    expect(entry.appearances.length).toBe(7);
    expect(entry.groups.length).toBe(6);
  });

  it('材質 9 種になる割り当ては断り(appearanceLimitExceeded)、既定 1 色 1 まとまりに落とす', () => {
    const body = makeBoxBody('box-1', 20, 20, 20);
    const faces: SolidFaceEntry[] = [];
    const faceAppearances = new Map<number, AppearanceSpec>();
    for (let faceIndex = 0; faceIndex < 8; faceIndex += 1) {
      faces.push({ ...body.faces[0], index: faceIndex, triangleOffset: faceIndex, triangleCount: 1 });
      faceAppearances.set(faceIndex, appearanceFromPreset('custom', `#00000${faceIndex + 1}`));
    }
    const manyMaterials: SolidBodyWithSubShapes = { ...body, faces };
    const entry = buildSolidGeometry(
      [manyMaterials],
      null,
      [],
      appearanceInputFor('box-1', faceAppearances),
    ).entries[0];
    expect(entry.appearanceLimitExceeded).toBe(true);
    expect(entry.appearances).toEqual([DEFAULT_APPEARANCE]);
    expect(entry.groups).toEqual([{ start: 0, count: 36, materialIndex: 0 }]);
  });

  it('ホバーが変わっただけの組み立て直しでは UV を作り直さない(同一参照、NFR-PF-1)', () => {
    const body = makeBoxBody('box-1', 40, 30, 10);
    const first = buildSolidGeometry([body], null, []).entries[0];
    const second = buildSolidGeometry([body], 'box-1', []).entries[0];
    expect(second.emphasis).toBe('hovered');
    expect(second.uv).toBe(first.uv);
  });

  it('穴 20 個の板(面 26)のまとまりと UV を 1 コマ(16ms)の中で作れる', () => {
    const body = makeBoxBody('plate-1', 200, 100, 6);
    // 板の 6 面 + 穴 20 個の円筒面(1 面あたり三角形 32 枚)= 面 26。
    const faces: SolidFaceEntry[] = [...body.faces];
    let triangleOffset = 12;
    for (let hole = 0; hole < 20; hole += 1) {
      faces.push({
        index: 6 + hole,
        surfaceKind: 'cylinder',
        area: 50,
        centroid: [0, 0, 0],
        axis: [0, 0, 1],
        radius: 3,
        triangleOffset,
        triangleCount: 32,
      });
      triangleOffset += 32;
    }
    const triangleCount = triangleOffset;
    const plate: SolidBodyWithSubShapes = {
      ...body,
      mesh: {
        positions: new Float32Array(triangleCount * 9),
        normals: new Float32Array(triangleCount * 9),
        indices: new Uint32Array(triangleCount * 3),
        edgePositions: body.mesh.edgePositions,
        triangleCount,
      },
      faces,
    };
    const red = appearanceFromPreset('custom', '#ff0000');
    const faceAppearances = new Map<number, AppearanceSpec>();
    for (let hole = 0; hole < 20; hole += 1) {
      faceAppearances.set(6 + hole, red);
    }
    const startedAt = performance.now();
    const entry = buildSolidGeometry(
      [plate],
      null,
      [],
      appearanceInputFor('plate-1', faceAppearances),
    ).entries[0];
    const elapsed = performance.now() - startedAt;
    console.log(
      `buildSolidGeometry(面 ${faces.length}・三角形 ${triangleCount}): ${elapsed.toFixed(3)}ms`,
    );
    expect(entry.appearances.length).toBe(2);
    // 板の 6 面(既定)+ 穴 20 面(赤)が索引の上で続いているので、まとまりは 2 つに畳まれる。
    expect(entry.groups.length).toBe(2);
    expect(entry.groups.reduce((sum, group) => sum + group.count, 0)).toBe(triangleCount * 3);
    expect(entry.uv.length).toBe(triangleCount * 6);
    expect(elapsed).toBeLessThan(16);
  });
});
