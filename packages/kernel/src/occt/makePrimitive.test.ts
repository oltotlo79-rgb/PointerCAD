import { beforeAll, describe, expect, it } from 'vitest';

import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type {
  PrimitiveShapeSpec,
  PrimitiveStepSpec,
  SolidVertexInfo,
  SubShapeQuery,
  Vec3Tuple,
} from '../types.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import {
  boxCornerOrigin,
  makePrimitive,
  offsetFromVertex,
  resolvePrimitiveOrigin,
  MISSING_PRIMITIVE_VERTEX_MESSAGE,
  PRIMITIVE_ORIGIN_NOT_VERTEX_MESSAGE,
  type AxesFrame,
} from './makePrimitive.js';
import { hasSolid, isValidShape, measureArea, measureVolume } from './solidMesh.js';
import { collectSubShapes, type SubShapeTables } from './subShapes.js';
import { tessellate } from './tessellate.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** 既定は原点・Z 軸で、頂点は参照しない。形だけを差し替えて使う。 */
function primitiveSpec(
  shape: PrimitiveShapeSpec,
  overrides: Partial<Omit<PrimitiveStepSpec, 'shape'>> = {},
): PrimitiveStepSpec {
  return {
    kind: 'primitive',
    origin: [0, 0, 0],
    axis: [0, 0, 1],
    shape,
    originQuery: null,
    targetKey: null,
    ...overrides,
  };
}

/**
 * 境界箱(mm)。`Bnd_Box.Get` は参照渡しで JS から値を受け取れないので
 * `CornerMin()` / `CornerMax()` を使う(subShapes.ts の boundingDiagonal と同じ)。
 * 第 3 引数 false は「三角形分割を使わず厳密な面から測る」指定、`SetGap(0)` は
 * 形の許容誤差ぶんの膨らみ(既定 1e-7)を取り除く指定。
 */
function boundingBox(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
): { readonly min: Vec3Tuple; readonly max: Vec3Tuple } {
  const box = new oc.Bnd_Box_1();
  try {
    oc.BRepBndLib.Add(shape, box, false);
    box.SetGap(0);
    const low = box.CornerMin();
    const high = box.CornerMax();
    try {
      return {
        min: [low.X(), low.Y(), low.Z()],
        max: [high.X(), high.Y(), high.Z()],
      };
    } finally {
      high.delete();
      low.delete();
    }
  } finally {
    box.delete();
  }
}

/**
 * 面・辺・頂点の数。solidMesh.ts の hasSolid と同じく `TopExp.MapShapes_2` +
 * `ShapeType()` の値どうしの比較で数える(列挙は引数に渡せないため)。
 */
function countSubShapes(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
): { readonly faces: number; readonly edges: number; readonly vertices: number } {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_2(shape, map, true, true);
    const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
    const edgeType = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
    const vertexType = oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
    let faces = 0;
    let edges = 0;
    let vertices = 0;
    const total = map.Size();
    for (let position = 1; position <= total; position += 1) {
      const subShape = map.FindKey(position);
      const shapeType = subShape.ShapeType();
      if (shapeType === faceType) {
        faces += 1;
      } else if (shapeType === edgeType) {
        edges += 1;
      } else if (shapeType === vertexType) {
        vertices += 1;
      }
      subShape.delete();
    }
    return { faces, edges, vertices };
  } finally {
    map.delete();
  }
}

/** 点が期待どおりか(距離で見る。既定の許容は 1e-6 mm)。 */
function expectPointNear(actual: Vec3Tuple, expected: Vec3Tuple, tolerance = 1e-6): void {
  const distance = Math.hypot(
    actual[0] - expected[0],
    actual[1] - expected[1],
    actual[2] - expected[2],
  );
  expect(distance).toBeLessThan(tolerance);
}

