import { beforeAll, describe, expect, it } from 'vitest';

import type {
  RigidTransformSpec,
  SolidFaceInfo,
  SubShapeQuery,
  ThreadMarkInfo,
  ThreadStepSpec,
  Vec3Tuple,
} from '../types.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeBox } from './makeBox.js';
import type { HoleEntrySpec } from './makeHole.js';
import { makePrimitive } from './makePrimitive.js';
import type { ThreadShaftInput } from './makeThread.js';
import {
  makeThreadCut,
  makeThreadHole,
  makeThreadShaft,
  threadSweepRadius,
} from './makeThread.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** 計画書 タスク9 の検証表が使う板。体積 12000、上の面は z=10。 */
const PLATE = { dx: 40, dy: 30, dz: 10 } as const;

/**
 * M6 並目のめねじ内径 D1 = 6 − 1.082532×1(§0.a-0.13 の基本山形)。
 * 表そのものは model 側(`packages/model/src/thread/metricThread.ts`)にあり、
 * kernel は model を輸入できないので、検査に使う値をここで独立に計算する。
 */
const M6_MINOR_DIAMETER = 6 - 1.0825317547305482;

/** 下穴だけ(簡略表示)の体積。12000 − π·(D1/2)²·10 = 11810.078990688… */
const M6_DRILLED_VOLUME = 12000 - Math.PI * (M6_MINOR_DIAMETER / 2) ** 2 * PLATE.dz;

function expectVolume(actual: number, expected: number, relative = 1e-9): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(relative);
}

