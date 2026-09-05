import { beforeAll, describe, expect, it } from 'vitest';

import type { TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSweep, type SweepInput } from './makeSweep.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

const FULL_TURN = 2 * Math.PI;

/** 全周の円 1 本でできた断面。既定は XY 平面(法線 Z)。 */
function circleProfile(
  radius: number,
  centre: Vec3Tuple = [0, 0, 0],
  normal: Vec3Tuple = [0, 0, 1],
  xAxis: Vec3Tuple = [1, 0, 0],
): readonly CurveSpec[] {
  return [
    {
      kind: 'arc',
      center: centre,
      normal,
      xAxis,
      radius,
      startAngle: 0,
      endAngle: FULL_TURN,
    },
  ];
}

/** 幅 width・高さ height の長方形(XY 平面、原点が中心)。 */
function rectangleProfile(width: number, height: number): readonly CurveSpec[] {
  const x = width / 2;
  const y = height / 2;
  const corners: readonly Vec3Tuple[] = [
    [-x, -y, 0],
    [x, -y, 0],
    [x, y, 0],
    [-x, y, 0],
  ];
  return corners.map((from, index) => ({
    kind: 'segment',
    from,
    to: corners[(index + 1) % corners.length],
  }));
}

function segment(from: Vec3Tuple, to: Vec3Tuple): CurveSpec {
  return { kind: 'segment', from, to };
}

/** XY 平面上の円弧(中心は原点)。角度はラジアン。 */
function arcPath(radius: number, startAngle: number, endAngle: number): readonly CurveSpec[] {
  return [
    {
      kind: 'arc',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius,
      startAngle,
      endAngle,
    },
  ];
}

function sweepInput(overrides: Partial<SweepInput> = {}): SweepInput {
  return {
    profile: circleProfile(2),
    path: [segment([0, 0, 0], [0, 0, 50])],
    frenet: true,
    ...overrides,
  };
}

/** 相対誤差での突き合わせ(計画書 タスク37 の許容: 相対 0.5% 以内)。 */
function expectVolumeNear(actual: number, expected: number, tolerance = 0.005): void {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(tolerance);
}

