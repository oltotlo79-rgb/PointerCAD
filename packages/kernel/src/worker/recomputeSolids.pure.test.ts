import { describe, expect, it } from 'vitest';

import { SUB_SHAPE_MATCH_THRESHOLD } from '../occt/matchSubShape.js';
import type {
  AppearanceQuery,
  SolidBodyMesh,
  SolidFaceInfo,
  SolidStepSpec,
  SphereSegmentCount,
  SubShapeQuery,
  ThruSectionSpec,
} from '../types.js';
import { matchAppearances } from './recomputeSolids.js';

/*
 * 外観の面の照合(FR-1106、P5 §2.2.3、タスク3)のうち、OCCT を使わない部分の検査。
 *
 * `recomputeSolids.test.ts` は 50MB の WASM を読み込むので 1 ファイルあたり 8 秒前後かかる。
 * `matchAppearances` は素の数値と文字列だけで決まる純関数なので、WASM を読まずに
 * 1 秒未満で確かめられる(`occt/matchSubShape.test.ts` と同じ切り分け方)。
 *
 * ここで作る面の一覧は「40 × 30 を 10 押し出した板」を手で書き写したもので、
 * 実際に OCCT が返す並び・値と同じかどうかは `recomputeSolids.test.ts` の側が
 * 本物の形を作って確かめる(手で作った数値だけで固めない)。
 */

/** 40 × 30 × 10 の板の境界箱の対角長の半分。√(40² + 30² + 10²) / 2 = √2600 / 2。 */
const PLATE_SCALE = Math.sqrt(2600) / 2;

/** 上の面(z = 10)の通し番号。下の面・横の面と区別できればよいので値そのものに意味はない。 */
const TOP_FACE_INDEX = 1;

/** 板の面 3 枚(上・下・横)。指紋の採点に効く欄だけを本物と同じ値で埋める。 */
const PLATE_FACES: readonly SolidFaceInfo[] = [
  {
    index: 0,
    surfaceKind: 'plane',
    area: 1200,
    centroid: [20, 15, 0],
    axis: [0, 0, -1],
    radius: null,
    triangleOffset: 0,
    triangleCount: 2,
  },
  {
    index: TOP_FACE_INDEX,
    surfaceKind: 'plane',
    area: 1200,
    centroid: [20, 15, 10],
    axis: [0, 0, 1],
    radius: null,
    triangleOffset: 2,
    triangleCount: 2,
  },
  {
    index: 2,
    surfaceKind: 'plane',
    area: 400,
    centroid: [20, 0, 5],
    axis: [0, -1, 0],
    radius: null,
    triangleOffset: 4,
    triangleCount: 2,
  },
];

/** 上の面の指紋(そっくりそのまま)。 */
const TOP_FACE_QUERY: Extract<SubShapeQuery, { kind: 'face' }> = {
  kind: 'face',
  index: TOP_FACE_INDEX,
  surfaceKind: 'plane',
  area: 1200,
  position: [20, 15, 10],
  axis: [0, 0, 1],
  radius: null,
};

/** 面の一覧だけを持つボディ。照合は faces と id しか見ない。 */
function bodyWithFaces(id: string, faces: readonly SolidFaceInfo[]): SolidBodyMesh {
  return {
    id,
    positions: new Float32Array(),
    normals: new Float32Array(),
    indices: new Uint32Array(),
    edgePositions: new Float32Array(),
    triangleCount: 0,
    faceCount: faces.length,
    edgeCount: 0,
    volume: 12000,
    area: 3800,
    bodyKind: 'solid',
    faces,
    edges: [],
    vertices: [],
    threadMarks: [],
  };
}

function query(id: string, bodyKey: string, subShape: SubShapeQuery): AppearanceQuery {
  return { id, bodyKey, query: subShape };
}

/** 板 1 枚(鍵 key-a、id extrude-1)だけがある状態の材料。 */
function plateTables(): {
  readonly bodies: readonly SolidBodyMesh[];
  readonly bodyIdByKey: ReadonlyMap<string, string>;
  readonly scaleByBodyId: ReadonlyMap<string, number>;
} {
  return {
    bodies: [bodyWithFaces('extrude-1', PLATE_FACES)],
    bodyIdByKey: new Map([['key-a', 'extrude-1']]),
    scaleByBodyId: new Map([['extrude-1', PLATE_SCALE]]),
  };
}

