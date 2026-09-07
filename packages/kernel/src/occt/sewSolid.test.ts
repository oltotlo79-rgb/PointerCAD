import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { CurveSpec, SewStepSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePlanarFace } from './makePlanarFace.js';
import { sewSolid } from './sewSolid.js';
import { buildSolidBodyMesh, hasSolid, isValidShape, measureVolume } from './solidMesh.js';

/** 4 頂点を順に結んだ閉ループを作る。最後の点から最初の点へも 1 本引く。 */
function loop(points: readonly Vec3Tuple[]): readonly CurveSpec[] {
  return points.map((from, index) => ({
    kind: 'segment',
    from,
    to: points[(index + 1) % points.length],
  }));
}

/** 軸に平行な箱の 6 面を、下・上・前・後・左・右の順で作る。 */
function boxFaces(origin: Vec3Tuple, size: Vec3Tuple): readonly (readonly CurveSpec[])[] {
  const [x, y, z] = origin;
  const [width, depth, height] = size;
  const x1 = x + width;
  const y1 = y + depth;
  const z1 = z + height;
  return [
    loop([
      [x, y, z],
      [x1, y, z],
      [x1, y1, z],
      [x, y1, z],
    ]),
    loop([
      [x, y, z1],
      [x1, y, z1],
      [x1, y1, z1],
      [x, y1, z1],
    ]),
    loop([
      [x, y, z],
      [x1, y, z],
      [x1, y, z1],
      [x, y, z1],
    ]),
    loop([
      [x, y1, z],
      [x1, y1, z],
      [x1, y1, z1],
      [x, y1, z1],
    ]),
    loop([
      [x, y, z],
      [x, y1, z],
      [x, y1, z1],
      [x, y, z1],
    ]),
    loop([
      [x1, y, z],
      [x1, y1, z],
      [x1, y1, z1],
      [x1, y, z1],
    ]),
  ];
}

/** 10 × 20 × 30 mm の箱の 6 面(計画書 タスク4 の検証表の座標)。 */
const BOX_FACES = boxFaces([0, 0, 0], [10, 20, 30]);

/** 単一殻の新しい回帰検査に使う 10 × 20 × 40 mm の箱。 */
const BOX_8000_FACES = boxFaces([0, 0, 0], [10, 20, 40]);

/** 互いに触れない 2 箱の 12 面。どちらも閉じているため自由辺は 0 本になる。 */
const DISCONNECTED_BOX_FACES = [
  ...BOX_FACES,
  ...boxFaces([100, 0, 0], [10, 20, 30]),
];

/** 同じ箱の 6 面を、どれも逆回りに並べたもの。並び順で結果が変わらないことの確認に使う。 */
const BOX_FACES_REVERSED: readonly (readonly CurveSpec[])[] = [
  loop([
    [0, 20, 0],
    [10, 20, 0],
    [10, 0, 0],
    [0, 0, 0],
  ]),
  loop([
    [0, 20, 30],
    [10, 20, 30],
    [10, 0, 30],
    [0, 0, 30],
  ]),
  loop([
    [0, 0, 30],
    [10, 0, 30],
    [10, 0, 0],
    [0, 0, 0],
  ]),
  loop([
    [0, 20, 30],
    [10, 20, 30],
    [10, 20, 0],
    [0, 20, 0],
  ]),
  loop([
    [0, 0, 30],
    [0, 20, 30],
    [0, 20, 0],
    [0, 0, 0],
  ]),
  loop([
    [10, 0, 30],
    [10, 20, 30],
    [10, 20, 0],
    [10, 0, 0],
  ]),
];

/** 10 × 20 × 30 = 6000 mm³。手計算した期待値で、実測に合わせて動かさない。 */
const BOX_VOLUME = 6000;
/** 箱の中心。表示用の法線が外を向いているかの確認に使う。 */
const BOX_CENTER: Vec3Tuple = [5, 10, 15];

/** 箱から遠く離れた位置に置いた 10 × 20 の長方形。縫えない組み合わせの確認に使う。 */
const FAR_FACE: readonly CurveSpec[] = loop([
  [100, 100, 0],
  [110, 100, 0],
  [110, 120, 0],
  [100, 120, 0],
]);

