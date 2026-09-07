import { expectWithinBudget } from '@pointercad/test-utils';
import { describe, expect, it } from 'vitest';

import {
  CONSTRAINT_INITIAL_DAMPING,
  CONSTRAINT_MAX_ITERATIONS,
  CONSTRAINT_TOLERANCE,
  eliminate,
  matrixRank,
  qrDecomposition,
  solveLeastSquares,
  solveLevenbergMarquardt,
  solveLinearSystem,
  type LinearizedRow,
} from './solve.js';

/**
 * タスク6 の検査。`solve.ts` は拘束の意味を知らない数値の道具なので、ここでは
 * **教科書どおりに手で検算できる連立**と、**この検査の中で自分で書いた簡易版の残差**で確かめる。
 *
 * 拘束 13 種の本物の残差はタスク5(`residuals.ts`)が持ち、両者をつなぐのはタスク8 なので、
 * ここでの残差は「解き方が正しいか」を見るための最小限のものにしてある。
 * ただし**偏微分は解析式で書く**(数値微分だと勾配の誤差が収束の判定 1e-9 に紛れ込み、
 * ソルバーの不具合と区別できなくなる)。書いた解析式が正しいことは
 * 「解析式 vs 中心差分」の検査 1 件でまとめて固定する。
 */

/** 期待値との差を絶対量で見る(`toBeCloseTo` は桁で見るので、1e-9 の判定に使いにくい)。 */
function expectClose(actual: number, expected: number, tolerance = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

/* ------------------------------------------------------------------ *
 * 検査の中で使う簡易版の残差(解析式の偏微分つき)
 * ------------------------------------------------------------------ */

/** 点。`iu` / `iv` は変数の列番号で、定数の点は null。 */
interface Pt {
  readonly u: number;
  readonly v: number;
  readonly iu: number | null;
  readonly iv: number | null;
}

/** 変数の点(x の iu 番目・iv 番目)。 */
function movable(x: readonly number[], iu: number, iv: number): Pt {
  return { u: x[iu], v: x[iv], iu, iv };
}

/** 動かない点。 */
function pinned(u: number, v: number): Pt {
  return { u, v, iu: null, iv: null };
}

type Entry = readonly [number | null, number];

/** 1 本の式。列番号が null(定数)の項と、偏微分が 0 の項は入れない(疎な行)。 */
function row(value: number, entries: readonly Entry[]): LinearizedRow {
  const gradient = new Map<number, number>();
  for (const [index, partial] of entries) {
    if (index === null || partial === 0) {
      continue;
    }
    gradient.set(index, (gradient.get(index) ?? 0) + partial);
  }
  return { value, gradient };
}

/** 単位ベクトルと長さ。 */
function direction(from: Pt, to: Pt): { ux: number; uy: number; length: number } {
  const du = to.u - from.u;
  const dv = to.v - from.v;
  const length = Math.sqrt(du * du + dv * dv);
  return { ux: du / length, uy: dv / length, length };
}

/**
 * `∂f/∂(終点)`。f が単位ベクトル û だけを通して両端点に依るとき、
 * `∂û/∂d = (I − û ûᵀ)/|d|` なので、`c = ∂f/∂û` を û に直交する成分だけ残して長さで割る。
 */
function throughUnit(
  c: readonly [number, number],
  unit: { ux: number; uy: number; length: number },
): [number, number] {
  const along = unit.ux * c[0] + unit.uy * c[1];
  return [(c[0] - unit.ux * along) / unit.length, (c[1] - unit.uy * along) / unit.length];
}

/** 一致(2 本)。 */
function coincident(p: Pt, q: Pt): LinearizedRow[] {
  return [
    row(p.u - q.u, [
      [p.iu, 1],
      [q.iu, -1],
    ]),
    row(p.v - q.v, [
      [p.iv, 1],
      [q.iv, -1],
    ]),
  ];
}

/** 水平(線分の 2 端点の v が等しい)。 */
function horizontal(p: Pt, q: Pt): LinearizedRow {
  return row(p.v - q.v, [
    [p.iv, 1],
    [q.iv, -1],
  ]);
}

/** 垂直(線分の 2 端点の u が等しい)。 */
function vertical(p: Pt, q: Pt): LinearizedRow {
  return row(p.u - q.u, [
    [p.iu, 1],
    [q.iu, -1],
  ]);
}

/** 距離(|p − q| − L)。 */
function distance(p: Pt, q: Pt, length: number): LinearizedRow {
  const du = p.u - q.u;
  const dv = p.v - q.v;
  const r = Math.sqrt(du * du + dv * dv);
  return row(r - length, [
    [p.iu, du / r],
    [p.iv, dv / r],
    [q.iu, -du / r],
    [q.iv, -dv / r],
  ]);
}

/** 平行(単位ベクトルの外積)。 */
function parallel(p1: Pt, q1: Pt, p2: Pt, q2: Pt): LinearizedRow {
  const a = direction(p1, q1);
  const b = direction(p2, q2);
  const value = a.ux * b.uy - a.uy * b.ux;
  const ga = throughUnit([b.uy, -b.ux], a);
  const gb = throughUnit([-a.uy, a.ux], b);
  return row(value, [
    [q1.iu, ga[0]],
    [q1.iv, ga[1]],
    [p1.iu, -ga[0]],
    [p1.iv, -ga[1]],
    [q2.iu, gb[0]],
    [q2.iv, gb[1]],
    [p2.iu, -gb[0]],
    [p2.iv, -gb[1]],
  ]);
}

/** 直角(単位ベクトルの内積)。 */
function perpendicular(p1: Pt, q1: Pt, p2: Pt, q2: Pt): LinearizedRow {
  const a = direction(p1, q1);
  const b = direction(p2, q2);
  const value = a.ux * b.ux + a.uy * b.uy;
  const ga = throughUnit([b.ux, b.uy], a);
  const gb = throughUnit([a.ux, a.uy], b);
  return row(value, [
    [q1.iu, ga[0]],
    [q1.iv, ga[1]],
    [p1.iu, -ga[0]],
    [p1.iv, -ga[1]],
    [q2.iu, gb[0]],
    [q2.iv, gb[1]],
    [p2.iu, -gb[0]],
    [p2.iv, -gb[1]],
  ]);
}

/** 角度(dot·sinθ − cross·cosθ。±180° をまたいでも不連続にならない形)。 */
function angle(p1: Pt, q1: Pt, p2: Pt, q2: Pt, theta: number): LinearizedRow {
  const a = direction(p1, q1);
  const b = direction(p2, q2);
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  const dot = a.ux * b.ux + a.uy * b.uy;
  const cross = a.ux * b.uy - a.uy * b.ux;
  const value = dot * sin - cross * cos;
  const ga = throughUnit([b.ux * sin - b.uy * cos, b.uy * sin + b.ux * cos], a);
  const gb = throughUnit([a.ux * sin + a.uy * cos, a.uy * sin - a.ux * cos], b);
  return row(value, [
    [q1.iu, ga[0]],
    [q1.iv, ga[1]],
    [p1.iu, -ga[0]],
    [p1.iv, -ga[1]],
    [q2.iu, gb[0]],
    [q2.iv, gb[1]],
    [p2.iu, -gb[0]],
    [p2.iv, -gb[1]],
  ]);
}

/** 等しい(2 本の線分の長さ)。 */
function equalLength(p1: Pt, q1: Pt, p2: Pt, q2: Pt): LinearizedRow {
  const a = direction(p1, q1);
  const b = direction(p2, q2);
  return row(a.length - b.length, [
    [q1.iu, a.ux],
    [q1.iv, a.uy],
    [p1.iu, -a.ux],
    [p1.iv, -a.uy],
    [q2.iu, -b.ux],
    [q2.iv, -b.uy],
    [p2.iu, b.ux],
    [p2.iv, b.uy],
  ]);
}

/** 対称(中点が軸の上、結ぶ線が軸に直交)。軸は動かない線分。 */
function symmetric(p: Pt, q: Pt, axisFrom: Pt, axisTo: Pt): LinearizedRow[] {
  const axis = direction(axisFrom, axisTo);
  const midU = (p.u + q.u) / 2;
  const midV = (p.v + q.v) / 2;
  const offU = midU - axisFrom.u;
  const offV = midV - axisFrom.v;
  return [
    row(axis.ux * offV - axis.uy * offU, [
      [p.iu, -axis.uy / 2],
      [p.iv, axis.ux / 2],
      [q.iu, -axis.uy / 2],
      [q.iv, axis.ux / 2],
    ]),
    row((p.u - q.u) * axis.ux + (p.v - q.v) * axis.uy, [
      [p.iu, axis.ux],
      [p.iv, axis.uy],
      [q.iu, -axis.ux],
      [q.iv, -axis.uy],
    ]),
  ];
}

/**
 * 接線(中心から直線までの符号つき距離 − 半径)。
 * `radiusIndex` が null なら半径は動かない。
 */
function tangent(
  p: Pt,
  q: Pt,
  center: Pt,
  radius: number,
  radiusIndex: number | null,
): LinearizedRow {
  const unit = direction(p, q);
  const au = center.u - p.u;
  const av = center.v - p.v;
  const value = au * unit.uy - av * unit.ux - radius;
  const g = throughUnit([-av, au], unit);
  return row(value, [
    [center.iu, unit.uy],
    [center.iv, -unit.ux],
    [radiusIndex, -1],
    [p.iu, -unit.uy - g[0]],
    [p.iv, unit.ux - g[1]],
    [q.iu, g[0]],
    [q.iv, g[1]],
  ]);
}

/** 半径(r − R)。 */
function radius(index: number, value: number, target: number): LinearizedRow {
  return row(value - target, [[index, 1]]);
}

/** 直径(2r − D)。 */
function diameter(index: number, value: number, target: number): LinearizedRow {
  return row(2 * value - target, [[index, 2]]);
}

/** 等しい(2 つの円の半径)。 */
function equalRadius(i1: number, r1: number, i2: number, r2: number): LinearizedRow {
  return row(r1 - r2, [
    [i1, 1],
    [i2, -1],
  ]);
}

/* ------------------------------------------------------------------ *
 * 1. 密行列の道具
 * ------------------------------------------------------------------ */

describe('ガウス消去(部分ピボット)', () => {
  it('2 元の連立を解く', () => {
    const x = solveLinearSystem(
      [
        [2, 1],
        [1, 3],
      ],
      [5, 10],
    );
    expect(x).not.toBeNull();
    // 2·1 + 1·3 = 5、1·1 + 3·3 = 10
    expectClose(x?.[0] ?? Number.NaN, 1, 1e-12);
    expectClose(x?.[1] ?? Number.NaN, 3, 1e-12);
  });

  it('x + y = 3、x − y = 1 を (2, 1) と解く', () => {
    const x = solveLinearSystem(
      [
        [1, 1],
        [1, -1],
      ],
      [3, 1],
    );
    expectClose(x?.[0] ?? Number.NaN, 2, 1e-12);
    expectClose(x?.[1] ?? Number.NaN, 1, 1e-12);
  });

  it('先頭の対角が 0 でも部分ピボットで解ける', () => {
    // 0·x + 1·y = 2、1·x + 0·y = 3 → x = 3、y = 2
    const x = solveLinearSystem(
      [
        [0, 1],
        [1, 0],
      ],
      [2, 3],
    );
    expectClose(x?.[0] ?? Number.NaN, 3, 1e-12);
    expectClose(x?.[1] ?? Number.NaN, 2, 1e-12);
  });

  it('3 元の連立を解く', () => {
    // x = 1、y = 2、z = 3 になるように右辺を作った
    const matrix = [
      [2, 1, -1],
      [-3, -1, 2],
      [-2, 1, 2],
    ];
    const x = solveLinearSystem(matrix, [2 + 2 - 3, -3 - 2 + 6, -2 + 2 + 6]);
    expectClose(x?.[0] ?? Number.NaN, 1, 1e-12);
    expectClose(x?.[1] ?? Number.NaN, 2, 1e-12);
    expectClose(x?.[2] ?? Number.NaN, 3, 1e-12);
  });

  it('特異な連立(2 行目が 1 行目の 2 倍)は null を返す', () => {
    expect(
      solveLinearSystem(
        [
          [1, 2],
          [2, 4],
        ],
        [3, 6],
      ),
    ).toBeNull();
  });

  it('平行な 2 直線の交点は求まらないと報告する', () => {
    // x − y = −1 と x − y = −2(y = x + 1 と y = x + 2)
    expect(
      solveLinearSystem(
        [
          [1, -1],
          [1, -1],
        ],
        [-1, -2],
      ),
    ).toBeNull();
  });

  it('入力の行列と右辺を書き換えない', () => {
    const matrix = [
      [2, 1],
      [1, 3],
    ];
    const rhs = [5, 10];
    solveLinearSystem(matrix, rhs);
    expect(matrix).toEqual([
      [2, 1],
      [1, 3],
    ]);
    expect(rhs).toEqual([5, 10]);
  });

  it('行数と列数が合わないときは例外を投げずに null を返す', () => {
    expect(solveLinearSystem([[1, 2]], [1, 2])).toBeNull();
    expect(solveLinearSystem([[1, 2, 3], [1, 2, 3]], [1, 2])).toBeNull();
  });

  it('大きさ 0 の連立は空の解を返す', () => {
    expect(solveLinearSystem([], [])).toEqual([]);
  });

  it.each([2, 5, 6, 7, 8, 9])('%d列の部分配列でも行交換と末尾の消去を正しく行う', (n) => {
    const expected = Array.from({ length: n }, (_, j) => j + 1);
    const matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
      (i === j ? 10 * n : 0) + (i * 3 + j * 7) % 11 - 5)).reverse();
    const storage = new Float64Array(n * n + 4).fill(12345);
    const work = storage.subarray(2, n * n + 2);
    work.set(matrix.flat());
    const rhs = Float64Array.from(matrix, (row) => row.reduce((sum, value, j) => sum + value * expected[j], 0));
    const actual = eliminate(work, rhs, n);
    expect(actual).not.toBeNull();
    for (let j = 0; j < n; j += 1) expectClose(actual?.[j] ?? NaN, expected[j], 1e-12);
    for (let i = 1; i < n; i += 1) {
      for (let j = 0; j < i; j += 1) expect(work[i * n + j]).toBe(0);
    }
    expect([...storage.subarray(0, 2), ...storage.subarray(n * n + 2)]).toEqual([12345, 12345, 12345, 12345]);
  });
});