describe('外観の面の照合(matchAppearances、FR-1106)', () => {
  it('依頼が空なら結果も空で、ボディを 1 つも見ない', () => {
    const { bodies, bodyIdByKey, scaleByBodyId } = plateTables();
    expect(matchAppearances([], bodies, bodyIdByKey, scaleByBodyId)).toEqual([]);
  });

  it('指紋どおりの面をその通し番号で選び直す', () => {
    const { bodies, bodyIdByKey, scaleByBodyId } = plateTables();
    const matches = matchAppearances(
      [query('appearance-1', 'key-a', TOP_FACE_QUERY)],
      bodies,
      bodyIdByKey,
      scaleByBodyId,
    );

    expect(matches).toEqual([
      { id: 'appearance-1', bodyId: 'extrude-1', faceIndex: TOP_FACE_INDEX },
    ]);
  });

  // 通し番号だけが外れた指紋の点は 0.35(軸) + 0.25(大きさ) + 0(番号) + 0.2(位置) = 0.8。
  // しきい値 0.6 を超えるので、上流を編集して番号がずれても同じ面に付いたままになる。
  it('通し番号がずれても、軸・大きさ・位置が合っていれば同じ面を選び直す', () => {
    const { bodies, bodyIdByKey, scaleByBodyId } = plateTables();
    const matches = matchAppearances(
      [query('appearance-1', 'key-a', { ...TOP_FACE_QUERY, index: 5 })],
      bodies,
      bodyIdByKey,
      scaleByBodyId,
    );

    expect(matches[0].faceIndex).toBe(TOP_FACE_INDEX);
  });

  // 裏の面(法線が真逆)の点は 0(軸) + 0.25(大きさ) + 0(番号) + 0.2 × 0.6078(位置) ≒ 0.3716 で、
  // 上の面の 1.0 に遠く及ばない。軸の重みが最も大きいのはこれを外さないためである(§0.a-0.4)。
  it('上の面の指紋が、法線が真逆の裏の面を選ぶことはない', () => {
    const { bodies, bodyIdByKey, scaleByBodyId } = plateTables();
    const matches = matchAppearances(
      [query('appearance-1', 'key-a', TOP_FACE_QUERY)],
      bodies,
      bodyIdByKey,
      scaleByBodyId,
    );

    expect(matches[0].faceIndex).not.toBe(0);
  });

  // 大きさだけを 100 倍にしても点は 0.35 + 0.0025 + 0.2 + 0.2 = 0.7525 でしきい値を超える
  // (docs/報告記録.md 2026-09-03 の P3 タスク5 と同じ実測)。「見つからない」を確かめるには
  // 番号・大きさ・位置をすべて外した指紋が要る。
  it('番号・大きさ・位置がすべて外れた指紋は見つからない(faceIndex が null)', () => {
    const { bodies, bodyIdByKey, scaleByBodyId } = plateTables();
    const matches = matchAppearances(
      [
        query('appearance-1', 'key-a', {
          ...TOP_FACE_QUERY,
          index: 99,
          area: 120_000,
          position: [1000, 1000, 1000],
        }),
      ],
      bodies,
      bodyIdByKey,
      scaleByBodyId,
    );

    expect(matches).toEqual([{ id: 'appearance-1', bodyId: 'extrude-1', faceIndex: null }]);
    // 上の注釈の 0.7525 がしきい値を超えることを、値そのもので残しておく。
    expect(0.7525).toBeGreaterThan(SUB_SHAPE_MATCH_THRESHOLD);
  });

  it('種類の違う面(円柱面)の指紋は、平面しか無いボディでは見つからない', () => {
    const { bodies, bodyIdByKey, scaleByBodyId } = plateTables();
    const matches = matchAppearances(
      [query('appearance-1', 'key-a', { ...TOP_FACE_QUERY, surfaceKind: 'cylinder', radius: 3 })],
      bodies,
      bodyIdByKey,
      scaleByBodyId,
    );

    expect(matches[0].faceIndex).toBeNull();
  });

  it('面ではない指紋(辺・頂点)は照合せずに断る', () => {
    const { bodies, bodyIdByKey, scaleByBodyId } = plateTables();
    const matches = matchAppearances(
      [
        query('appearance-1', 'key-a', {
          kind: 'edge',
          index: 0,
          curveKind: 'line',
          length: 40,
          position: [20, 0, 10],
          axis: [1, 0, 0],
          radius: null,
        }),
        query('appearance-2', 'key-a', { kind: 'vertex', index: 0, position: [0, 0, 0] }),
      ],
      bodies,
      bodyIdByKey,
      scaleByBodyId,
    );

    expect(matches.map((match) => match.faceIndex)).toEqual([null, null]);
    expect(matches.map((match) => match.bodyId)).toEqual(['extrude-1', 'extrude-1']);
  });

  it('物差しが 0 以下のボディでは照合せずに断る', () => {
    const { bodies, bodyIdByKey } = plateTables();
    const matches = matchAppearances(
      [query('appearance-1', 'key-a', TOP_FACE_QUERY)],
      bodies,
      bodyIdByKey,
      new Map([['extrude-1', 0]]),
    );

    expect(matches).toEqual([{ id: 'appearance-1', bodyId: 'extrude-1', faceIndex: null }]);
  });

  it('画面に出るボディが 1 つも無ければ、全件が bodyId 空・faceIndex null で返る', () => {
    const matches = matchAppearances(
      [
        query('appearance-1', 'key-a', TOP_FACE_QUERY),
        query('appearance-2', 'key-b', TOP_FACE_QUERY),
      ],
      [],
      new Map(),
      new Map(),
    );

    expect(matches).toEqual([
      { id: 'appearance-1', bodyId: '', faceIndex: null },
      { id: 'appearance-2', bodyId: '', faceIndex: null },
    ]);
  });

  // 鍵は引けるのに面の一覧が無い(その段が作れなかった)ときも、断るだけで落とさない。
  it('鍵からボディの id は引けても、面の一覧が無ければ faceIndex は null になる', () => {
    const matches = matchAppearances(
      [query('appearance-1', 'key-a', TOP_FACE_QUERY)],
      [],
      new Map([['key-a', 'extrude-1']]),
      new Map([['extrude-1', PLATE_SCALE]]),
    );

    expect(matches).toEqual([{ id: 'appearance-1', bodyId: 'extrude-1', faceIndex: null }]);
  });

  it('結果は依頼と同じ並び・同じ件数で、id をそのまま返す', () => {
    const { bodies, bodyIdByKey, scaleByBodyId } = plateTables();
    const matches = matchAppearances(
      [
        query('appearance-3', 'key-a', TOP_FACE_QUERY),
        query('appearance-1', 'missing-key', TOP_FACE_QUERY),
        query('appearance-2', 'key-a', { ...TOP_FACE_QUERY, index: 0, position: [20, 15, 0], axis: [0, 0, -1] }),
      ],
      bodies,
      bodyIdByKey,
      scaleByBodyId,
    );

    expect(matches.map((match) => match.id)).toEqual([
      'appearance-3',
      'appearance-1',
      'appearance-2',
    ]);
    expect(matches.map((match) => match.faceIndex)).toEqual([TOP_FACE_INDEX, null, 0]);
  });
});