describe('ねじ穴(FR-406、FR-504)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  function tablesOf(shape: Parameters<typeof collectSubShapes>[1]): SubShapeTables {
    const mesh = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges);
  }

  function facesOf(shape: Parameters<typeof collectSubShapes>[1]): readonly SolidFaceInfo[] {
    return tablesOf(shape).faces;
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

  function topFaceOf(faces: readonly SolidFaceInfo[]): SolidFaceInfo {
    const found = faces.find(
      (face) =>
        face.surfaceKind === 'plane' && face.axis !== null && Math.abs(face.axis[2] - 1) < 1e-9,
    );
    if (found === undefined) {
      throw new Error('上の面が見つかりませんでした');
    }
    return found;
  }

  function plateWithTopFace(): {
    handle: OcctShapeHandle;
    faces: readonly SolidFaceInfo[];
    top: SolidFaceInfo;
  } {
    const handle = makeBox(oc, PLATE);
    const faces = facesOf(handle.shape);
    return { handle, faces, top: topFaceOf(faces) };
  }

  function threadSpec(overrides: Partial<ThreadStepSpec> & { face: SubShapeQuery }): ThreadStepSpec {
    return {
      kind: 'thread',
      targetKey: 'target',
      centers: [[20, 15, 10]],
      drillDiameter: M6_MINOR_DIAMETER,
      depth: null,
      tiltAngle: 0,
      tiltAzimuth: 0,
      transforms: [],
      thread: null,
      mark: { majorDiameter: 6, length: 10 },
      ...overrides,
    };
  }

  it('簡略表示の M6 は下穴だけを掘る(12000 − π·(D1/2)²·10)', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const { handle: result } = makeThreadHole(
        oc,
        threadSpec({ face: faceQuery(top) }),
        handle.shape,
        faces,
      );
      try {
        expectVolume(measureVolume(oc, result.shape), M6_DRILLED_VOLUME);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('印は中心 1 つにつき 1 つ返り、軸・外径・長さを持つ', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const { handle: result, marks } = makeThreadHole(
        oc,
        threadSpec({ face: faceQuery(top) }),
        handle.shape,
        faces,
      );
      try {
        expect(marks).toHaveLength(1);
        expect(marks[0].majorDiameter).toBe(6);
        expect(marks[0].length).toBe(10);
        // 印の始点は下穴の口(面の上)、向きは掘り進む向き。
        expect(marks[0].origin[0]).toBeCloseTo(20, 9);
        expect(marks[0].origin[1]).toBeCloseTo(15, 9);
        expect(marks[0].origin[2]).toBeCloseTo(10, 9);
        expect(marks[0].direction[2]).toBeCloseTo(-1, 9);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('印を求めていなければ(mark が null)空の一覧を返す', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const { handle: result, marks } = makeThreadHole(
        oc,
        threadSpec({ face: faceQuery(top), mark: null }),
        handle.shape,
        faces,
      );
      try {
        expect(marks).toHaveLength(0);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('中心が 2 つあれば印も 2 つになる', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const { handle: result, marks } = makeThreadHole(
        oc,
        threadSpec({
          face: faceQuery(top),
          centers: [
            [12, 15, 10],
            [28, 15, 10],
          ],
        }),
        handle.shape,
        faces,
      );
      try {
        expect(marks).toHaveLength(2);
        expect(marks[0].origin[0]).toBeCloseTo(12, 9);
        expect(marks[1].origin[0]).toBeCloseTo(28, 9);
        expectVolume(measureVolume(oc, result.shape), 12000 - 2 * (12000 - M6_DRILLED_VOLUME));
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('パターン(変換 1 つ)では、印も工具も変換ぶんだけ作られる', () => {
    const { handle, faces, top } = plateWithTopFace();
    const shift: RigidTransformSpec = {
      translation: [10, 0, 0],
      rotationOrigin: [0, 0, 0],
      rotationAxis: [0, 0, 1],
      rotationAngle: 0,
    };
    try {
      const { handle: result, marks } = makeThreadHole(
        oc,
        threadSpec({ face: faceQuery(top), centers: [[15, 15, 10]], transforms: [shift] }),
        handle.shape,
        faces,
      );
      try {
        // 変換の一覧は「もとの位置ぶんを除いた」ものなので、あく穴は 1 つ(25,15)。
        expect(marks).toHaveLength(1);
        expect(marks[0].origin[0]).toBeCloseTo(25, 9);
        expectVolume(measureVolume(oc, result.shape), M6_DRILLED_VOLUME);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('ピッチが 0 なら断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeThreadHole(
          oc,
          threadSpec({
            face: faceQuery(top),
            thread: { majorDiameter: 6, pitch: 0, length: 10 },
          }),
          handle.shape,
          faces,
        ),
      ).toThrow(/ねじのピッチは 0 より大きい/);
    } finally {
      handle.delete();
    }
  });

  it('外径が下穴の径以下なら断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeThreadHole(
          oc,
          threadSpec({
            face: faceQuery(top),
            thread: { majorDiameter: M6_MINOR_DIAMETER, pitch: 1, length: 10 },
          }),
          handle.shape,
          faces,
        ),
      ).toThrow(/ねじの外径は下穴の径より大きく/);
    } finally {
      handle.delete();
    }
  });

  it('ねじ部の長さが 0 以下なら断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeThreadHole(
          oc,
          threadSpec({
            face: faceQuery(top),
            thread: { majorDiameter: 6, pitch: 1, length: 0 },
          }),
          handle.shape,
          faces,
        ),
      ).toThrow(/ねじ部の長さは 0 より大きい/);
    } finally {
      handle.delete();
    }
  });

  it('掃引路の半径は山と谷の中間になる', () => {
    expect(threadSweepRadius(6, 4)).toBeCloseTo(2.5, 12);
    expect(threadSweepRadius(6, M6_MINOR_DIAMETER)).toBeCloseTo((6 + M6_MINOR_DIAMETER) / 4, 12);
  });

  it('溝(実らせん)は閉じた立体になり、体積が長さに比例して増える', () => {
    const short = makeThreadCut(
      oc,
      [20, 15, 10],
      [0, 0, -1],
      { majorDiameter: 6, pitch: 1, length: 2 },
      M6_MINOR_DIAMETER,
    );
    try {
      expect(hasSolid(oc, short.shape)).toBe(true);
      expect(isValidShape(oc, short.shape)).toBe(true);
      const volume = measureVolume(oc, short.shape);
      expect(volume).toBeGreaterThan(0);

      const long = makeThreadCut(
        oc,
        [20, 15, 10],
        [0, 0, -1],
        { majorDiameter: 6, pitch: 1, length: 4 },
        M6_MINOR_DIAMETER,
      );
      try {
        // 巻数 2 倍で体積も 2 倍(掃引路が 2 倍になるだけ)。
        // MakePipeShell は掃引面を B スプラインで近似するので厳密には一致しない。
        // 2026-09-04 の実測差は相対 2.06e-6 で、ここは 1e-4(0.01%)で固定する
        // (計画書 §2.7b.5 が掃引の体積に認めている 0.5% より 50 倍厳しい)。
        expect(Math.abs(measureVolume(oc, long.shape) / volume - 2)).toBeLessThan(1e-4);
      } finally {
        long.delete();
      }
    } finally {
      short.delete();
    }
  });

  it('実らせんを切ると、下穴だけより体積が減る(0.8 倍より大きい)', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const started = Date.now();
      const { handle: result } = makeThreadHole(
        oc,
        threadSpec({
          face: faceQuery(top),
          thread: { majorDiameter: 6, pitch: 1, length: 10 },
        }),
        handle.shape,
        faces,
      );
      const elapsed = Date.now() - started;
      try {
        const volume = measureVolume(oc, result.shape);
        // 溝の体積は形が複雑で解析的に出せないので、範囲で固定する(計画書 タスク9 の検証表)。
        expect(volume).toBeLessThan(M6_DRILLED_VOLUME);
        expect(volume).toBeGreaterThan(M6_DRILLED_VOLUME * 0.8);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
        // **所要は NFR-PF-2(500ms)を超える**(2026-09-04 実測 1.5〜3.0 秒)。
        // 上限を緩めないため、ここでは上限の検査を置かず、実測値を記録に残す
        // (§0.a-0.16 の「500ms を超えたら統括へ報告して止まる」に従い報告済み。
        // 打ち切るか P5 へ送るかは統括が決める)。簡略表示(既定)は 30ms 前後。
        console.log(`M6×1 深さ10 の実らせん(10 巻き)1 本の所要: ${elapsed} ms`);
        expect(elapsed).toBeGreaterThanOrEqual(0);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('面が選び直せないときは、穴と同じ文言で断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const stale: SubShapeQuery = { ...faceQuery(top), area: top.area * 100, index: 99 };
      expect(() => makeThreadHole(oc, threadSpec({ face: stale }), handle.shape, faces)).toThrow(
        /もとの面が見つかりません/,
      );
    } finally {
      handle.delete();
    }
  });

  it('材料に当たらない位置のねじ穴は断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const outside: readonly Vec3Tuple[] = [[100, 15, 10]];
      expect(() =>
        makeThreadHole(oc, threadSpec({ face: faceQuery(top), centers: outside }), handle.shape, faces),
      ).toThrow(/ねじ穴が材料に当たりませんでした/);
    } finally {
      handle.delete();
    }
  });

  describe('下穴の入口(ざぐり・皿もみ、FR-422、計画書 P5 タスク42c)', () => {
    /** ざぐり φ11 深さ 4(makeHole.test.ts の入口の検査と同じ寸法)。 */
    const COUNTERBORE: HoleEntrySpec = { kind: 'counterbore', diameter: 11, depth: 4 };

    /** 90 度皿・頭径 12(同上。角度はラジアン)。 */
    const COUNTERSINK: HoleEntrySpec = { kind: 'countersink', diameter: 12, angle: Math.PI / 2 };

    /**
     * φ11 深さ 4 のざぐりが、M6 の下穴(D1)に足して削る量。
     * (π·5.5² − π·(D1/2)²)·4 = 304.1607…
     */
    const COUNTERBORE_EXTRA =
      (Math.PI * 5.5 * 5.5 - Math.PI * (M6_MINOR_DIAMETER / 2) ** 2) * 4;

    /**
     * 90 度皿・頭径 12・**下穴 φ6** の円錐が余分に削る量 π·36。
     * makeHole.test.ts の `COUNTERSINK_EXTRA` と同じ導出
     * (π·3/3·(36+18+9) − π·9·3 = π·36)で、下穴の径を 6 に揃えて比べる。
     */
    const COUNTERSINK_EXTRA = Math.PI * 36;

    /** ねじ穴 1 つをあけて体積を測る(形は必ず解放する)。 */
    function threadVolume(overrides: Partial<ThreadStepSpec>): number {
      const { handle, faces, top } = plateWithTopFace();
      try {
        const { handle: result } = makeThreadHole(
          oc,
          threadSpec({ face: faceQuery(top), ...overrides }),
          handle.shape,
          faces,
        );
        try {
          expect(hasSolid(oc, result.shape)).toBe(true);
          expect(isValidShape(oc, result.shape)).toBe(true);
          return measureVolume(oc, result.shape);
        } finally {
          result.delete();
        }
      } finally {
        handle.delete();
      }
    }

    it('簡略表示の M6 に φ11 深さ 4 のざぐりが付く(下穴だけの値 − ざぐりの増分)', () => {
      expectVolume(threadVolume({ entry: COUNTERBORE }), M6_DRILLED_VOLUME - COUNTERBORE_EXTRA);
    });

    it('皿もみが余分に削る量は π·36(下穴 φ6 で穴と同じ導出)', () => {
      const plain = threadVolume({ drillDiameter: 6 });
      const sunk = threadVolume({ drillDiameter: 6, entry: COUNTERSINK });
      expectVolume(plain - sunk, COUNTERSINK_EXTRA, 1e-6);
      expect(COUNTERSINK_EXTRA).toBeCloseTo(113.09733552923255, 9);
    });

    it('入口を省くと今までどおりの真っ直ぐな下穴になる(既定は plain)', () => {
      expectVolume(threadVolume({}), M6_DRILLED_VOLUME);
      expectVolume(threadVolume({ entry: { kind: 'plain' } }), M6_DRILLED_VOLUME);
    });

    it('入口の値が使えないときは、穴とまったく同じ文言で断る', () => {
      const { handle, faces, top } = plateWithTopFace();
      try {
        const attempt = (entry: HoleEntrySpec): (() => void) => {
          return () => {
            makeThreadHole(
              oc,
              threadSpec({ face: faceQuery(top), entry }),
              handle.shape,
              faces,
            );
          };
        };
        expect(attempt({ kind: 'counterbore', diameter: 4, depth: 4 })).toThrow(
          /ざぐりの径は穴の径より大きくしてください。/,
        );
        expect(attempt({ kind: 'counterbore', diameter: 11, depth: 0 })).toThrow(
          /ざぐりの深さは 0 より大きい数にしてください。/,
        );
        expect(attempt({ kind: 'countersink', diameter: 12, angle: 0 })).toThrow(
          /皿もみの角度は 0 度より大きく 180 度未満にしてください。/,
        );
      } finally {
        handle.delete();
      }
    });

    it('印は入口があっても変わらない(入口は形にだけ効く、§0.a-0.15)', () => {
      const { handle, faces, top } = plateWithTopFace();
      try {
        const marksOf = (entry: HoleEntrySpec | undefined): readonly ThreadMarkInfo[] => {
          const { handle: result, marks } = makeThreadHole(
            oc,
            threadSpec({ face: faceQuery(top), ...(entry === undefined ? {} : { entry }) }),
            handle.shape,
            faces,
          );
          result.delete();
          return marks;
        };
        expect(marksOf(COUNTERBORE)).toEqual(marksOf(undefined));
        expect(marksOf(COUNTERBORE)[0].origin).toEqual([20, 15, 10]);
      } finally {
        handle.delete();
      }
    });

    it('実らせんの削れ量は「入口が無いときの削れ量 + 入口の増分」になる', () => {
      // ねじ部は 5 mm。ざぐりの底(深さ 4)から始めても板(厚み 10)の中に収まるので、
      // 溝の削る量は入口の有無で変わらない(`threadOrigins` の注釈)。
      const thread = { majorDiameter: 6, pitch: 1, length: 5 } as const;
      const plain = threadVolume({ thread });
      const bored = threadVolume({ thread, entry: COUNTERBORE });
      // 溝は下穴より外を削るので、実らせんは必ず下穴だけより体積が小さい。
      expect(plain).toBeLessThan(M6_DRILLED_VOLUME);
      // 掃引面は B スプラインで近似されるので厳密には一致しない。2026-09-05 に Node で
      // 実測した差は 1.966e-4 mm³(板の体積 12000 に対する相対 1.64e-8)だったので、
      // **板の体積に対する相対 1e-7(= 1.2e-3 mm³)**で固定する(実測の 6 倍の余裕)。
      console.log(
        `実らせん + ざぐりの増分: 実測 ${(plain - bored).toFixed(9)} / 期待 ${COUNTERBORE_EXTRA.toFixed(9)} mm³`,
      );
      expect(Math.abs(plain - bored - COUNTERBORE_EXTRA)).toBeLessThan(12000 * 1e-7);
    });
  });

  describe('おねじ(FR-423、計画書 P5 タスク40)', () => {
    /** φ10×20 の軸。底面の中心を原点にして +Z へ立てる。体積 π·5²·20。 */
    const SHAFT_VOLUME = Math.PI * 25 * 20;

    function shaftWithSideFace(): {
      handle: OcctShapeHandle;
      tables: SubShapeTables;
      side: SolidFaceInfo;
      bottom: SolidFaceInfo;
    } {
      const handle = makePrimitive(oc, {
        kind: 'primitive',
        origin: [0, 0, 0],
        axis: [0, 0, 1],
        shape: { kind: 'cylinder', radius: 5, height: 20 },
        originQuery: null,
        targetKey: null,
      });
      const tables = tablesOf(handle.shape);
      const side = tables.faces.find((face) => face.surfaceKind === 'cylinder');
      const bottom = tables.faces.find((face) => face.surfaceKind === 'plane');
      if (side === undefined || bottom === undefined) {
        handle.delete();
        throw new Error('軸の円柱面・平面が見つかりませんでした');
      }
      return { handle, tables, side, bottom };
    }

    function shaftInput(
      overrides: Partial<ThreadShaftInput> & { face: SubShapeQuery },
    ): ThreadShaftInput {
      return {
        majorDiameter: 10,
        pitch: 1.5,
        length: 10,
        fromEnd: 'first',
        modeled: false,
        ...overrides,
      };
    }

    it('簡略表示(M10)は形を変えず、印だけを返す', () => {
      const { handle, tables, side } = shaftWithSideFace();
      try {
        const { handle: result, mark } = makeThreadShaft(
          oc,
          handle.shape,
          tables,
          shaftInput({ face: faceQuery(side) }),
        );
        try {
          // 体積 π·25·20 = 1570.7963267948967 のまま(B-rep に触れない、§0.a-0.15)。
          expectVolume(measureVolume(oc, result.shape), SHAFT_VOLUME);
          expect(hasSolid(oc, result.shape)).toBe(true);
          expect(mark.majorDiameter).toBe(10);
          expect(mark.length).toBe(10);
          // 切り始めは軸の下端、向きは上端へ。
          expect(mark.origin[2]).toBeCloseTo(0, 9);
          expect(mark.direction[2]).toBeCloseTo(1, 9);
        } finally {
          result.delete();
        }
        // 簡略表示の戻りを解放しても、もとの軸はそのまま使える(同じ実体を指す複製)。
        expectVolume(measureVolume(oc, handle.shape), SHAFT_VOLUME);
      } finally {
        handle.delete();
      }
    });

    it("fromEnd が 'last' なら反対の端から切り始める", () => {
      const { handle, tables, side } = shaftWithSideFace();
      try {
        const { handle: result, mark } = makeThreadShaft(
          oc,
          handle.shape,
          tables,
          shaftInput({ face: faceQuery(side), fromEnd: 'last' }),
        );
        try {
          expect(mark.origin[2]).toBeCloseTo(20, 9);
          expect(mark.direction[2]).toBeCloseTo(-1, 9);
        } finally {
          result.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('実らせん(M10×1.5、長さ 10)は軸の外周を削る', () => {
      const { handle, tables, side } = shaftWithSideFace();
      try {
        const elapsed: number[] = [];
        let volume = 0;
        // 所要のばらつきが大きい(P3 のねじ穴で 1.5〜3.9 秒)ので 3 回測る。
        for (let round = 0; round < 3; round += 1) {
          const started = Date.now();
          const { handle: result } = makeThreadShaft(
            oc,
            handle.shape,
            tables,
            shaftInput({ face: faceQuery(side), modeled: true }),
          );
          elapsed.push(Date.now() - started);
          try {
            volume = measureVolume(oc, result.shape);
            expect(hasSolid(oc, result.shape)).toBe(true);
            expect(isValidShape(oc, result.shape)).toBe(true);
          } finally {
            result.delete();
          }
        }
        // 溝の体積は解析的に出せないので範囲で固定する(計画書 タスク40 の検証表)。
        expect(volume).toBeLessThan(SHAFT_VOLUME);
        expect(volume).toBeGreaterThan(SHAFT_VOLUME * 0.8);
        // **所要は NFR-PF-2(500ms)を超える**(ねじ穴の実らせんと同じ扱い、§0.a-0.16)。
        // 上限を緩めないため、ここでは上限の検査を置かず実測値を記録に残す。
        const sorted = [...elapsed].sort((left, right) => left - right);
        console.log(
          `M10×1.5 長さ10 のおねじ(実らせん)1 本の所要: ${sorted.join(' / ')} ms(中央値 ${sorted[1]} ms)`,
        );
        expect(elapsed).toHaveLength(3);
      } finally {
        handle.delete();
      }
    });

    it('平面を指したら「円柱の面だけ」と断る', () => {
      const { handle, tables, bottom } = shaftWithSideFace();
      try {
        expect(() =>
          makeThreadShaft(oc, handle.shape, tables, shaftInput({ face: faceQuery(bottom) })),
        ).toThrow(/おねじを作れるのは円柱の面だけです。/);
      } finally {
        handle.delete();
      }
    });

    it('指紋が合わない・面以外の指紋なら、面が見つからないと断る', () => {
      const { handle, tables, side } = shaftWithSideFace();
      try {
        const stale: SubShapeQuery = { ...faceQuery(side), area: side.area * 100, index: 99 };
        expect(() => makeThreadShaft(oc, handle.shape, tables, shaftInput({ face: stale }))).toThrow(
          /おねじを作るもとの面が見つかりません/,
        );
        const edge: SubShapeQuery = {
          kind: 'edge',
          index: 0,
          curveKind: 'circle',
          length: 2 * Math.PI * 5,
          position: [0, 0, 0],
          axis: [0, 0, 1],
          radius: 5,
        };
        expect(() => makeThreadShaft(oc, handle.shape, tables, shaftInput({ face: edge }))).toThrow(
          /おねじを作るもとの面が見つかりません/,
        );
      } finally {
        handle.delete();
      }
    });

    it('ピッチ・長さ・呼び径が 0 以下なら、掃引を始める前に断る', () => {
      const { handle, tables, side } = shaftWithSideFace();
      try {
        const face = faceQuery(side);
        expect(() =>
          makeThreadShaft(oc, handle.shape, tables, shaftInput({ face, pitch: 0 })),
        ).toThrow(/ねじのピッチは 0 より大きい/);
        expect(() =>
          makeThreadShaft(oc, handle.shape, tables, shaftInput({ face, length: 0 })),
        ).toThrow(/ねじ部の長さは 0 より大きい/);
        expect(() =>
          makeThreadShaft(oc, handle.shape, tables, shaftInput({ face, majorDiameter: 0 })),
        ).toThrow(/おねじの呼び径は 0 より大きい/);
      } finally {
        handle.delete();
      }
    });

    it('ピッチが軸の太さに対して大きすぎるなら断る(谷の径が残らない)', () => {
      const { handle, tables, side } = shaftWithSideFace();
      try {
        expect(() =>
          makeThreadShaft(
            oc,
            handle.shape,
            tables,
            shaftInput({ face: faceQuery(side), pitch: 20, modeled: true }),
          ),
        ).toThrow(/ねじのピッチが軸の太さに対して大きすぎます/);
      } finally {
        handle.delete();
      }
    });
  });
});
