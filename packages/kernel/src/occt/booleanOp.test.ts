import type {
  BRepAlgoAPI_BooleanOperation,
  OpenCascadeInstance,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { BooleanOperation, BoxParameters, Vec3Tuple } from '../types.js';
import type { OcctDeletable } from './allocations.js';
import * as allocationModule from './allocations.js';
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

/** 同じ入力を貸し続けた場合と、新しい入力の結果を体積・位相で比較する。 */
function shapeMetrics(oc: OpenCascadeInstance, shape: TopoDS_Shape) {
  const { keep, release } = allocationModule.createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    let faces = 0;
    let edges = 0;
    for (let index = 1; index <= map.Size(); index += 1) {
      const subShape = keep(map.FindKey(index));
      if (subShape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) faces += 1;
      if (subShape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) edges += 1;
    }
    return { volume: measureVolume(oc, shape), faces, edges };
  } finally {
    release();
  }
}

function expectSameMetrics(
  actual: ReturnType<typeof shapeMetrics>,
  expected: ReturnType<typeof shapeMetrics>,
): void {
  expect(Math.abs(actual.volume - expected.volume) / Math.abs(expected.volume)).toBeLessThan(1e-6);
  expect(actual.faces).toBe(expected.faces);
  expect(actual.edges).toBe(expected.edges);
}

/** 控えの実物を使い、確保した各オブジェクトへの delete を個別に数える。 */
function observeAllocations(oc: OpenCascadeInstance) {
  const entries: { item: OcctDeletable; deleted: number }[] = [];
  const buildModes: boolean[] = [];
  function track<T extends OcctDeletable>(item: T): T {
    const entry = { item, deleted: 0 };
    const originalDelete = item.delete.bind(item);
    item.delete = (): void => {
      entry.deleted += 1;
      originalDelete();
    };
    entries.push(entry);
    if (item instanceof oc.BRepAlgoAPI_BooleanOperation) {
      const maker: BRepAlgoAPI_BooleanOperation = item;
      const build = maker.Build.bind(maker);
      // prototype の例外注入モックを二重に spyOn せず、実体の呼び出しだけを観測する。
      maker.Build = (range): void => {
        buildModes.push(maker.NonDestructive());
        build(range);
      };
    }
    return item;
  }

  const createAllocations = allocationModule.createAllocations;
  vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
    const allocations = createAllocations();
    return {
      keep<T extends OcctDeletable>(item: T): T {
        return allocations.keep(track(item));
      },
      release: allocations.release,
    };
  });
  // solidMesh の2関数は自分の finally で解放するため、その一時物も別に数える。
  const Properties = oc.GProp_GProps_1;
  vi.spyOn(oc, 'GProp_GProps_1').mockImplementation(function () {
    return track(new Properties());
  });
  const Analyzer = oc.BRepCheck_Analyzer;
  vi.spyOn(oc, 'BRepCheck_Analyzer').mockImplementation(function (
    ...args: ConstructorParameters<typeof Analyzer>
  ) {
    return track(new Analyzer(...args));
  });

  return { entries, buildModes };
}

const OPERATIONS: readonly BooleanOperation[] = ['union', 'subtract', 'intersect'];
const EXCEPTION_POINTS = [
  'Append_1',
  'SetArguments',
  'SetTools',
  'SetNonDestructive',
  'Build',
  'HasErrors',
  'IsDone',
  'Shape',
  'MapShapes_2',
  'FindKey',
  'ShapeType',
  'VolumeProperties_1',
  'Mass',
  'IsValid_2',
] as const;