/*
 * 段の種類の数(P5 タスク14 の検証表「`SolidStepSpec` の union の数」)。
 *
 * 型そのものは実行時に無いので、`SolidStepSpec['kind']` を鍵とする表を作って数える。
 * **表を `Record` にしてあるので、union に種類を足したのにここを直し忘れると型検査が落ちる**
 * (数え漏れを機械で防ぐ)。P5 は基本形状(`primitive`)を足して 9 → 10 に、
 * 罫線面とロフト(`thruSections`、タスク24)を足して 10 → 11 に、
 * Should 群・Could 群の 11 種(タスク42a)を足して 11 → 22 になった。
 *
 * **計画書 §2.13 の見込みは 23 だった。** 差の 1 は、計画が `RuledStepSpec` と
 * `LoftStepSpec` を別々に数えていたのに対し、タスク24 で「直線で結ぶか(`ruled`)の
 * 真偽が違うだけ」として 1 種(`thruSections`)にまとめた(§0.a-0.25)ためである。
 * 薄板押し出し(FR-416)・ざぐり(FR-422)・可変半径(FR-426)・点集合パターン(FR-425)は
 * 計画のとおり既存の段の欄を広げたので、種類は増えていない。
 *
 * **P6 タスク10 で読み込んだ形のベースボディ(`importedSolid`、FR-802)を足して 22 → 23 に
 * なった。** 三角形の形(`importedMesh`)は B-rep にしない(P6 §0.a-0.23)ので**段にならず**、
 * 種類は 1 つしか増えない(model 側だけが 2 種を持つ。P6 §2.8)。
 */