describe('基本形状 5 種(FR-429、計画書 §2.7、タスク13)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  // 手順 1(§1.5-1): 型定義に載っていても実行時にあるとは限らないので、
  // 使うクラスがすべて束縛されていることを確かめる(loadOcct.node.test.ts と同じ書き方)。
  it('使う 5 種の maker と gp_Ax2 が実行時に束縛されている(§1.5-1)', () => {
    expect(oc.BRepPrimAPI_MakeSphere_9).toBeTypeOf('function');
    expect(oc.BRepPrimAPI_MakeBox_5).toBeTypeOf('function');
    expect(oc.BRepPrimAPI_MakeCylinder_3).toBeTypeOf('function');
    expect(oc.BRepPrimAPI_MakeCone_3).toBeTypeOf('function');
    expect(oc.BRepPrimAPI_MakeTorus_5).toBeTypeOf('function');
    expect(oc.gp_Ax2_3).toBeTypeOf('function');
    expect(oc.gp_Pnt_3).toBeTypeOf('function');
    expect(oc.gp_Dir_4).toBeTypeOf('function');
  });

  // §2.7.3 の検算表。導出は表のとおり(球 4/3·πr³、円柱 πr²h、円錐 πh(R²+Rr+r²)/3、
  // トーラス 2π²Rr²)。値は担当が電卓ではなく式から導いてある。
  const VOLUME_CASES: readonly {
    readonly label: string;
    readonly shape: PrimitiveShapeSpec;
    readonly expected: number;
  }[] = [
    { label: '球 r=10', shape: { kind: 'sphere', radius: 10 }, expected: 4188.790204786391 },
    {
      label: '箱 10×20×30',
      shape: { kind: 'box', sizeX: 10, sizeY: 20, sizeZ: 30 },
      expected: 6000,
    },
    {
      label: '箱 40×30×10',
      shape: { kind: 'box', sizeX: 40, sizeY: 30, sizeZ: 10 },
      expected: 12000,
    },
    {
      label: '円柱 r=10 h=20',
      shape: { kind: 'cylinder', radius: 10, height: 20 },
      expected: 6283.185307179587,
    },
    {
      label: '円錐 R=10 r=0 h=20(尖り)',
      shape: { kind: 'cone', bottomRadius: 10, topRadius: 0, height: 20 },
      expected: 2094.3951023931954,
    },
    {
      label: '円錐台 R=10 r=5 h=20',
      shape: { kind: 'cone', bottomRadius: 10, topRadius: 5, height: 20 },
      expected: 3665.191429188092,
    },
    {
      label: '円錐台 R=10 r=5 h=12',
      shape: { kind: 'cone', bottomRadius: 10, topRadius: 5, height: 12 },
      expected: 2199.114857512855,
    },
    {
      label: 'トーラス R=20 r=5',
      shape: { kind: 'torus', majorRadius: 20, minorRadius: 5 },
      expected: 9869.604401089358,
    },
  ];

  for (const testCase of VOLUME_CASES) {
    it(`${testCase.label} の体積が計算値と 1e-6 以内で一致し、妥当な立体になる`, () => {
      const handle = makePrimitive(oc, primitiveSpec(testCase.shape));
      try {
        const volume = measureVolume(oc, handle.shape);
        console.log(`${testCase.label}: 体積 実測 ${volume.toFixed(9)} / 計算 ${testCase.expected}`);
        expect(Math.abs(volume - testCase.expected)).toBeLessThan(1e-6);
        expect(hasSolid(oc, handle.shape)).toBe(true);
        expect(isValidShape(oc, handle.shape)).toBe(true);
      } finally {
        handle.delete();
      }
    });
  }

  // 表面積(§2.7.3)。球 4πr²、箱 2(ab+bc+ca)、円柱 2πr²+2πrh、トーラス 4π²Rr。
  const AREA_CASES: readonly {
    readonly label: string;
    readonly shape: PrimitiveShapeSpec;
    readonly expected: number;
  }[] = [
    { label: '球 r=10', shape: { kind: 'sphere', radius: 10 }, expected: 1256.6370614359173 },
    { label: '箱 10×20×30', shape: { kind: 'box', sizeX: 10, sizeY: 20, sizeZ: 30 }, expected: 2200 },
    {
      label: '円柱 r=10 h=20',
      shape: { kind: 'cylinder', radius: 10, height: 20 },
      expected: 1884.9555921538758,
    },
    {
      label: 'トーラス R=20 r=5',
      shape: { kind: 'torus', majorRadius: 20, minorRadius: 5 },
      expected: 3947.8417604357433,
    },
  ];

  for (const testCase of AREA_CASES) {
    it(`${testCase.label} の表面積が計算値と 1e-6 以内で一致する`, () => {
      const handle = makePrimitive(oc, primitiveSpec(testCase.shape));
      try {
        const area = measureArea(oc, handle.shape);
        console.log(`${testCase.label}: 表面積 実測 ${area.toFixed(9)} / 計算 ${testCase.expected}`);
        expect(Math.abs(area - testCase.expected)).toBeLessThan(1e-6);
      } finally {
        handle.delete();
      }
    });
  }

  // §1.5-15 の実測。数はここに書いた値がそのまま実測値(合わなければ検査が落ちる)。
  const COUNT_CASES: readonly {
    readonly label: string;
    readonly shape: PrimitiveShapeSpec;
    readonly faces: number;
    readonly edges: number;
    readonly vertices: number;
  }[] = [
    { label: '球 r=10', shape: { kind: 'sphere', radius: 10 }, faces: 1, edges: 3, vertices: 2 },
    {
      label: '箱 20³',
      shape: { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 },
      faces: 6,
      edges: 12,
      vertices: 8,
    },
    {
      label: '円柱 r=10 h=20',
      shape: { kind: 'cylinder', radius: 10, height: 20 },
      faces: 3,
      edges: 3,
      vertices: 2,
    },
    {
      label: '円錐台 R=10 r=5 h=20',
      shape: { kind: 'cone', bottomRadius: 10, topRadius: 5, height: 20 },
      faces: 3,
      edges: 3,
      vertices: 2,
    },
    {
      label: '円錐 R=10 r=0 h=20(尖り)',
      shape: { kind: 'cone', bottomRadius: 10, topRadius: 0, height: 20 },
      faces: 2,
      edges: 3,
      vertices: 2,
    },
    {
      label: 'トーラス R=20 r=5',
      shape: { kind: 'torus', majorRadius: 20, minorRadius: 5 },
      faces: 1,
      edges: 2,
      vertices: 1,
    },
  ];

  for (const testCase of COUNT_CASES) {
    it(`${testCase.label} の面・辺・頂点の数が ${testCase.faces} / ${testCase.edges} / ${testCase.vertices} になる`, () => {
      const handle = makePrimitive(oc, primitiveSpec(testCase.shape));
      try {
        const counts = countSubShapes(oc, handle.shape);
        console.log(
          `${testCase.label}: 面 ${counts.faces} / 辺 ${counts.edges} / 頂点 ${counts.vertices}`,
        );
        expect(counts.faces).toBe(testCase.faces);
        expect(counts.edges).toBe(testCase.edges);
        expect(counts.vertices).toBe(testCase.vertices);
      } finally {
        handle.delete();
      }
    });
  }

  it('箱 20³ の中心が指定した位置になる(§0.a-0.17。角ではない)', () => {
    const handle = makePrimitive(
      oc,
      primitiveSpec({ kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 }),
    );
    try {
      const box = boundingBox(oc, handle.shape);
      expectPointNear(box.min, [-10, -10, -10]);
      expectPointNear(box.max, [10, 10, 10]);
    } finally {
      handle.delete();
    }
  });

  it('軸を X にした箱 20³ でも中心は変わらない(中心指定は軸に依らない)', () => {
    const handle = makePrimitive(
      oc,
      primitiveSpec({ kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 }, { axis: [1, 0, 0] }),
    );
    try {
      const box = boundingBox(oc, handle.shape);
      expectPointNear(box.min, [-10, -10, -10]);
      expectPointNear(box.max, [10, 10, 10]);
    } finally {
      handle.delete();
    }
  });

  it('中心 [5,5,5] の球 r=10 の境界箱が [-5,-5,-5]〜[15,15,15] になる', () => {
    const handle = makePrimitive(
      oc,
      primitiveSpec({ kind: 'sphere', radius: 10 }, { origin: [5, 5, 5] }),
    );
    try {
      const box = boundingBox(oc, handle.shape);
      expectPointNear(box.min, [-5, -5, -5]);
      expectPointNear(box.max, [15, 15, 15]);
    } finally {
      handle.delete();
    }
  });

  it('円柱 r=10 h=20(軸 Z)は底面の中心が原点になる(§0.a-0.17)', () => {
    const handle = makePrimitive(oc, primitiveSpec({ kind: 'cylinder', radius: 10, height: 20 }));
    try {
      const box = boundingBox(oc, handle.shape);
      expectPointNear(box.min, [-10, -10, 0]);
      expectPointNear(box.max, [10, 10, 20]);
    } finally {
      handle.delete();
    }
  });

  it('軸を X にした円柱 r=10 h=20 は +X 方向へ伸びる', () => {
    const handle = makePrimitive(
      oc,
      primitiveSpec({ kind: 'cylinder', radius: 10, height: 20 }, { axis: [1, 0, 0] }),
    );
    try {
      const box = boundingBox(oc, handle.shape);
      expectPointNear(box.min, [0, -10, -10]);
      expectPointNear(box.max, [20, 10, 10]);
    } finally {
      handle.delete();
    }
  });

  it('円錐 R=10 h=20(軸 Z)も底面の中心が原点で、上へ尖る', () => {
    const handle = makePrimitive(
      oc,
      primitiveSpec({ kind: 'cone', bottomRadius: 10, topRadius: 0, height: 20 }),
    );
    try {
      const box = boundingBox(oc, handle.shape);
      expectPointNear(box.min, [-10, -10, 0]);
      expectPointNear(box.max, [10, 10, 20]);
    } finally {
      handle.delete();
    }
  });

  it('トーラス R=20 r=5 は中心が原点にあり、境界箱が ±25 × ±25 × ±5 を含む', () => {
    const handle = makePrimitive(
      oc,
      primitiveSpec({ kind: 'torus', majorRadius: 20, minorRadius: 5 }),
    );
    try {
      const box = boundingBox(oc, handle.shape);
      console.log(
        `トーラス R=20 r=5 の境界箱: [${box.min.map((v) => v.toFixed(6)).join(', ')}]〜[${box.max
          .map((v) => v.toFixed(6))
          .join(', ')}]`,
      );
      // OCCT の境界箱はトーラス面では厳密値(±25 × ±25 × ±5)より大きめに出る
      // (2026-09-05 実測: X・Y が ±27.0598)。面を近似した制御点から箱を求めるためで、
      // 形そのものは正しい(体積・表面積は計算値と 1e-6 以内で一致している)。
      // そこで「原点対称であること」と「厳密な箱を含むこと」で位置を確かめる。
      for (const axis of [0, 1, 2]) {
        expect(box.min[axis] + box.max[axis]).toBeCloseTo(0, 9);
      }
      expect(box.min[0]).toBeLessThanOrEqual(-25);
      expect(box.min[1]).toBeLessThanOrEqual(-25);
      expect(box.min[2]).toBeLessThanOrEqual(-5);
      expect(box.max[0]).toBeGreaterThanOrEqual(25);
      expect(box.max[1]).toBeGreaterThanOrEqual(25);
      expect(box.max[2]).toBeGreaterThanOrEqual(5);
    } finally {
      handle.delete();
    }
  });

  it('中心 [5,0,0] のトーラスは境界箱も同じだけずれる(中心指定)', () => {
    const centred = makePrimitive(
      oc,
      primitiveSpec({ kind: 'torus', majorRadius: 20, minorRadius: 5 }),
    );
    const moved = makePrimitive(
      oc,
      primitiveSpec({ kind: 'torus', majorRadius: 20, minorRadius: 5 }, { origin: [5, 0, 0] }),
    );
    try {
      const before = boundingBox(oc, centred.shape);
      const after = boundingBox(oc, moved.shape);
      expect(after.min[0] - before.min[0]).toBeCloseTo(5, 9);
      expect(after.max[0] - before.max[0]).toBeCloseTo(5, 9);
      expect(after.min[1]).toBeCloseTo(before.min[1], 9);
      expect(after.min[2]).toBeCloseTo(before.min[2], 9);
    } finally {
      moved.delete();
      centred.delete();
    }
  });

  it('軸の長さが 1 でなくても、長さ 1 へ揃えてから使う(軸 [0,0,7] は [0,0,1] と同じ)', () => {
    const scaled = makePrimitive(
      oc,
      primitiveSpec({ kind: 'cylinder', radius: 10, height: 20 }, { axis: [0, 0, 7] }),
    );
    try {
      const box = boundingBox(oc, scaled.shape);
      expectPointNear(box.min, [-10, -10, 0]);
      expectPointNear(box.max, [10, 10, 20]);
    } finally {
      scaled.delete();
    }
  });

  it('上下の半径がごく近い(10 と 9.999)円錐は作れる', () => {
    const handle = makePrimitive(
      oc,
      primitiveSpec({ kind: 'cone', bottomRadius: 10, topRadius: 9.999, height: 20 }),
    );
    try {
      // V = πh(R² + Rr + r²)/3 = π·20·(100 + 99.99 + 99.980001)/3
      const expected = (Math.PI * 20 * (100 + 99.99 + 99.980001)) / 3;
      expect(Math.abs(measureVolume(oc, handle.shape) - expected)).toBeLessThan(1e-6);
      expect(hasSolid(oc, handle.shape)).toBe(true);
      expect(isValidShape(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('同じ依頼を 2 回作ると体積が完全に一致する(決定性、NFR-RE-2)', () => {
    const first = makePrimitive(oc, primitiveSpec({ kind: 'torus', majorRadius: 20, minorRadius: 5 }));
    const second = makePrimitive(
      oc,
      primitiveSpec({ kind: 'torus', majorRadius: 20, minorRadius: 5 }),
    );
    try {
      expect(measureVolume(oc, first.shape)).toBe(measureVolume(oc, second.shape));
    } finally {
      second.delete();
      first.delete();
    }
  });

  it('5 種それぞれ 1 個の所要が 500ms 未満(NFR-PF-2)', () => {
    const cases: readonly { readonly label: string; readonly shape: PrimitiveShapeSpec }[] = [
      { label: '球 r=10', shape: { kind: 'sphere', radius: 10 } },
      { label: '箱 20³', shape: { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 } },
      { label: '円柱 r=10 h=20', shape: { kind: 'cylinder', radius: 10, height: 20 } },
      { label: '円錐 R=10 r=0 h=20', shape: { kind: 'cone', bottomRadius: 10, topRadius: 0, height: 20 } },
      { label: 'トーラス R=20 r=5', shape: { kind: 'torus', majorRadius: 20, minorRadius: 5 } },
    ];
    for (const testCase of cases) {
      const started = performance.now();
      const handle = makePrimitive(oc, primitiveSpec(testCase.shape));
      const elapsedMs = performance.now() - started;
      handle.delete();
      console.log(`${testCase.label} の所要: ${elapsedMs.toFixed(1)} ms / 上限 500 ms`);
      expect(elapsedMs).toBeLessThan(500);
    }
  });

  describe('断り方(FR-504。すべて日本語の Error)', () => {
    it('半径 0 の球を断る', () => {
      expect(() => makePrimitive(oc, primitiveSpec({ kind: 'sphere', radius: 0 }))).toThrow(
        '半径は 0 より大きい数にしてください。',
      );
    });

    it('半径が負の球を断る', () => {
      expect(() => makePrimitive(oc, primitiveSpec({ kind: 'sphere', radius: -1 }))).toThrow(
        '半径は 0 より大きい数にしてください。',
      );
    });

    it('半径が非数の球を断る', () => {
      expect(() => makePrimitive(oc, primitiveSpec({ kind: 'sphere', radius: Number.NaN }))).toThrow(
        '半径は 0 より大きい数にしてください。',
      );
    });

    it('X の長さが 0 の箱を、欄の名前を添えて断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'box', sizeX: 0, sizeY: 20, sizeZ: 20 })),
      ).toThrow('X の長さは 0 より大きい数にしてください。');
    });

    it('Y の長さが 0 の箱を、欄の名前を添えて断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'box', sizeX: 20, sizeY: 0, sizeZ: 20 })),
      ).toThrow('Y の長さは 0 より大きい数にしてください。');
    });

    it('Z の長さが 0 の箱を、欄の名前を添えて断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 0 })),
      ).toThrow('Z の長さは 0 より大きい数にしてください。');
    });

    it('高さ 0 の円柱を断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'cylinder', radius: 10, height: 0 })),
      ).toThrow('高さは 0 より大きい数にしてください。');
    });

    it('半径 0 の円柱を断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'cylinder', radius: 0, height: 20 })),
      ).toThrow('半径は 0 より大きい数にしてください。');
    });

    it('高さ 0 の円錐を断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'cone', bottomRadius: 10, topRadius: 0, height: 0 })),
      ).toThrow('高さは 0 より大きい数にしてください。');
    });

    it('半径が負の円錐を断る', () => {
      expect(() =>
        makePrimitive(
          oc,
          primitiveSpec({ kind: 'cone', bottomRadius: -1, topRadius: 5, height: 20 }),
        ),
      ).toThrow('円錐の半径は 0 以上にしてください。');
    });

    it('上半径が非数の円錐を断る', () => {
      expect(() =>
        makePrimitive(
          oc,
          primitiveSpec({ kind: 'cone', bottomRadius: 10, topRadius: Number.NaN, height: 20 }),
        ),
      ).toThrow('円錐の半径は 0 以上にしてください。');
    });

    it('上下の半径が同じ円錐を、円柱を使うよう促して断る(OCCT が作れないため)', () => {
      expect(() =>
        makePrimitive(
          oc,
          primitiveSpec({ kind: 'cone', bottomRadius: 10, topRadius: 10, height: 20 }),
        ),
      ).toThrow('円錐の上下の半径が同じです。円柱を使ってください。');
    });

    it('両方の半径が 0 の円錐を断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'cone', bottomRadius: 0, topRadius: 0, height: 20 })),
      ).toThrow('円錐の半径は、どちらか一方を 0 より大きくしてください。');
    });

    it('主半径 0 のトーラスを断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'torus', majorRadius: 0, minorRadius: 5 })),
      ).toThrow('主半径は 0 より大きい数にしてください。');
    });

    it('管の半径 0 のトーラスを断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'torus', majorRadius: 20, minorRadius: 0 })),
      ).toThrow('管の半径は 0 より大きい数にしてください。');
    });

    it('管の半径が主半径と同じトーラス(自己交差)を断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'torus', majorRadius: 20, minorRadius: 20 })),
      ).toThrow('トーラスの管の半径は、中心までの半径より小さくしてください。');
    });

    it('管の半径が主半径より大きいトーラスを断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'torus', majorRadius: 5, minorRadius: 20 })),
      ).toThrow('トーラスの管の半径は、中心までの半径より小さくしてください。');
    });

    it('中心が非数だと断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'sphere', radius: 10 }, { origin: [Number.NaN, 0, 0] })),
      ).toThrow('位置または向きの値が正しくありません。');
    });

    it('向きが非数だと断る', () => {
      expect(() =>
        makePrimitive(
          oc,
          primitiveSpec({ kind: 'sphere', radius: 10 }, { axis: [0, 0, Number.POSITIVE_INFINITY] }),
        ),
      ).toThrow('位置または向きの値が正しくありません。');
    });

    it('向きの長さが 0 だと断る', () => {
      expect(() =>
        makePrimitive(oc, primitiveSpec({ kind: 'sphere', radius: 10 }, { axis: [0, 0, 0] })),
      ).toThrow('向きの長さが 0 です。別の向きを選んでください。');
    });
  });

  describe('boxCornerOrigin(純関数。§0.a-0.17)', () => {
    const worldFrame: AxesFrame = {
      xDirection: [1, 0, 0],
      yDirection: [0, 1, 0],
      zDirection: [0, 0, 1],
    };

    it('世界座標の枠では 3 方向へ半分ずつ戻った点になる', () => {
      expect(boxCornerOrigin([0, 0, 0], worldFrame, 10, 20, 30)).toEqual([-5, -10, -15]);
    });

    it('中心をずらすと角も同じだけずれる', () => {
      expect(boxCornerOrigin([5, 5, 5], worldFrame, 10, 20, 30)).toEqual([0, -5, -10]);
    });

    it('枠が回っていても、角は枠の 3 方向へ半分ずつ戻った点になる', () => {
      // Z 軸まわりに 90°回した枠(X→+Y、Y→−X)。
      const rotated: AxesFrame = {
        xDirection: [0, 1, 0],
        yDirection: [-1, 0, 0],
        zDirection: [0, 0, 1],
      };
      expect(boxCornerOrigin([0, 0, 0], rotated, 10, 20, 30)).toEqual([10, -5, -15]);
    });
  });

  /*
   * 基準点を「立体の頂点」にする追補(FR-429、§0.a-0.18、タスク14b)。
   * 頂点の指紋は実際に箱を作って読み取る(手で番号や座標をでっち上げない。
   * makeHole.test.ts / recomputeSolids.test.ts と同じ考え方)。
   */
  describe('基準点を立体の頂点にする(FR-429、§0.a-0.18、タスク14b)', () => {
    /** 中心が原点の箱 20³ を作り、その形と面・辺・頂点の一覧を渡す。 */
    function withCenteredBox(run: (shape: TopoDS_Shape, tables: SubShapeTables) => void): void {
      const handle = makePrimitive(
        oc,
        primitiveSpec({ kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 }),
      );
      try {
        const mesh = tessellate(oc, handle.shape);
        const lines = extractEdges(oc, handle.shape);
        run(handle.shape, collectSubShapes(oc, handle.shape, mesh.faceRanges, lines.edgeRanges));
      } finally {
        handle.delete();
      }
    }

    /** 一覧の中から、その座標にある頂点を 1 つ選ぶ。 */
    function vertexAtPoint(vertices: readonly SolidVertexInfo[], point: Vec3Tuple): SolidVertexInfo {
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

    function vertexQuery(info: SolidVertexInfo): Extract<SubShapeQuery, { kind: 'vertex' }> {
      return { kind: 'vertex', index: info.index, position: info.position };
    }

    it('offsetFromVertex は頂点の座標にオフセットを足す(純関数)', () => {
      expect(offsetFromVertex([10, 10, 10], [0, 0, 0])).toEqual([10, 10, 10]);
      expect(offsetFromVertex([10, 10, 10], [0, 0, 5])).toEqual([10, 10, 15]);
      expect(offsetFromVertex([-3, 4, -5], [3, -4, 5])).toEqual([0, 0, 0]);
    });

    it('箱 20³ の頂点 [10,10,10] の指紋から、その頂点の座標が引ける', () => {
      withCenteredBox((shape, tables) => {
        const corner = vertexAtPoint(tables.vertices, [10, 10, 10]);
        console.log(
          `箱 20³ の頂点は ${tables.vertices.length} 個。[10,10,10] は通し番号 ${corner.index}`,
        );
        const origin = resolvePrimitiveOrigin(
          oc,
          vertexQuery(corner),
          [0, 0, 0],
          shape,
          tables.vertices,
        );
        expectPointNear(origin, [10, 10, 10]);
      });
    });

    it('オフセットを足すと、頂点からその分だけ動いた点になる', () => {
      withCenteredBox((shape, tables) => {
        const corner = vertexAtPoint(tables.vertices, [10, 10, 10]);
        const origin = resolvePrimitiveOrigin(
          oc,
          vertexQuery(corner),
          [0, 0, 5],
          shape,
          tables.vertices,
        );
        expectPointNear(origin, [10, 10, 15]);
      });
    });

    it('番号も位置も外れた頂点の指紋は、選び直しを促して断る(FR-504)', () => {
      withCenteredBox((shape, tables) => {
        expect(() =>
          resolvePrimitiveOrigin(
            oc,
            { kind: 'vertex', index: 99, position: [1000, 1000, 1000] },
            [0, 0, 0],
            shape,
            tables.vertices,
          ),
        ).toThrow(MISSING_PRIMITIVE_VERTEX_MESSAGE);
      });
    });

    it('面の指紋を基準点にしようとすると、頂点を選ぶよう促して断る', () => {
      withCenteredBox((shape, tables) => {
        const face = tables.faces[0];
        expect(() =>
          resolvePrimitiveOrigin(
            oc,
            {
              kind: 'face',
              index: face.index,
              surfaceKind: face.surfaceKind,
              area: face.area,
              position: face.centroid,
              axis: face.axis,
              radius: face.radius,
            },
            [0, 0, 0],
            shape,
            tables.vertices,
          ),
        ).toThrow(PRIMITIVE_ORIGIN_NOT_VERTEX_MESSAGE);
      });
    });
  });
});