/** 閉じていない L 字の 3 本。makePlanarFace が断る経路の確認に使う。 */
const OPEN_PROFILE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
  { kind: 'segment', from: [10, 0, 0], to: [10, 10, 0] },
  { kind: 'segment', from: [10, 10, 0], to: [0, 10, 0] },
];

function sewSpec(profiles: readonly (readonly CurveSpec[])[], tolerance = 0.01): SewStepSpec {
  return { kind: 'sew', profiles, tolerance };
}

/**
 * 列挙の値どうしを比べて種類の名前へ直す。
 * 列挙を引数に取る API(TopExp_Explorer.Init)は型定義の都合で使えないが、
 * 値どうしの === 比較は実行時に同じオブジェクトを指すため成立する。
 */
function shapeTypeName(oc: OpenCascadeInstance, shape: TopoDS_Shape): string {
  const kinds = oc.TopAbs_ShapeEnum;
  const type = shape.ShapeType();
  if (type === kinds.TopAbs_COMPOUND) return 'TopAbs_COMPOUND';
  if (type === kinds.TopAbs_COMPSOLID) return 'TopAbs_COMPSOLID';
  if (type === kinds.TopAbs_SOLID) return 'TopAbs_SOLID';
  if (type === kinds.TopAbs_SHELL) return 'TopAbs_SHELL';
  if (type === kinds.TopAbs_FACE) return 'TopAbs_FACE';
  if (type === kinds.TopAbs_WIRE) return 'TopAbs_WIRE';
  if (type === kinds.TopAbs_EDGE) return 'TopAbs_EDGE';
  if (type === kinds.TopAbs_VERTEX) return 'TopAbs_VERTEX';
  return 'TopAbs_SHAPE';
}

interface SewingObservation {
  readonly shapeType: string;
  readonly freeEdges: number;
  readonly shellCount: number;
  /** 縫合の結果に殻が入っていれば、そこから素直に作った立体の体積。無ければ null。 */
  readonly rawSolidVolume: number | null;
}

/** 形自身または入れ物の中にある殻を数える。取り出した wrapper はこの口で解放する。 */
function countShells(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const shellType = oc.TopAbs_ShapeEnum.TopAbs_SHELL;
  if (shape.ShapeType() === shellType) return 1;

  const subShapes = new oc.TopTools_IndexedMapOfShape_1();
  let shellCount = 0;
  try {
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const subShapeCount = Number(subShapes.Size());
    for (let index = 1; index <= subShapeCount; index += 1) {
      const subShape = subShapes.FindKey(index);
      try {
        if (subShape.ShapeType() === shellType) shellCount += 1;
      } finally {
        subShape.delete();
      }
    }
    return shellCount;
  } finally {
    subShapes.delete();
  }
}

/**
 * 縫合だけを行い、SewedShape() の種類・自由辺の本数・向きを直す前の体積を測る。
 * 実装(sewSolid)を通さない素の観測で、計画書 §1.2 の未確認点 3 の実測を検査として残す。
 */
function observeSewing(
  oc: OpenCascadeInstance,
  profiles: readonly (readonly CurveSpec[])[],
): SewingObservation {
  const sewing = new oc.BRepBuilderAPI_Sewing(0.01, true, true, true, false);
  const faces = profiles.map((profile) => makePlanarFace(oc, profile));
  try {
    for (const handle of faces) {
      sewing.Add(handle.face);
    }
    const progress = new oc.Message_ProgressRange_1();
    try {
      sewing.Perform(progress);
    } finally {
      progress.delete();
    }

    const sewed = sewing.SewedShape();
    try {
      const isShell = sewed.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL;
      let rawSolidVolume: number | null = null;
      if (isShell) {
        const shell = oc.TopoDS.Shell_1(sewed);
        const solidMaker = new oc.BRepBuilderAPI_MakeSolid_3(shell);
        const solid = solidMaker.Solid();
        rawSolidVolume = measureVolume(oc, solid);
        solid.delete();
        solidMaker.delete();
        shell.delete();
      }
      return {
        shapeType: shapeTypeName(oc, sewed),
        freeEdges: Number(sewing.NbFreeEdges()),
        shellCount: countShells(oc, sewed),
        rawSolidVolume,
      };
    } finally {
      sewed.delete();
    }
  } finally {
    sewing.delete();
    for (const handle of faces) {
      handle.delete();
    }
  }
}