describe('スイープ(経路に沿った押し出し、FR-409、計画書 P5 タスク37)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** 面の枚数。三角形分割が要らないので直に数える(`makeThruSections.test.ts` と同じ書き方)。 */
  function faceCount(shape: TopoDS_Shape): number {
    const map = new oc.TopTools_IndexedMapOfShape_1();
    try {
      oc.TopExp.MapShapes_2(shape, map, true, true);
      let count = 0;
      const size = Number(map.Size());
      for (let index = 1; index <= size; index += 1) {
        if (map.FindKey(index).ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) {
          count += 1;
        }
      }
      return count;
    } finally {
      map.delete();
    }
  }

  it('使う道具が実行時にそろっている(§4「型定義に載っていても実行時にあるとは限らない」)', () => {
    expect(oc.BRepOffsetAPI_MakePipeShell).toBeTypeOf('function');
    expect(oc.BRepAdaptor_CompCurve_2).toBeTypeOf('function');
    expect(oc.BRepAdaptor_Surface_2).toBeTypeOf('function');
    // 静的メソッドは呼ばずに参照すると @typescript-eslint/unbound-method が働くため、
    // 同じ判定を typeof で書く(loadOcct.node.test.ts と同じ書き方)。
    expect(typeof oc.BRepGProp.SurfaceProperties_1).toBe('function');
    expect(typeof oc.BRepGProp.LinearProperties).toBe('function');
    expect(oc.gp_Pnt_1).toBeTypeOf('function');
    expect(oc.gp_Vec_1).toBeTypeOf('function');
  });

  // 検証表(計画書 タスク37)+ 統括の指示で足した φ10 の 2 行。
  // 導出はどれもパップスの定理「断面の面積 × 重心が進む距離」で、重心が経路に乗る
  // 置き方(makeSweep.ts 冒頭)からそのまま出る。
  const VOLUME_CASES: readonly {
    readonly label: string;
    readonly input: SweepInput;
    readonly expectedVolume: number;
    readonly derivation: string;
  }[] = [
    {
      label: '円 r=2 を長さ 50 の直線に沿って',
      input: sweepInput(),
      expectedVolume: 628.3185307179587,
      derivation: 'π·2²·50',
    },
    {
      label: '20×10 の長方形を長さ 30 の直線に沿って',
      input: sweepInput({
        profile: rectangleProfile(20, 10),
        path: [segment([0, 0, 0], [0, 0, 30])],
      }),
      expectedVolume: 6000,
      derivation: '200×30',
    },
    {
      label: '円 r=2 を半径 20 の 1/4 円弧に沿って',
      input: sweepInput({ path: arcPath(20, 0, Math.PI / 2) }),
      expectedVolume: 394.7841760435743,
      derivation: 'π·2²·(2π·20/4) = 2π²·20·2²/4(トーラスの 1/4)',
    },
    {
      label: '円 r=5(φ10)を長さ 50 の直線に沿って',
      input: sweepInput({ profile: circleProfile(5) }),
      expectedVolume: 3926.9908169872415,
      derivation: 'π·5²·50',
    },
    {
      label: '円 r=5(φ10)を半径 20 の 1/4 円弧に沿って',
      input: sweepInput({ profile: circleProfile(5), path: arcPath(20, 0, Math.PI / 2) }),
      expectedVolume: 2467.4011002723396,
      derivation: '2π²·20·5²/4(トーラスの 1/4)',
    },
  ];

  for (const testCase of VOLUME_CASES) {
    it(`${testCase.label} の体積が計算値に相対 0.5% 以内で一致する`, () => {
      const handle = makeSweep(oc, testCase.input);
      try {
        const volume = measureVolume(oc, handle.shape);
        console.log(
          `${testCase.label}: 実測 ${volume.toFixed(6)}mm³ / 計算値 ${testCase.expectedVolume}mm³ ` +
            `(${testCase.derivation}、相対 ${(
              (Math.abs(volume - testCase.expectedVolume) / testCase.expectedVolume) *
              100
            ).toFixed(4)}%)`,
        );
        expectVolumeNear(volume, testCase.expectedVolume);
        expect(hasSolid(oc, handle.shape)).toBe(true);
        expect(isValidShape(oc, handle.shape)).toBe(true);
      } finally {
        handle.delete();
      }
    });
  }

  it('円 r=2 を長さ 50 の直線に沿わせると、面が 3 枚になる(側面 1 + 両端 2)', () => {
    const handle = makeSweep(oc, sweepInput());
    try {
      const faces = faceCount(handle.shape);
      console.log(`円 r=2 / 直線 50 の面の数: ${faces} 枚`);
      expect(faces).toBe(3);
    } finally {
      handle.delete();
    }
  });

  it('断面が経路から離れた場所にあっても、経路の始点へ移されて同じ体積になる', () => {
    // 断面を (100, 50, 7) へ置き、向きも Y 法線にずらす。makeSweep が重心を経路の始点へ
    // 重ね、法線を接線へ向け直すので、原点に置いたときと同じ立体になる(冒頭の注釈)。
    const moved = makeSweep(
      oc,
      sweepInput({ profile: circleProfile(2, [100, 50, 7], [0, 1, 0], [1, 0, 0]) }),
    );
    const origin = makeSweep(oc, sweepInput());
    try {
      expectVolumeNear(measureVolume(oc, moved.shape), measureVolume(oc, origin.shape), 1e-9);
    } finally {
      moved.delete();
      origin.delete();
    }
  });

  // 丸めていない角のある経路(留め継ぎ、makeSweep.ts 冒頭の注釈 (a))。
  // 留め継ぎは角の外側のとがりを 45 度で切り落として反対側へ足すので、体積は
  // 曲がる角度によらず π·r²·(L₁+L₂) になる。OCCT の既定(Transformed)では
  // 1 本目だけの 376.991118 になってしまうことを実測で確かめてある。
  const CORNER_CASES: readonly {
    readonly label: string;
    readonly to: Vec3Tuple;
    readonly secondLength: number;
  }[] = [
    { label: '直角(30 + 20)', to: [30, 20, 0], secondLength: 20 },
    { label: '直角(30 + 40)', to: [30, 40, 0], secondLength: 40 },
    {
      label: '135 度に折れる(30 + 20)',
      to: [30 - 20 * Math.SQRT1_2, 20 * Math.SQRT1_2, 0],
      secondLength: 20,
    },
  ];

  for (const testCase of CORNER_CASES) {
    it(`丸めていない角のある経路 ${testCase.label} を留め継ぎでつなぐ`, () => {
      const handle = makeSweep(
        oc,
        sweepInput({
          path: [segment([0, 0, 0], [30, 0, 0]), segment([30, 0, 0], testCase.to)],
        }),
      );
      try {
        const volume = measureVolume(oc, handle.shape);
        const expected = Math.PI * 4 * (30 + testCase.secondLength);
        console.log(
          `留め継ぎ ${testCase.label}: 実測 ${volume.toFixed(6)}mm³ / 計算値 ${expected.toFixed(6)}mm³ ` +
            `(π·2²·(30+${testCase.secondLength})、相対 ${(
              (Math.abs(volume - expected) / expected) *
              100
            ).toFixed(4)}%、面 ${faceCount(handle.shape)} 枚)`,
        );
        expectVolumeNear(volume, expected);
        expect(hasSolid(oc, handle.shape)).toBe(true);
        expect(isValidShape(oc, handle.shape)).toBe(true);
      } finally {
        handle.delete();
      }
    });
  }

  it('留め継ぎでもつなげないほど鋭い角(174 度の折り返し)は、角を丸める案内を添えて断る', () => {
    expect(() =>
      makeSweep(
        oc,
        sweepInput({
          path: [segment([0, 0, 0], [30, 0, 0]), segment([30, 0, 0], [0, 3, 0])],
        }),
      ),
    ).toThrow('道筋の角を丸める');
  });

  it('角を半径 5 で丸めた経路(直線 25 + 1/4 円弧 R5 + 直線 35)なら立体になる', () => {
    const handle = makeSweep(
      oc,
      sweepInput({
        path: [
          segment([0, 0, 0], [25, 0, 0]),
          {
            kind: 'arc',
            center: [25, 5, 0],
            normal: [0, 0, 1],
            xAxis: [0, -1, 0],
            radius: 5,
            startAngle: 0,
            endAngle: Math.PI / 2,
          },
          segment([30, 5, 0], [30, 40, 0]),
        ],
      }),
    );
    try {
      const volume = measureVolume(oc, handle.shape);
      // 経路の長さは 25 + 2π·5/4 + 35 = 67.853981633974480、断面は π·2²。
      const expected = Math.PI * 4 * (25 + (Math.PI * 5) / 2 + 35);
      console.log(
        `丸めた角(R5)の経路: 実測 ${volume.toFixed(6)}mm³ / 計算値 ${expected.toFixed(6)}mm³ ` +
          `(相対 ${((Math.abs(volume - expected) / expected) * 100).toFixed(4)}%)`,
      );
      expectVolumeNear(volume, expected);
      expect(hasSolid(oc, handle.shape)).toBe(true);
      expect(isValidShape(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('経路が閉じている(半径 20 の全周の円)ときはトーラスになる', () => {
    // 計画書 §0.a はこの場合を決めていない。実測で通せることを確かめたうえで通す
    // (makeSweep.ts 冒頭の注釈)。体積は 2π²·R·r² = 2π²·20·2²。
    const handle = makeSweep(oc, sweepInput({ path: arcPath(20, 0, FULL_TURN) }));
    try {
      const volume = measureVolume(oc, handle.shape);
      const expected = 2 * Math.PI * Math.PI * 20 * 4;
      console.log(
        `閉じた経路(半径 20 の円): 実測 ${volume.toFixed(6)}mm³ / 計算値 ${expected.toFixed(6)}mm³`,
      );
      expectVolumeNear(volume, expected);
      expect(hasSolid(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('「ねじれを抑える」(frenet = false)でも、平らな経路なら同じ体積になる', () => {
    // 副法線を上下方向へ固定する指定(SetMode_3)。XY 平面の円弧では Frenet の副法線と
    // 一致するので、同じ立体になる(§0.a-0.43)。
    const twisted = makeSweep(oc, sweepInput({ path: arcPath(20, 0, Math.PI / 2), frenet: false }));
    const frenet = makeSweep(oc, sweepInput({ path: arcPath(20, 0, Math.PI / 2), frenet: true }));
    try {
      expectVolumeNear(measureVolume(oc, twisted.shape), measureVolume(oc, frenet.shape), 1e-6);
      expect(hasSolid(oc, twisted.shape)).toBe(true);
    } finally {
      twisted.delete();
      frenet.delete();
    }
  });

  it('「ねじれを抑える」で経路が上下方向と平行だと、実行する前に断る', () => {
    expect(() => makeSweep(oc, sweepInput({ frenet: false }))).toThrow(
      'ねじれを抑える指定は、道筋が上下方向と平行なときには使えません。',
    );
  });

  it('同じ依頼を 2 回作ると、体積が完全に一致する(決定性)', () => {
    const first = makeSweep(oc, sweepInput({ path: arcPath(20, 0, Math.PI / 2) }));
    const second = makeSweep(oc, sweepInput({ path: arcPath(20, 0, Math.PI / 2) }));
    try {
      expect(measureVolume(oc, first.shape)).toBe(measureVolume(oc, second.shape));
    } finally {
      first.delete();
      second.delete();
    }
  });

  it('1 段の所要が 500ms 未満(NFR-PF-2)', () => {
    for (const testCase of [
      { label: '直線 50mm', input: sweepInput() },
      { label: '1/4 円弧 R20', input: sweepInput({ path: arcPath(20, 0, Math.PI / 2) }) },
      {
        label: '折れ線 25 + R5 の角 + 35',
        input: sweepInput({
          path: [
            segment([0, 0, 0], [25, 0, 0]),
            {
              kind: 'arc',
              center: [25, 5, 0],
              normal: [0, 0, 1],
              xAxis: [0, -1, 0],
              radius: 5,
              startAngle: 0,
              endAngle: Math.PI / 2,
            },
            segment([30, 5, 0], [30, 40, 0]),
          ],
        }),
      },
      { label: '閉じた輪 R20', input: sweepInput({ path: arcPath(20, 0, FULL_TURN) }) },
      {
        label: '留め継ぎの直角 30+20',
        input: sweepInput({
          path: [segment([0, 0, 0], [30, 0, 0]), segment([30, 0, 0], [30, 20, 0])],
        }),
      },
    ]) {
      const started = performance.now();
      const handle = makeSweep(oc, testCase.input);
      const elapsedMs = performance.now() - started;
      handle.delete();
      console.log(`${testCase.label} の所要: ${elapsedMs.toFixed(1)} ms / 上限 500 ms`);
      expect(elapsedMs).toBeLessThan(500);
    }
  });

  it('経路が空だと断る', () => {
    expect(() => makeSweep(oc, sweepInput({ path: [] }))).toThrow(
      '掃引する道筋が選ばれていません。',
    );
  });

  it('断面が空だと断る', () => {
    expect(() => makeSweep(oc, sweepInput({ profile: [] }))).toThrow(
      '掃引する断面が選ばれていません。',
    );
  });

  it('断面が閉じていないと断る', () => {
    const open: readonly CurveSpec[] = [
      segment([0, 0, 0], [10, 0, 0]),
      segment([10, 0, 0], [10, 10, 0]),
    ];
    expect(() => makeSweep(oc, sweepInput({ profile: open }))).toThrow(
      '掃引する断面は閉じている必要があります。',
    );
  });

  it('断面が同じ平面に乗っていないと断る', () => {
    const skew: readonly CurveSpec[] = [
      segment([0, 0, 0], [10, 0, 0]),
      segment([10, 0, 0], [10, 10, 0]),
      segment([10, 10, 0], [10, 10, 5]),
      segment([10, 10, 5], [0, 0, 0]),
    ];
    expect(() => makeSweep(oc, sweepInput({ profile: skew }))).toThrow(
      '掃引する断面が同じ平面に乗っていません。',
    );
  });

  it('断面が自分自身と交わっている(蝶ネクタイ)と断る', () => {
    const bowtie: readonly CurveSpec[] = [
      segment([0, 0, 0], [10, 10, 0]),
      segment([10, 10, 0], [10, 0, 0]),
      segment([10, 0, 0], [0, 10, 0]),
      segment([0, 10, 0], [0, 0, 0]),
    ];
    expect(() => makeSweep(oc, sweepInput({ profile: bowtie }))).toThrow(
      '掃引する断面が自分自身と交わっています。',
    );
  });

  it('経路の線がつながっていないと断る', () => {
    const broken: readonly CurveSpec[] = [
      segment([0, 0, 0], [10, 0, 0]),
      segment([50, 0, 0], [60, 0, 0]),
    ];
    expect(() => makeSweep(oc, sweepInput({ path: broken }))).toThrow('道筋を作れませんでした。');
  });

  it('断面が経路の曲がりに対して大きすぎる(自己交差する)と、作る前に断る', () => {
    // 半径 2 の 1/4 円弧に半径 5 の断面。掃引面が裏返って自分自身と交わるが、OCCT は
    // 例外も出さず妥当な立体として返してしまう(実測。makeSweep.ts 冒頭の注釈 (b))。
    expect(() =>
      makeSweep(oc, sweepInput({ profile: circleProfile(5), path: arcPath(2, 0, Math.PI / 2) })),
    ).toThrow('断面が道筋の曲がりに対して大きすぎます。');
  });

  it('断面の広がりが経路の曲がりの半径より小さければ通る(境目の確かめ)', () => {
    // 半径 5 の円弧に半径 4.9 の断面 ── ぎりぎり通る。半径 5 では断る。
    const handle = makeSweep(
      oc,
      sweepInput({ profile: circleProfile(4.9), path: arcPath(5, 0, Math.PI / 2) }),
    );
    try {
      expect(hasSolid(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
    expect(() =>
      makeSweep(oc, sweepInput({ profile: circleProfile(5), path: arcPath(5, 0, Math.PI / 2) })),
    ).toThrow('断面が道筋の曲がりに対して大きすぎます。');
  });
});