function injectException(
  oc: OpenCascadeInstance,
  point: (typeof EXCEPTION_POINTS)[number],
  failure: Error,
): void {
  const fail = (): never => {
    throw failure;
  };
  switch (point) {
    case 'Append_1':
      vi.spyOn(oc.TopTools_ListOfShape.prototype, point).mockImplementation(fail);
      return;
    case 'SetArguments':
    case 'SetNonDestructive':
      vi.spyOn(oc.BRepAlgoAPI_BuilderAlgo.prototype, point).mockImplementation(fail);
      return;
    case 'SetTools':
    case 'Build':
      vi.spyOn(oc.BRepAlgoAPI_BooleanOperation.prototype, point).mockImplementation(fail);
      return;
    case 'HasErrors':
      vi.spyOn(oc.BRepAlgoAPI_Algo.prototype, point).mockImplementation(fail);
      return;
    case 'IsDone':
      vi.spyOn(oc.BRepBuilderAPI_Command.prototype, point).mockImplementation(fail);
      return;
    case 'Shape':
      vi.spyOn(oc.BRepAlgoAPI_Algo.prototype, point).mockImplementation(fail);
      return;
    case 'MapShapes_2':
      vi.spyOn(oc.TopExp, point).mockImplementation(fail);
      return;
    case 'FindKey':
      vi.spyOn(oc.TopTools_IndexedMapOfShape.prototype, point).mockImplementation(fail);
      return;
    case 'ShapeType':
      vi.spyOn(oc.TopoDS_Shape.prototype, point).mockImplementation(fail);
      return;
    case 'VolumeProperties_1':
      vi.spyOn(oc.BRepGProp, point).mockImplementation(fail);
      return;
    case 'Mass':
      vi.spyOn(oc.GProp_GProps.prototype, point).mockImplementation(fail);
      return;
    case 'IsValid_2':
      vi.spyOn(oc.BRepCheck_Analyzer.prototype, point).mockImplementation(fail);
      return;
  }
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

  it('A∪B のあと同じ A で A−C・A∩D を作っても、新しい A と体積・面数・辺数が一致する', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG_BOX));
      const b = keep(makeTranslatedBox(oc, BIG_BOX, HALF_OFFSET));
      const c = keep(makeTranslatedBox(oc, SMALL_BOX, [5, 5, 5]));
      const d = keep(makeTranslatedBox(oc, BIG_BOX, [-10, 0, 0]));
      const before = shapeMetrics(oc, a.shape);
      const cases: readonly { operation: BooleanOperation; tool: TestShapeHandle; volume: number }[] = [
        { operation: 'union', tool: b, volume: HALF_UNION },
        { operation: 'subtract', tool: c, volume: SUBTRACT_CONTAINED },
        { operation: 'intersect', tool: d, volume: BIG_VOLUME / 2 },
      ];
      for (const { operation, tool, volume } of cases) {
        const result = booleanOp(oc, operation, a.shape, tool.shape);
        try {
          const fresh = keep(makeBox(oc, BIG_BOX));
          const reference = keep(booleanOp(oc, operation, fresh.shape, tool.shape));
          expectSameMetrics(shapeMetrics(oc, result.shape), shapeMetrics(oc, reference.shape));
          expect(result.volume).toBeCloseTo(volume, 6);
        } finally {
          result.delete();
        }
        expectSameMetrics(shapeMetrics(oc, a.shape), before);
      }
    } finally {
      release();
    }
  });

  it.each(OPERATIONS)('%s: 空の工具で不成立になっても同じ入力を続く差に使える', (operation) => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG_BOX));
      const empty = keep(new oc.TopoDS_Shape());
      const tool = keep(makeBox(oc, SMALL_BOX));
      expect(() => booleanOp(oc, operation, a.shape, empty)).toThrow(
        '2 つの立体を組み合わせられませんでした。位置や形を見直してください。',
      );
      const result = keep(booleanOp(oc, 'subtract', a.shape, tool.shape));
      const fresh = keep(makeBox(oc, BIG_BOX));
      const reference = keep(booleanOp(oc, 'subtract', fresh.shape, tool.shape));
      expect(result.volume).toBeCloseTo(SUBTRACT_CONTAINED, 6);
      expectSameMetrics(shapeMetrics(oc, result.shape), shapeMetrics(oc, reference.shape));
      expectSameMetrics(shapeMetrics(oc, a.shape), shapeMetrics(oc, fresh.shape));
    } finally {
      release();
    }
  });

  it('何も残らず断った後にも同じ2形状の和を作れる', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG_BOX));
      const far = keep(makeTranslatedBox(oc, SMALL_BOX, FAR_OFFSET));
      expect(() => booleanOp(oc, 'intersect', a.shape, far.shape)).toThrow(
        '組み合わせた結果、立体が残りませんでした。',
      );
      const result = keep(booleanOp(oc, 'union', a.shape, far.shape));
      expect(result.volume).toBeCloseTo(UNION_DISJOINT, 6);
      expect(isValidShape(oc, result.shape)).toBe(true);
    } finally {
      release();
    }
  });

  it.each(OPERATIONS)('%s: Build前に非破壊モードを立て、一時物と結果の所有を解放する', (operation) => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      const { entries, buildModes } = observeAllocations(oc);
      const result = booleanOp(oc, operation, big.shape, small.shape);
      try {
        expect(buildModes).toEqual([true]);
        // 入力リスト・Appendの戻り・走査・測定・検査の一時物は既に解放済み。
        const retained = entries.filter((entry) => entry.deleted === 0);
        expect(retained).toHaveLength(3);
        expect(retained.map((entry) => entry.item)).toEqual([
          expect.any(oc.Message_ProgressRange),
          expect.any(oc.BRepAlgoAPI_BooleanOperation),
          result.shape,
        ]);
      } finally {
        result.delete();
      }
      result.delete();
      expect(entries.length).toBeGreaterThan(7);
      for (const entry of entries) expect(entry.deleted).toBe(1);
    } finally {
      vi.restoreAllMocks();
      small.delete();
      big.delete();
    }
  });

  describe.each(OPERATIONS)('%s の例外時の解放', (operation) => {
    it.each(EXCEPTION_POINTS)('%s が投げても確保数と解放数が一致し、入力を再利用できる', (point) => {
      const big = makeBox(oc, BIG_BOX);
      const small = makeBox(oc, SMALL_BOX);
      try {
        const failure = new Error(`OCCT ${point} の例外`);
        injectException(oc, point, failure);
        const { entries } = observeAllocations(oc);
        expect(() => booleanOp(oc, operation, big.shape, small.shape).delete()).toThrow(failure);
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) expect(entry.deleted).toBe(1);
        const deleted = entries.reduce((sum, entry) => sum + entry.deleted, 0);
        console.log(`${operation}/${point}: 確保${entries.length}・解放${deleted}`);
        vi.restoreAllMocks();
        const next = booleanOp(oc, 'subtract', big.shape, small.shape);
        try {
          expect(next.volume).toBeCloseTo(SUBTRACT_CONTAINED, 6);
          expect(measureVolume(oc, big.shape)).toBeCloseTo(BIG_VOLUME, 6);
          expect(measureVolume(oc, small.shape)).toBeCloseTo(SMALL_VOLUME, 6);
        } finally {
          next.delete();
        }
      } finally {
        vi.restoreAllMocks();
        small.delete();
        big.delete();
      }
    });
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