describe('段の種類(SolidStepSpec の union)', () => {
  const STEP_KINDS: Readonly<Record<SolidStepSpec['kind'], true>> = {
    extrude: true,
    revolve: true,
    sew: true,
    boolean: true,
    hole: true,
    thread: true,
    fillet: true,
    chamfer: true,
    spring: true,
    primitive: true,
    thruSections: true,
    // P5 タスク42a で足した 11 種。
    draft: true,
    mirror: true,
    transform: true,
    scale: true,
    sweep: true,
    rib: true,
    emboss: true,
    threadShaft: true,
    surface: true,
    cut: true,
    shell: true,
    // P6 タスク10 で足した 1 種(読み込んだ形のベースボディ、FR-802)。
    importedSolid: true,
    // P10: 板金の基板と、基板を消費するフランジ。
    sheetBase: true,
    sheetFlange: true,
    sheetJoin: true,
    sheetBody: true,
  };

  it('段の種類は27種で、既存の形状と板金の基板・フランジ・展開結合・再構築を含む', () => {
    expect(Object.keys(STEP_KINDS)).toHaveLength(27);
    expect(Object.keys(STEP_KINDS)).toContain('primitive');
    expect(Object.keys(STEP_KINDS)).toContain('thruSections');
    expect(Object.keys(STEP_KINDS)).toContain('sheetBase');
    expect(Object.keys(STEP_KINDS)).toContain('sheetFlange');
    expect(Object.keys(STEP_KINDS)).toContain('sheetJoin');
    expect(Object.keys(STEP_KINDS)).toContain('sheetBody');
  });

  /*
   * 読み込んだ形(FR-802、P6 §2.8)。**B-rep の形だけが段になる**ことを固定する。
   * 三角形の形(`importedMesh`)を段にしてしまうと、メッシュ → B-rep の変換が要る
   * (§0.a-0.23 で「しない」と決めた)ので、名前が入っていないことを歯止めにする。
   */
  it('読み込んだ形は B-rep の 1 種だけが段になり、三角形の形は段にならない(P6 §0.a-0.23)', () => {
    expect(Object.keys(STEP_KINDS)).toContain('importedSolid');
    expect(Object.keys(STEP_KINDS)).not.toContain('importedMesh');
  });

  it('P5 の Should 群・Could 群の 11 種がすべて入っている(タスク42a)', () => {
    const added = [
      'draft',
      'mirror',
      'transform',
      'scale',
      'sweep',
      'rib',
      'emboss',
      'threadShaft',
      'surface',
      'cut',
      'shell',
    ];
    expect(added).toHaveLength(11);
    for (const kind of added) {
      expect(Object.keys(STEP_KINDS)).toContain(kind);
    }
  });

  /*
   * 薄板押し出し・ざぐり・可変半径は「新しい段」ではなく既存の段の欄を広げたもの
   * (§0.a-0.39、§0.a-0.46、§0.a-0.48)。種類を増やしていないことを、
   * 名前が入っていないことで固定しておく(後から段を作り足さないための歯止め)。
   */
  it('薄板押し出し・ざぐり・可変半径は段の種類を増やしていない', () => {
    for (const kind of ['thinExtrude', 'counterbore', 'variableFillet', 'pattern']) {
      expect(Object.keys(STEP_KINDS)).not.toContain(kind);
    }
  });
});

/*
 * 罫線面・ロフトの断面の種類(P5 タスク24b)。
 *
 * 上の段の種類と同じ理屈で、`ThruSectionSpec` の union に種類を足したのに
 * ここを直し忘れると型検査が落ちるようにしてある。曲線の並び・球に、
 * 立体の面(`faceQuery`、§0.a-0.73)を足して 2 → 3 になった。
 */
describe('罫線面・ロフトの断面の種類(ThruSectionSpec の union)', () => {
  const SECTION_KINDS: Readonly<Record<ThruSectionSpec['kind'], true>> = {
    curves: true,
    sphere: true,
    faceQuery: true,
  };

  it('断面の種類は 3 種で、立体の面(faceQuery)を含む', () => {
    expect(Object.keys(SECTION_KINDS)).toHaveLength(3);
    expect(Object.keys(SECTION_KINDS)).toContain('faceQuery');
  });

  /*
   * 球へつなぐ分割数の 3 択(§0.a-0.74)。model の欄・ui の「なめらかさ」・
   * kernel の断りが同じ 3 つを見るように、型から数え上げて固定しておく。
   */
  it('球へつなぐ分割数は 24 / 48 / 72 の 3 択', () => {
    const choices: Readonly<Record<SphereSegmentCount, true>> = { 24: true, 48: true, 72: true };
    expect(Object.keys(choices).map(Number)).toEqual([24, 48, 72]);
  });
});