describe('面を縫い合わせて立体にする', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  // 計画書 §1.2 の未確認点 3 の実測。面が 2 枚以上つながっていれば SewedShape() は殻を返し、
  // 1 枚だけのときは殻にならず面のまま返る(だから 2 枚未満は先に断る)。
  it('SewedShape() は 6 面でも 5 面でも殻を返し、1 面では面のまま返る', () => {
    expect(observeSewing(oc, BOX_FACES)).toEqual({
      shapeType: 'TopAbs_SHELL',
      freeEdges: 0,
      shellCount: 1,
      // 縫合が揃える向きは内側で、そのまま立体にすると裏返しになる(体積が負)。
      rawSolidVolume: -BOX_VOLUME,
    });
    expect(observeSewing(oc, BOX_FACES.slice(0, 5))).toEqual({
      shapeType: 'TopAbs_SHELL',
      freeEdges: 4,
      shellCount: 1,
      // 開いた殻でも体積は出る(10 × 20 × 30 のうち上面を欠いた分)。
      rawSolidVolume: -4800,
    });
    expect(observeSewing(oc, BOX_FACES.slice(0, 1))).toEqual({
      shapeType: 'TopAbs_FACE',
      freeEdges: 4,
      shellCount: 0,
      rawSolidVolume: null,
    });
  });

  // 離れた面どうしは縫えず、まとめ役の入れ物(COMPOUND)で返る。
  // このとき殻は 1 つも入っていないので、殻の取り出しの分岐が働く。
  it('離れた 2 枚の SewedShape() は入れ物(COMPOUND)になる', () => {
    expect(observeSewing(oc, [BOX_FACES[0], FAR_FACE])).toEqual({
      shapeType: 'TopAbs_COMPOUND',
      freeEdges: 8,
      shellCount: 0,
      rawSolidVolume: null,
    });
  });

  it('離れた 2 箱の 12 面は自由辺 0 本・殻 2 個になる', () => {
    expect(observeSewing(oc, DISCONNECTED_BOX_FACES)).toEqual({
      shapeType: 'TopAbs_COMPOUND',
      freeEdges: 0,
      shellCount: 2,
      rawSolidVolume: null,
    });
  });

  // 修正前はこの 12 面から最初の箱だけを取り出し、体積 6000 mm³ の立体を返していた。
  it('離れた 2 箱の 12 面は、複数の閉じた殻に分かれる理由つきで断られる', () => {
    expect(() => sewSolid(oc, sewSpec(DISCONNECTED_BOX_FACES))).toThrow(
      '面が 2 つ以上の閉じた殻に分かれています。面を選び直してください。',
    );
  });

  it('箱の 6 面を縫うと体積 6000 mm³ の閉じた立体になる', () => {
    const handle = sewSolid(oc, sewSpec(BOX_FACES));
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(BOX_VOLUME, 6);
      expect(isValidShape(oc, handle.shape)).toBe(true);
      expect(hasSolid(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('10 × 20 × 40 mm の 6 面は従来どおり体積 8000 mm³ の立体になる', () => {
    const handle = sewSolid(oc, sewSpec(BOX_8000_FACES));
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(8000, 6);
      expect(isValidShape(oc, handle.shape)).toBe(true);
      expect(hasSolid(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('面を逆回りに並べても、同じ体積の立体になる', () => {
    const handle = sewSolid(oc, sewSpec(BOX_FACES_REVERSED));
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(BOX_VOLUME, 6);
      expect(isValidShape(oc, handle.shape)).toBe(true);
      expect(hasSolid(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('縫った立体の表示用データが面 6・三角形 12・稜線 12 になる', () => {
    const handle = sewSolid(oc, sewSpec(BOX_FACES));
    try {
      const body = buildSolidBodyMesh(oc, 'sew-1', handle.shape);
      expect(body.id).toBe('sew-1');
      expect(body.faceCount).toBe(6);
      expect(body.triangleCount).toBe(12);
      // 直方体の稜線は 12 本。縫合で共有された辺は 1 本にまとまる。
      expect(body.edgeCount).toBe(12);
      expect(body.volume).toBeCloseTo(BOX_VOLUME, 6);
      // 節点 24 個(面ごとに 4 個 × 6 面)、三角形 12 枚、稜線 12 本。
      expect(body.positions.length).toBe(72);
      expect(body.normals.length).toBe(72);
      expect(body.indices.length).toBe(36);
      expect(body.edgePositions.length).toBe(72);
    } finally {
      handle.delete();
    }
  });

  // 向きを直していないと、凸な箱の法線が全て内向きになり、表裏が逆に描かれる。
  it('縫った立体の法線が外を向く', () => {
    const handle = sewSolid(oc, sewSpec(BOX_FACES));
    try {
      const body = buildSolidBodyMesh(oc, 'sew-1', handle.shape);
      const outward: number[] = [];
      for (let index = 0; index < body.normals.length; index += 3) {
        // 凸な立体では「中心から節点へ向かう向き」と外向きの法線の内積が正になる。
        outward.push(
          body.normals[index] * (body.positions[index] - BOX_CENTER[0]) +
            body.normals[index + 1] * (body.positions[index + 1] - BOX_CENTER[1]) +
            body.normals[index + 2] * (body.positions[index + 2] - BOX_CENTER[2]),
        );
      }
      expect(outward.length).toBe(24);
      expect(outward.every((value) => value > 0)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('許容量を 0.5 mm にしても同じ体積の立体になる', () => {
    const handle = sewSolid(oc, sewSpec(BOX_FACES, 0.5));
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(BOX_VOLUME, 6);
    } finally {
      handle.delete();
    }
  });

  it('上の面を抜いた 5 面は隙間の本数つきで断られる', () => {
    expect(() => sewSolid(oc, sewSpec(BOX_FACES.slice(0, 5)))).toThrow(
      '面のつながりに隙間があるため、立体にできませんでした。隙間は 4 本です。',
    );
  });

  it('面が 1 枚だけなら断られる', () => {
    expect(() => sewSolid(oc, sewSpec(BOX_FACES.slice(0, 1)))).toThrow(
      '立体にするには面が 2 枚以上必要です。',
    );
  });

  it('面が 0 枚でも断られる', () => {
    expect(() => sewSolid(oc, sewSpec([]))).toThrow('立体にするには面が 2 枚以上必要です。');
  });

  it('許容量が 0 なら断られる', () => {
    expect(() => sewSolid(oc, sewSpec(BOX_FACES, 0))).toThrow(
      'つなぎ目の許容量は 0 より大きい数にしてください。',
    );
  });

  it('許容量が負なら断られる', () => {
    expect(() => sewSolid(oc, sewSpec(BOX_FACES, -0.01))).toThrow(
      'つなぎ目の許容量は 0 より大きい数にしてください。',
    );
  });

  it('許容量が数でなければ断られる', () => {
    expect(() => sewSolid(oc, sewSpec(BOX_FACES, Number.NaN))).toThrow(
      'つなぎ目の許容量は 0 より大きい数にしてください。',
    );
  });

  it('離れた 2 枚は隙間の本数つきで断られる', () => {
    expect(() => sewSolid(oc, sewSpec([BOX_FACES[0], FAR_FACE]))).toThrow(
      '面のつながりに隙間があるため、立体にできませんでした。隙間は 8 本です。',
    );
  });

  it('閉じていない輪郭が混ざっていれば、面を張れない理由がそのまま伝わる', () => {
    expect(() => sewSolid(oc, sewSpec([BOX_FACES[0], OPEN_PROFILE]))).toThrow(
      '輪郭が閉じていないため、面を張れませんでした。',
    );
  });
});
