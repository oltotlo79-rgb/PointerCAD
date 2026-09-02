import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { BoxParameters, Vec3Tuple } from '../types.js';
import { booleanOp } from './booleanOp.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';

/** 大きい方の箱。原点を角とする 20 × 20 × 20 で、体積は 20·20·20 = 8000 mm³。 */
const BIG_BOX: BoxParameters = { dx: 20, dy: 20, dz: 20 };
const BIG_VOLUME = 8000;

/** 小さい方の箱。原点を角とする 10 × 10 × 10 で、体積は 10·10·10 = 1000 mm³。 */
const SMALL_BOX: BoxParameters = { dx: 10, dy: 10, dz: 10 };
const SMALL_VOLUME = 1000;

/**
 * どちらも原点を角とするので、小さい箱 (0,0,0)-(10,10,10) は
 * 大きい箱 (0,0,0)-(20,20,20) に完全に含まれる。したがって
 *   和 = 8000            (小さい箱は大きい箱の中にあるので大きい箱のまま)
 *   差 = 8000 − 1000 = 7000
 *   積 = 1000            (共通部分は小さい箱そのもの)
 * いずれも手計算した値で、実測に合わせて動かさない。
 */
const UNION_CONTAINED = BIG_VOLUME;
const SUBTRACT_CONTAINED = BIG_VOLUME - SMALL_VOLUME;
const INTERSECT_CONTAINED = SMALL_VOLUME;

/** 交わらない位置へ小さい箱を置くときのずらし量(mm)。100 > 20 なので確実に離れる。 */
const FAR_OFFSET: Vec3Tuple = [100, 0, 0];

/** 離れた 2 体の和は単純な足し算になる。8000 + 1000 = 9000。 */
const UNION_DISJOINT = BIG_VOLUME + SMALL_VOLUME;

/**
 * 半分だけ重なる配置の独立検算に使うずらし量(mm)。
 * 20 × 20 × 20 の箱を (10,10,10) ずらすと、重なりは各軸 10 mm ぶんになる。
 *   積 = 10·10·10 = 1000
 *   和 = 8000 + 8000 − 1000 = 15000  (包除原理 |A∪B| = |A| + |B| − |A∩B|)
 *   差 = 8000 − 1000 = 7000          (A から重なりを取り除いた残り)
 */
const HALF_OFFSET: Vec3Tuple = [10, 10, 10];
const HALF_INTERSECT = 10 * 10 * 10;
const HALF_UNION = BIG_VOLUME + BIG_VOLUME - HALF_INTERSECT;
const HALF_SUBTRACT = BIG_VOLUME - HALF_INTERSECT;

interface TestShapeHandle {
  readonly shape: TopoDS_Shape;
  delete(): void;
}

/**
 * 箱を平行移動して置く。
 * makeBox は原点を角とする箱しか作れないので、離れた位置や半分だけ重なる位置の箱は
 * ここで gp_Trsf の平行移動 + BRepBuilderAPI_Transform_2 で作る。
 */
function makeTranslatedBox(
  oc: OpenCascadeInstance,
  parameters: BoxParameters,
  offset: Vec3Tuple,
): TestShapeHandle {
  const box = makeBox(oc, parameters);
  const translation = new oc.gp_Trsf_1();
  const vector = new oc.gp_Vec_4(offset[0], offset[1], offset[2]);
  translation.SetTranslation_1(vector);
  // 第 3 引数 Copy = true は、元の形を書き換えずに写しを作る指定。
  const transform = new oc.BRepBuilderAPI_Transform_2(box.shape, translation, true);
  const deleteParts = (): void => {
    transform.delete();
    vector.delete();
    translation.delete();
    box.delete();
  };

  if (!transform.IsDone()) {
    deleteParts();
    throw new Error('テスト用の箱を平行移動できませんでした。');
  }
  const shape = transform.Shape();

  return {
    shape,
    delete(): void {
      shape.delete();
      deleteParts();
    },
  };
}