describe('ハウスホルダー QR と階数', () => {
  it('単位行列の階数は 2', () => {
    expect(
      matrixRank(
        [
          [1, 0],
          [0, 1],
        ],
        2,
      ),
    ).toBe(2);
  });

  it('2 行目が 1 行目の 2 倍なら階数は 1', () => {
    expect(
      matrixRank(
        [
          [1, 0],
          [2, 0],
        ],
        2,
      ),
    ).toBe(1);
  });

  it('行が 3 本でも列が 2 本なら階数は 2 まで', () => {
    expect(
      matrixRank(
        [
          [1, 0],
          [0, 1],
          [1, 1],
        ],
        2,
      ),
    ).toBe(2);
  });

  it('行が 1 本も無ければ階数は 0', () => {
    expect(matrixRank([], 2)).toBe(0);
  });

  it('零行列の階数は 0', () => {
    expect(
      matrixRank(
        [
          [0, 0],
          [0, 0],
        ],
        2,
      ),
    ).toBe(0);
  });

  it('平行な 2 直線の係数行列の階数は 1(自由度が 1 残る)', () => {
    expect(
      matrixRank(
        [
          [1, -1],
          [1, -1],
        ],
        2,
      ),
    ).toBe(1);
  });

  it('R が上三角で、対角の絶対値が大きい順に並ぶ', () => {
    const qr = qrDecomposition(
      [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 10],
      ],
      3,
    );
    expect(qr.rank).toBe(3);
    for (let i = 1; i < 3; i += 1) {
      for (let j = 0; j < i; j += 1) {
        expectClose(qr.r[i][j], 0, 1e-12);
      }
    }
    expect(Math.abs(qr.diagonal[0])).toBeGreaterThanOrEqual(Math.abs(qr.diagonal[1]));
    expect(Math.abs(qr.diagonal[1])).toBeGreaterThanOrEqual(Math.abs(qr.diagonal[2]));
    expect([...qr.columnOrder].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('列数 0 でも例外を投げない', () => {
    const qr = qrDecomposition([[], []], 0);
    expect(qr.rank).toBe(0);
    expect(qr.columnOrder).toEqual([]);
  });

  it.each([Number.NaN, Infinity])('列数%sで行があれば空の行でも従来のRangeErrorを返す', (columns) => {
    for (const matrix of [[[1]], [[]]]) {
      expect(() => qrDecomposition(matrix, columns)).toThrow(new RangeError('Invalid array length'));
      expect(() => matrixRank(matrix, columns)).toThrow(new RangeError('Invalid array length'));
    }
  });

  it('行がなければ列数NaNでも従来の空の分解を返す', () => {
    expect(qrDecomposition([], Number.NaN)).toEqual({ rowCount: 0, columnCount: Number.NaN,
      r: [], columnOrder: [], diagonal: [], rank: 0, reflectors: [] });
    expect(matrixRank([], Number.NaN)).toBe(0);
    expect(() => qrDecomposition([], Infinity)).toThrow(new RangeError('Invalid array length'));
    expect(() => matrixRank([], Infinity)).toThrow(new RangeError('Invalid array length'));
  });

  it.each([-Infinity, -2, -0.5, 0, 0.5])('列数%sは従来どおり0に補正する', (columns) => {
    expect(qrDecomposition([[1, 2]], columns)).toEqual({ rowCount: 1, columnCount: 0,
      r: [[]], columnOrder: [], diagonal: [], rank: 0, reflectors: [] });
    expect(matrixRank([[1, 2]], columns)).toBe(0);
  });

  it('列数の小数部分を切り捨て、余分な入力列を使わない', () => {
    expect(qrDecomposition([[1, 2]], 1.9)).toEqual({ rowCount: 1, columnCount: 1,
      r: [[-1]], columnOrder: [0], diagonal: [-1], rank: 1, reflectors: [[1]] });
    expect(matrixRank([[1, 2]], 1.9)).toBe(1);
  });

  it.each([
    { name: '正方・列交換', matrix: [[1, 2, 3], [4, 5, 6], [7, 8, 10]], columns: 3, rank: 3 },
    { name: '横長', matrix: [[1, 2, 3, 4], [0, 1, 0, 2]], columns: 4, rank: 2 },
    { name: '縦長', matrix: [[1, 2], [3, 4], [5, 6], [7, 9]], columns: 2, rank: 2 },
    { name: '従属列', matrix: [[1, 2, 3], [2, 4, 6], [3, 6, 9]], columns: 3, rank: 1 },
    { name: '短い行を0で補う', matrix: [[1], [0, 2], []], columns: 3, rank: 2 },
    { name: '列がない', matrix: [[], []], columns: 0, rank: 0 },
    { name: '行がない', matrix: [], columns: 3, rank: 0 },
  ])('$nameでも公開した行配列Rと反射から元の列を復元できる', ({ matrix, columns, rank }) => {
    const before = matrix.map((row) => [...row]);
    const qr = qrDecomposition(matrix, columns);
    expect(qr.rank).toBe(rank);
    expect(qr.r).toHaveLength(matrix.length);
    for (const row of qr.r) expect(row).toHaveLength(columns);
    const reconstructed = qr.r.map((row) => [...row]);
    // AP = QR。Qを作る反射を逆順にRへ掛け、返された列順の入力へ戻ることを確かめる。
    for (const reflector of [...qr.reflectors].reverse()) {
      for (let j = 0; j < columns; j += 1) {
        const dot = reflector.reduce((sum, value, i) => sum + value * reconstructed[i][j], 0);
        for (let i = 0; i < matrix.length; i += 1) reconstructed[i][j] -= 2 * dot * reflector[i];
      }
    }
    for (let i = 0; i < matrix.length; i += 1) {
      for (let j = 0; j < columns; j += 1) expectClose(reconstructed[i][j], matrix[i][qr.columnOrder[j]] ?? 0, 1e-12);
    }
    expect(matrix).toEqual(before);
    expect(qrDecomposition(matrix, columns)).toEqual(qr);
  });

  it.each([
    { diagonal: 0.5e-9, rank: 1 }, { diagonal: 1e-9, rank: 1 }, { diagonal: 1.5e-9, rank: 2 },
  ])('相対許容の境界で対角$diagonalの階数は$rank', ({ diagonal, rank }) => {
    expect(matrixRank([[1, 0], [0, diagonal]], 2)).toBe(rank);
  });
});

describe('過剰決定の最小二乗', () => {
  it('3 点を通る直線を最小二乗で求める', () => {
    // (1,2)、(2,3)、(3,5) に y = a·x + b を当てる。
    // 正規方程式 14a + 6b = 23、6a + 3b = 10 → a = 1.5、b = 1/3
    const x = solveLeastSquares(
      [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      [2, 3, 5],
      2,
    );
    expect(x).not.toBeNull();
    expectClose(x?.[0] ?? Number.NaN, 1.5, 1e-12);
    expectClose(x?.[1] ?? Number.NaN, 1 / 3, 1e-12);
  });

  it('正方でフルランクならガウス消去と同じ解になる', () => {
    const matrix = [
      [2, 1],
      [1, 3],
    ];
    const rhs = [5, 10];
    const bySquare = solveLinearSystem(matrix, rhs);
    const byLeastSquares = solveLeastSquares(matrix, rhs, 2);
    expectClose((byLeastSquares?.[0] ?? Number.NaN) - (bySquare?.[0] ?? Number.NaN), 0, 1e-12);
    expectClose((byLeastSquares?.[1] ?? Number.NaN) - (bySquare?.[1] ?? Number.NaN), 0, 1e-12);
  });

  it('階数が足りないときは一意に決まらないので null を返す', () => {
    expect(
      solveLeastSquares(
        [
          [1, -1],
          [1, -1],
          [1, -1],
        ],
        [1, 1, 1],
        2,
      ),
    ).toBeNull();
  });

  it('右辺の長さが行数と違うときは null を返す', () => {
    expect(solveLeastSquares([[1, 1]], [1, 2], 2)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 2. 検査で使う残差の偏微分が正しいこと
 * ------------------------------------------------------------------ */

describe('検査で使う簡易版の残差(解析式の偏微分)', () => {
  it('13 通りの並びで、解析式の偏微分が中心差分と 1e-6 以下で一致する', () => {
    const cases: readonly { readonly label: string; readonly build: (x: readonly number[]) => LinearizedRow }[] = [
      { label: '一致 u', build: (x) => coincident(movable(x, 0, 1), movable(x, 2, 3))[0] },
      { label: '一致 v', build: (x) => coincident(movable(x, 0, 1), movable(x, 2, 3))[1] },
      { label: '水平', build: (x) => horizontal(movable(x, 0, 1), movable(x, 2, 3)) },
      { label: '垂直', build: (x) => vertical(movable(x, 0, 1), movable(x, 2, 3)) },
      { label: '距離', build: (x) => distance(movable(x, 0, 1), movable(x, 2, 3), 7) },
      {
        label: '平行',
        build: (x) => parallel(movable(x, 0, 1), movable(x, 2, 3), movable(x, 4, 5), movable(x, 6, 7)),
      },
      {
        label: '直角',
        build: (x) => perpendicular(movable(x, 0, 1), movable(x, 2, 3), movable(x, 4, 5), movable(x, 6, 7)),
      },
      {
        label: '角度',
        build: (x) =>
          angle(movable(x, 0, 1), movable(x, 2, 3), movable(x, 4, 5), movable(x, 6, 7), Math.PI / 6),
      },
      {
        label: '等しい(線分)',
        build: (x) => equalLength(movable(x, 0, 1), movable(x, 2, 3), movable(x, 4, 5), movable(x, 6, 7)),
      },
      {
        label: '対称(中点)',
        build: (x) => symmetric(movable(x, 0, 1), movable(x, 2, 3), pinned(0, 0), pinned(6, 2))[0],
      },
      {
        label: '対称(直交)',
        build: (x) => symmetric(movable(x, 0, 1), movable(x, 2, 3), pinned(0, 0), pinned(6, 2))[1],
      },
      {
        label: '接線',
        build: (x) => tangent(movable(x, 0, 1), movable(x, 2, 3), movable(x, 4, 5), x[6], 6),
      },
      { label: '直径', build: (x) => diameter(6, x[6], 9) },
    ];
    const base = [1.3, -0.7, 5.1, 2.4, -2.2, 3.6, 4.3, -1.9];
    const h = 1e-6;
    for (const { label, build } of cases) {
      const analytic = build(base).gradient;
      for (let i = 0; i < base.length; i += 1) {
        const plus = [...base];
        plus[i] += h;
        const minus = [...base];
        minus[i] -= h;
        const numeric = (build(plus).value - build(minus).value) / (2 * h);
        const written = analytic.get(i) ?? 0;
        const scale = Math.max(1, Math.abs(numeric));
        expect(Math.abs(written - numeric) / scale, `${label} の ${i} 列目`).toBeLessThan(1e-6);
      }
    }
  });

  it('偏微分が 0 の項は行に入らない(疎な行)', () => {
    const x = [0, 0, 7, 4];
    expect(horizontal(movable(x, 0, 1), movable(x, 2, 3)).gradient.size).toBe(2);
    // 始点が動かない点なら 1 項だけ
    expect(horizontal(pinned(0, 0), movable(x, 2, 3)).gradient.size).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Levenberg–Marquardt(拘束の組)
 * ------------------------------------------------------------------ */

describe('Levenberg–Marquardt: 基本の動き', () => {
  it('初期値がすでに解なら 1 回も反復しない', () => {
    const outcome = solveLevenbergMarquardt([3], (x) => [row(x[0] - 3, [[0, 1]])]);
    expect(outcome.converged).toBe(true);
    expect(outcome.iterations).toBe(0);
    expect(outcome.stop).toBe('converged');
    expect(outcome.trace).toEqual([]);
  });

  it('変数が 0 個でも例外を投げない', () => {
    const outcome = solveLevenbergMarquardt([], () => []);
    expect(outcome.converged).toBe(true);
    expect(outcome.x).toEqual([]);
  });

  it('拘束が 0 本なら初期値をそのまま返す', () => {
    const outcome = solveLevenbergMarquardt([3, 4], () => []);
    expect(outcome.x).toEqual([3, 4]);
    expect(outcome.iterations).toBe(0);
  });

  it('円 x² + y² = 25 と直線 y = x の交点 (5/√2, 5/√2) を求める', () => {
    const outcome = solveLevenbergMarquardt([4, 3], (x) => [
      row(x[0] * x[0] + x[1] * x[1] - 25, [
        [0, 2 * x[0]],
        [1, 2 * x[1]],
      ]),
      row(x[1] - x[0], [
        [0, -1],
        [1, 1],
      ]),
    ]);
    expect(outcome.converged).toBe(true);
    const expected = 5 * Math.SQRT1_2;
    expectClose(outcome.x[0], expected);
    expectClose(outcome.x[1], expected);
  });

  it('初期値の配列を書き換えない', () => {
    const initial = [4, 3];
    solveLevenbergMarquardt(initial, (x) => [row(x[0] - 1, [[0, 1]]), row(x[1] - 1, [[1, 1]])]);
    expect(initial).toEqual([4, 3]);
  });

  it('同じ入力から 10 回解くと 10 回とも同じ解になる(決定性)', () => {
    const solve = (): readonly number[] =>
      solveLevenbergMarquardt([7, 4], (x) => [
        horizontal(pinned(0, 0), movable(x, 0, 1)),
        distance(pinned(0, 0), movable(x, 0, 1), 10),
      ]).x;
    const first = solve();
    for (let i = 0; i < 9; i += 1) {
      expect(solve()).toEqual(first);
    }
  });

  it('各反復の記録が残り、残差が単調に減る', () => {
    const outcome = solveLevenbergMarquardt([7, 4], (x) => [
      horizontal(pinned(0, 0), movable(x, 0, 1)),
      distance(pinned(0, 0), movable(x, 0, 1), 10),
    ]);
    expect(outcome.trace.length).toBe(outcome.iterations);
    expect(outcome.trace.every((record) => record.accepted)).toBe(true);
    for (let i = 1; i < outcome.trace.length; i += 1) {
      expect(outcome.trace[i].norm).toBeLessThan(outcome.trace[i - 1].norm);
    }
    expect(outcome.trace[0].iteration).toBe(1);
  });

  it('反復の上限を渡すとそこで打ち切る(例外を投げない)', () => {
    const outcome = solveLevenbergMarquardt(
      [7, 4],
      (x) => [
        horizontal(pinned(0, 0), movable(x, 0, 1)),
        distance(pinned(0, 0), movable(x, 0, 1), 10),
      ],
      { maxIterations: 1 },
    );
    expect(outcome.iterations).toBe(1);
    expect(outcome.stop).toBe('maxIterations');
    expect(outcome.converged).toBe(false);
  });

  it('収束の許容量を緩めると反復が減る', () => {
    const build = (x: readonly number[]): LinearizedRow[] => [
      horizontal(pinned(0, 0), movable(x, 0, 1)),
      distance(pinned(0, 0), movable(x, 0, 1), 10),
    ];
    const strict = solveLevenbergMarquardt([7, 4], build);
    const loose = solveLevenbergMarquardt([7, 4], build, { tolerance: 1e-3 });
    expect(loose.converged).toBe(true);
    expect(loose.iterations).toBeLessThan(strict.iterations);
  });

  it('既定の許容量・上限・減衰が想定の値である', () => {
    expect(CONSTRAINT_TOLERANCE).toBe(1e-9);
    expect(CONSTRAINT_MAX_ITERATIONS).toBe(50);
    expect(CONSTRAINT_INITIAL_DAMPING).toBe(1e-6);
  });
});

describe('Levenberg–Marquardt: 拘束の組を解く', () => {
  it('水平+長さ 10(始点は固定)で終点が (10, 0) になる', () => {
    const outcome = solveLevenbergMarquardt([7, 4], (x) => [
      horizontal(pinned(0, 0), movable(x, 0, 1)),
      distance(pinned(0, 0), movable(x, 0, 1), 10),
    ]);
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 10);
    expectClose(outcome.x[1], 0);
    expect(outcome.iterations).toBeLessThanOrEqual(8);
  });

  it('垂直+長さ 10(始点は固定)で終点が (0, 10) になる', () => {
    const outcome = solveLevenbergMarquardt([4, 9], (x) => [
      vertical(pinned(0, 0), movable(x, 0, 1)),
      distance(pinned(0, 0), movable(x, 0, 1), 10),
    ]);
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 0);
    expectClose(outcome.x[1], 10);
  });

  it('一致(両方とも動ける)で 2 点が中点 (5, 2.5) へ寄る(最小移動)', () => {
    const outcome = solveLevenbergMarquardt([3, 4, 7, 1], (x) =>
      coincident(movable(x, 0, 1), movable(x, 2, 3)),
    );
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 5);
    expectClose(outcome.x[1], 2.5);
    expectClose(outcome.x[2], 5);
    expectClose(outcome.x[3], 2.5);
  });

  it('距離 10 で (3, 4) が向きを保ったまま (6, 8) へ動く', () => {
    const outcome = solveLevenbergMarquardt([3, 4], (x) => [
      distance(pinned(0, 0), movable(x, 0, 1), 10),
    ]);
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 6);
    expectClose(outcome.x[1], 8);
    expect(outcome.iterations).toBeLessThanOrEqual(4);
  });

  it('等しい(2 円の半径 3 と 7)で両方 5 になる(最小移動)', () => {
    const outcome = solveLevenbergMarquardt([3, 7], (x) => [equalRadius(0, x[0], 1, x[1])]);
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 5);
    expectClose(outcome.x[1], 5);
    expect(outcome.iterations).toBeLessThanOrEqual(10);
  });

  it('対称(軸は固定)で 2 点が軸から等しい距離になる', () => {
    const outcome = solveLevenbergMarquardt([2, 3, 2, -9], (x) =>
      symmetric(movable(x, 0, 1), movable(x, 2, 3), pinned(0, 0), pinned(10, 0)),
    );
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 2);
    expectClose(outcome.x[1], 6);
    expectClose(outcome.x[2], 2);
    expectClose(outcome.x[3], -6);
  });

  it('同心(片方は固定)で中心が重なる', () => {
    const outcome = solveLevenbergMarquardt([3, 4], (x) =>
      coincident(pinned(0, 0), movable(x, 0, 1)),
    );
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 0);
    expectClose(outcome.x[1], 0);
    expect(outcome.iterations).toBeLessThanOrEqual(3);
  });

  it('接線+水平で線分が円の上へ降り、u は動かない', () => {
    const outcome = solveLevenbergMarquardt([0, 10, 10, 10], (x) => [
      tangent(movable(x, 0, 1), movable(x, 2, 3), pinned(0, 0), 5, null),
      horizontal(movable(x, 0, 1), movable(x, 2, 3)),
    ]);
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 0);
    expectClose(outcome.x[1], 5);
    expectClose(outcome.x[2], 10);
    expectClose(outcome.x[3], 5);
  });

  it('平行+長さ 10 で 2 本目の終点が (10, 5) になる', () => {
    const outcome = solveLevenbergMarquardt([8, 9], (x) => [
      parallel(pinned(0, 0), pinned(10, 0), pinned(0, 5), movable(x, 0, 1)),
      distance(pinned(0, 5), movable(x, 0, 1), 10),
    ]);
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 10);
    expectClose(outcome.x[1], 5);
  });

  it('直角+等しい+一致で 2 本目が (10, 0)–(10, 10) になる', () => {
    const outcome = solveLevenbergMarquardt([12, 3, 16, 8], (x) => [
      ...coincident(movable(x, 0, 1), pinned(10, 0)),
      perpendicular(pinned(0, 0), pinned(10, 0), movable(x, 0, 1), movable(x, 2, 3)),
      equalLength(pinned(0, 0), pinned(10, 0), movable(x, 0, 1), movable(x, 2, 3)),
    ]);
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 10);
    expectClose(outcome.x[1], 0);
    expectClose(outcome.x[2], 10);
    expectClose(outcome.x[3], 10);
  });

  it('角度 30°+長さ 10 で終点が (10cos30°, 5) になる', () => {
    const outcome = solveLevenbergMarquardt([10, 10], (x) => [
      angle(pinned(0, 0), pinned(10, 0), pinned(0, 0), movable(x, 0, 1), Math.PI / 6),
      distance(pinned(0, 0), movable(x, 0, 1), 10),
    ]);
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 10 * Math.cos(Math.PI / 6));
    expectClose(outcome.x[1], 5);
  });

  it('半径拘束 R = 8 で半径 3 が 8 になる', () => {
    const outcome = solveLevenbergMarquardt([3], (x) => [radius(0, x[0], 8)]);
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 8);
  });

  it('直径拘束 D = 20 で半径 3 が 10 になる', () => {
    const outcome = solveLevenbergMarquardt([3], (x) => [diameter(0, x[0], 20)]);
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 10);
  });

  it('重複(同じ線分に長さ 10 が 2 つ)は冗長でも解ける', () => {
    const outcome = solveLevenbergMarquardt([3, 4], (x) => [
      distance(pinned(0, 0), movable(x, 0, 1), 10),
      distance(pinned(0, 0), movable(x, 0, 1), 10),
    ]);
    expect(outcome.converged).toBe(true);
    expectClose(Math.sqrt(outcome.x[0] ** 2 + outcome.x[1] ** 2), 10);
  });

  it('同時に成り立たない拘束(長さ 10 と長さ 12)は収束せず、例外も投げない', () => {
    const outcome = solveLevenbergMarquardt([3, 4], (x) => [
      distance(pinned(0, 0), movable(x, 0, 1), 10),
      distance(pinned(0, 0), movable(x, 0, 1), 12),
    ]);
    expect(outcome.converged).toBe(false);
    expect(outcome.maxResidual).toBeGreaterThan(CONSTRAINT_TOLERANCE);
    // 2 乗和が最小になるのは長さ 11(10 と 12 の真ん中)
    expectClose(Math.sqrt(outcome.x[0] ** 2 + outcome.x[1] ** 2), 11, 1e-6);
    expect(outcome.iterations).toBeLessThanOrEqual(CONSTRAINT_MAX_ITERATIONS);
  });

  it('どうやっても 0 にならない残差でも打ち切って結果を返す', () => {
    const outcome = solveLevenbergMarquardt([1], (x) => [row(x[0] * x[0] + 1, [[0, 2 * x[0]]])]);
    expect(outcome.converged).toBe(false);
    expect(outcome.iterations).toBeLessThanOrEqual(CONSTRAINT_MAX_ITERATIONS);
    expect(Number.isFinite(outcome.x[0])).toBe(true);
  });

  it('自由度が残っていても、決まらない座標は動かない(最小移動)', () => {
    // 変数は 2 つだが、式は「u = 5」の 1 本だけ。v は初期値のまま。
    const outcome = solveLevenbergMarquardt([1, 42], (x) => [row(x[0] - 5, [[0, 1]])]);
    expect(outcome.converged).toBe(true);
    expectClose(outcome.x[0], 5);
    expectClose(outcome.x[1], 42);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 性能(§2.9、NFR-PF-2)
 * ------------------------------------------------------------------ */

/**
 * 練習用の問題(実際の輪郭に近い形): 点を横一列に並べ、隣どうしを「距離 10」と「水平」で
 * つなぎ、先頭の点を固定する。変数 2P に対して式も 2P(= 2 + 2(P−1))でちょうど決まる。
 * 初期値は正解を少しずらしたもの(ドラッグの 1 コマぶん = 実際の使われ方に近い)。
 * 乱数を使わないので、何度走らせても同じ問題になる。
 *
 * `pinAll` を false にすると先頭の固定を u だけにして式を 1 本減らし、
 * **変数のほうが多い(階数が落ちる)**大きさの検査に使う。
 */
function chainProblem(
  pointCount: number,
  pinAll: boolean,
): { initial: number[]; evaluate: (x: readonly number[]) => LinearizedRow[] } {
  const spacing = 10;
  const target: number[] = [];
  for (let i = 0; i < pointCount; i += 1) {
    target.push(i * spacing, 0);
  }
  const initial = target.map((value, index) => value + (((index * 37) % 11) - 5) / 50);
  const evaluate = (x: readonly number[]): LinearizedRow[] => {
    const rows: LinearizedRow[] = [];
    rows.push(row(x[0], [[0, 1]]));
    if (pinAll) {
      rows.push(row(x[1], [[1, 1]]));
    }
    for (let i = 0; i + 1 < pointCount; i += 1) {
      const a = movable(x, 2 * i, 2 * i + 1);
      const b = movable(x, 2 * i + 2, 2 * i + 3);
      rows.push(distance(a, b, spacing));
      rows.push(horizontal(a, b));
    }
    return rows;
  };
  return { initial, evaluate };
}

/**
 * 消去の「埋まり」が最悪に近い並び。1 本の式が結ぶ 8 個の変数を全体へ散らしてあるので、
 * `JᵀJ` が帯状にならず、ガウス消去が n³/3 に近い手数になる。
 * 実際の拘束は近くの点どうしを結ぶので帯状になりやすいが、上限の見積り
 * (計画書 §2.2「1 反復 20〜40ms」)はこの並びを想定している。
 */
function scatteredProblem(
  variableCount: number,
  equationCount: number,
): { initial: number[]; evaluate: (x: readonly number[]) => LinearizedRow[] } {
  const initial = Array.from({ length: variableCount }, (_, index) => 1 + ((index * 13) % 7) / 10);
  const evaluate = (x: readonly number[]): LinearizedRow[] => {
    const rows: LinearizedRow[] = [];
    for (let k = 0; k < equationCount; k += 1) {
      const entries: Entry[] = [];
      let value = 0;
      for (let t = 0; t < 8; t += 1) {
        const index = (k * 37 + t * 149) % variableCount;
        entries.push([index, 1]);
        value += x[index];
      }
      rows.push(row(value - 8, entries));
    }
    return rows;
  };
  return { initial, evaluate };
}

/**
 * 単発の時計値の揺れを抑えるため、固定3回の予熱後に7回の中央値で判定する。
 * 全 sample で同じ solve 全体を測る。結果検査は計時外で毎回行い、測定値は除外しない。
 */
function measureMedian<T>(action: () => T, check: (outcome: T) => void, now = () => performance.now()) {
  let outcome = action();
  for (let warmup = 1; warmup < 3; warmup += 1) outcome = action();
  const samples: number[] = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const startedAt = now();
    outcome = action();
    samples.push(now() - startedAt);
    check(outcome);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return { outcome, elapsedMs: sorted[3], samples };
}

describe('拘束を解く速さの測定', () => {
  it('予熱3回の後の全7値を保持し、毎回の結果を検査して中央値を選ぶ', () => {
    const durations = [99, 99, 99, 11, 2, 9, 5, 7, 3, 100];
    let calls = 0;
    let clock = 0;
    const checked: number[] = [];
    const measured = measureMedian(
      () => { clock += durations[calls]; calls += 1; return calls; },
      (outcome) => { checked.push(outcome); clock += 1000; },
      () => clock,
    );
    expect(calls).toBe(10);
    expect(checked).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(measured.samples).toEqual([11, 2, 9, 5, 7, 3, 100]);
    expect(measured.elapsedMs).toBe(7);
    expect(measured.outcome).toBe(10);
  });
});

describe('拘束を解く速さ(§2.9、NFR-PF-2)', () => {
  it('変数 100・式 100 を 8ms 以内で解く', () => {
    const { initial, evaluate } = chainProblem(50, true);
    const { outcome, elapsedMs, samples } = measureMedian(
      () => solveLevenbergMarquardt(initial, evaluate),
      (result) => { expect(result.converged).toBe(true); },
    );
    console.log('拘束を解く(変数 100・式 100)の全測定値(ms):', JSON.stringify(samples));
    console.log(
      `拘束を解く(変数 100・式 100): 中央値 ${elapsedMs.toFixed(2)} ms / 反復 ${outcome.iterations} 回(上限 8 ms)`,
    );
    expectWithinBudget(elapsedMs, 8, '変数 100・式 100');
  });

  it('変数 200・式 200 を 500ms 以内で解く(NFR-PF-2)', () => {
    const { initial, evaluate } = chainProblem(100, true);
    const { outcome, elapsedMs, samples } = measureMedian(
      () => solveLevenbergMarquardt(initial, evaluate),
      (result) => { expect(result.converged).toBe(true); },
    );
    console.log('拘束を解く(変数 200・式 200)の全測定値(ms):', JSON.stringify(samples));
    console.log(
      `拘束を解く(変数 200・式 200): 中央値 ${elapsedMs.toFixed(2)} ms / 反復 ${outcome.iterations} 回(上限 500 ms)`,
    );
    expectWithinBudget(elapsedMs, 500, '変数 200・式 200');
  });

  it('変数 400・式 200(上限の大きさ・階数落ち)の 1 反復が 20ms 以内で終わる', () => {
    const { initial, evaluate } = chainProblem(200, false);
    expect(initial.length).toBe(400);
    expect(evaluate(initial).length).toBe(399);
    const { elapsedMs, samples } = measureMedian(
      () => solveLevenbergMarquardt(initial, evaluate, { maxIterations: 1 }),
      (result) => { expect(result.iterations).toBe(1); },
    );
    console.log('拘束を解く(変数 400・隣どうしの式)の全測定値(ms):', JSON.stringify(samples));
    console.log(`拘束を解く(変数 400・隣どうしの式)の 1 反復: 中央値 ${elapsedMs.toFixed(2)} ms(目安 20 ms)`);
    expectWithinBudget(elapsedMs, 20, '変数 400・隣どうしの式の 1 反復');
  });

  it('変数 400・式 200(埋まりが最悪に近い並び)の 1 反復が 40ms 以内で終わる', () => {
    const { initial, evaluate } = scatteredProblem(400, 200);
    expect(initial.length).toBe(400);
    expect(evaluate(initial).length).toBe(200);
    // 式より変数が多い(階数が落ちる)ので、全 sample で減衰を伴う同じ1反復を測る。
    const { elapsedMs, samples } = measureMedian(
      () => solveLevenbergMarquardt(initial, evaluate, { maxIterations: 1 }),
      (result) => { expect(result.iterations).toBe(1); },
    );
    console.log('拘束を解く(変数 400・式 200、散らした並び)の全測定値(ms):', JSON.stringify(samples));
    console.log(
      `拘束を解く(変数 400・式 200、散らした並び)の 1 反復: 中央値 ${elapsedMs.toFixed(2)} ms(計画書 §2.2 の見積り 20〜40 ms)`,
    );
    expectWithinBudget(elapsedMs, 40, '変数 400・式 200(散らした並び)の 1 反復');
  });
});