describe('立体の和・差・積(ブーリアン)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('小さい箱を完全に含む大きい箱との和は、大きい箱のままの 8000 mm³ になる', () => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      const result = booleanOp(oc, 'union', big.shape, small.shape);
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(UNION_CONTAINED, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('大きい箱から中に含まれる小さい箱を引くと 7000 mm³ になる', () => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      const result = booleanOp(oc, 'subtract', big.shape, small.shape);
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(SUBTRACT_CONTAINED, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('大きい箱と中に含まれる小さい箱の積は、小さい箱と同じ 1000 mm³ になる', () => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      const result = booleanOp(oc, 'intersect', big.shape, small.shape);
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(INTERSECT_CONTAINED, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('半分だけ重なる 2 つの箱で、積が 1000・和が 15000・差が 7000 になる(包除原理の検算)', () => {
    const big = makeBox(oc, BIG_BOX);
    const shifted = makeTranslatedBox(oc, BIG_BOX, HALF_OFFSET);
    try {
      const intersection = booleanOp(oc, 'intersect', big.shape, shifted.shape);
      try {
        expect(measureVolume(oc, intersection.shape)).toBeCloseTo(HALF_INTERSECT, 6);
        expect(hasSolid(oc, intersection.shape)).toBe(true);
        expect(isValidShape(oc, intersection.shape)).toBe(true);
      } finally {
        intersection.delete();
      }

      const union = booleanOp(oc, 'union', big.shape, shifted.shape);
      try {
        expect(measureVolume(oc, union.shape)).toBeCloseTo(HALF_UNION, 6);
        expect(hasSolid(oc, union.shape)).toBe(true);
        expect(isValidShape(oc, union.shape)).toBe(true);
      } finally {
        union.delete();
      }

      const difference = booleanOp(oc, 'subtract', big.shape, shifted.shape);
      try {
        expect(measureVolume(oc, difference.shape)).toBeCloseTo(HALF_SUBTRACT, 6);
        expect(hasSolid(oc, difference.shape)).toBe(true);
        expect(isValidShape(oc, difference.shape)).toBe(true);
      } finally {
        difference.delete();
      }
    } finally {
      shifted.delete();
      big.delete();
    }
  });

  it('離れた 2 つの箱の和は、2 つの塊を含んだまま体積が 9000 mm³ になる', () => {
    const big = makeBox(oc, BIG_BOX);
    const far = makeTranslatedBox(oc, SMALL_BOX, FAR_OFFSET);
    try {
      const result = booleanOp(oc, 'union', big.shape, far.shape);
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(UNION_DISJOINT, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      far.delete();
      big.delete();
    }
  });

  it('組み合わせた結果をそのまま次の演算の入力にできる(和のあとに差を取る)', () => {
    const big = makeBox(oc, BIG_BOX);
    const far = makeTranslatedBox(oc, SMALL_BOX, FAR_OFFSET);
    try {
      // (大きい箱 ∪ 離れた小さい箱) − 大きい箱 = 離れた小さい箱。9000 − 8000 = 1000。
      const combined = booleanOp(oc, 'union', big.shape, far.shape);
      try {
        const remainder = booleanOp(oc, 'subtract', combined.shape, big.shape);
        try {
          expect(measureVolume(oc, remainder.shape)).toBeCloseTo(SMALL_VOLUME, 6);
          expect(hasSolid(oc, remainder.shape)).toBe(true);
          expect(isValidShape(oc, remainder.shape)).toBe(true);
        } finally {
          remainder.delete();
        }
      } finally {
        combined.delete();
      }
    } finally {
      far.delete();
      big.delete();
    }
  });

  it('含まれている側から含んでいる側を引くと、何も残らないので理由をつけて断る', () => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      expect(() => booleanOp(oc, 'subtract', small.shape, big.shape)).toThrow(
        '組み合わせた結果、立体が残りませんでした。',
      );
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('離れた 2 つの箱の積は交わりが無いので理由をつけて断る', () => {
    const big = makeBox(oc, BIG_BOX);
    const far = makeTranslatedBox(oc, SMALL_BOX, FAR_OFFSET);
    try {
      expect(() => booleanOp(oc, 'intersect', big.shape, far.shape)).toThrow(
        '組み合わせた結果、立体が残りませんでした。',
      );
    } finally {
      far.delete();
      big.delete();
    }
  });

  it('結果を解放しても、渡した 2 つの立体はそのまま使える(引数を解放しない約束)', () => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      const result = booleanOp(oc, 'union', big.shape, small.shape);
      result.delete();
      expect(measureVolume(oc, big.shape)).toBeCloseTo(BIG_VOLUME, 6);
      expect(measureVolume(oc, small.shape)).toBeCloseTo(SMALL_VOLUME, 6);
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('断ったあとでも、渡した 2 つの立体はそのまま使える', () => {
    const big = makeBox(oc, BIG_BOX);
    const far = makeTranslatedBox(oc, SMALL_BOX, FAR_OFFSET);
    try {
      expect(() => booleanOp(oc, 'intersect', big.shape, far.shape)).toThrow(Error);
      expect(measureVolume(oc, big.shape)).toBeCloseTo(BIG_VOLUME, 6);
      expect(measureVolume(oc, far.shape)).toBeCloseTo(SMALL_VOLUME, 6);
    } finally {
      far.delete();
      big.delete();
    }
  });
});
