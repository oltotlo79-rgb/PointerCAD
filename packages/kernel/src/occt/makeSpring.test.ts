import { beforeAll, describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import type { SpringStepSpec } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSpring } from './makeSpring.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { tessellate } from './tessellate.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** 既定はコイル径 20・線径 2・ピッチ 5・巻数 4・右巻き(計画書 §2.7b.5 の 1 行目)。 */
function springSpec(overrides: Partial<SpringStepSpec> = {}): SpringStepSpec {
  return {
    kind: 'spring',
    origin: [0, 0, 0],
    direction: [0, 0, 1],
    coilDiameter: 20,
    wireDiameter: 2,
    pitch: 5,
    turns: 4,
    handedness: 'right',
    ...overrides,
  };
}

/** 相対誤差での突き合わせ(§2.7b.5 の許容: 相対 0.5% 以内)。 */
function expectVolumeNear(actual: number, expected: number, tolerance = 0.005): void {
  const relativeError = Math.abs(actual - expected) / expected;
  expect(relativeError).toBeLessThan(tolerance);
}

describe('ばね(コイルばね、FR-414、計画書 §2.7b.4、タスク9b)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  // §2.7b.5 の検算表(5 行)。導出は計画書のとおり: V = π(d/2)²・L、L = 巻数・√((πD)²+p²)。
  const VOLUME_CASES: readonly {
    readonly label: string;
    readonly coilDiameter: number;
    readonly wireDiameter: number;
    readonly pitch: number;
    readonly turns: number;
    readonly expectedVolume: number;
  }[] = [
    { label: 'D20/d2/p5/n4', coilDiameter: 20, wireDiameter: 2, pitch: 5, turns: 4, expectedVolume: 792.064406711 },
    { label: 'D20/d2/p5/n8', coilDiameter: 20, wireDiameter: 2, pitch: 5, turns: 8, expectedVolume: 1584.128813421 },
    { label: 'D20/d2/p10/n4', coilDiameter: 20, wireDiameter: 2, pitch: 10, turns: 4, expectedVolume: 799.505815901 },
    { label: 'D10/d1/p3/n5', coilDiameter: 10, wireDiameter: 1, pitch: 3, turns: 5, expectedVolume: 123.931278481 },
    { label: 'D30/d3/p8/n10', coilDiameter: 30, wireDiameter: 3, pitch: 8, turns: 10, expectedVolume: 6685.939895405 },
  ];

  for (const testCase of VOLUME_CASES) {
    it(`${testCase.label} の体積が計算値に相対 0.5% 以内で一致する`, () => {
      const handle = makeSpring(
        oc,
        springSpec({
          coilDiameter: testCase.coilDiameter,
          wireDiameter: testCase.wireDiameter,
          pitch: testCase.pitch,
          turns: testCase.turns,
        }),
      );
      try {
        const volume = measureVolume(oc, handle.shape);
        console.log(
          `${testCase.label}: 実測 ${volume.toFixed(6)}mm³ / 計算値 ${testCase.expectedVolume}mm³ (相対 ${(
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

  it('境界箱が X・Y ≈ ±11、Z の幅が 20 より大きく 22 以下になる(D20/d2/p5/n4)', () => {
    const handle = makeSpring(oc, springSpec());
    try {
      const mesh = tessellate(oc, handle.shape);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const x = mesh.positions[i];
        const y = mesh.positions[i + 1];
        const z = mesh.positions[i + 2];
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
      console.log(
        `境界箱(D20/d2/p5/n4): X[${minX.toFixed(3)}, ${maxX.toFixed(3)}] Y[${minY.toFixed(3)}, ${maxY.toFixed(3)}] Z[${minZ.toFixed(3)}, ${maxZ.toFixed(3)}] Z幅=${(maxZ - minZ).toFixed(3)}`,
      );
      // コイル半径 10 + 線半径 1 = 11。掃引の近似ぶんのゆとりを見て ±11.5 以内とする。
      expect(minX).toBeGreaterThan(-11.5);
      expect(maxX).toBeLessThan(11.5);
      expect(minY).toBeGreaterThan(-11.5);
      expect(maxY).toBeLessThan(11.5);
      // Z の幅は軸方向の長さ p·n = 20 に、端の切り口が傾くぶんが乗る(§2.7b.5)。
      expect(maxZ - minZ).toBeGreaterThan(20);
      expect(maxZ - minZ).toBeLessThanOrEqual(22);
    } finally {
      handle.delete();
    }
  });

  it('右巻きと左巻きは体積が同じで、掃引の道筋(接線)は鏡像になる(§0.a-0.33)', () => {
    const right = makeSpring(oc, springSpec({ handedness: 'right' }));
    const left = makeSpring(oc, springSpec({ handedness: 'left' }));
    try {
      const rightVolume = measureVolume(oc, right.shape);
      const leftVolume = measureVolume(oc, left.shape);
      const relativeError = Math.abs(rightVolume - leftVolume) / rightVolume;
      expect(relativeError).toBeLessThan(1e-6);
      expect(hasSolid(oc, right.shape)).toBe(true);
      expect(hasSolid(oc, left.shape)).toBe(true);

      // 形そのものが鏡像であること(gp_Dir2d_4 の符号だけが変わる)は
      // makeHelix.test.ts の「右巻きと左巻きで接線の Y 成分の符号が反転する」検査で
      // 固定済み。ここでは掃引した体積が巻き方向によらないことだけを確かめる。
      const rightMesh = tessellate(oc, right.shape);
      const leftMesh = tessellate(oc, left.shape);
      expect(rightMesh.positions.length).toBeGreaterThan(0);
      expect(leftMesh.positions.length).toBeGreaterThan(0);
    } finally {
      right.delete();
      left.delete();
    }
  });

  it('巻数 0.5(半巻き)でも立体になる', () => {
    const handle = makeSpring(oc, springSpec({ turns: 0.5 }));
    try {
      const volume = measureVolume(oc, handle.shape);
      expectVolumeNear(volume, 99.008050839);
      expect(hasSolid(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('同じ依頼を 2 回作ると、体積が完全に一致する(決定性)', () => {
    const first = makeSpring(oc, springSpec());
    const second = makeSpring(oc, springSpec());
    try {
      expect(measureVolume(oc, first.shape)).toBe(measureVolume(oc, second.shape));
    } finally {
      first.delete();
      second.delete();
    }
  });

  it(`巻数 4 の所要が 500ms 未満(NFR-PF-2)`, () => {
    const started = performance.now();
    const handle = makeSpring(oc, springSpec({ turns: 4 }));
    const elapsedMs = performance.now() - started;
    handle.delete();
    console.log(`巻数 4(D20/d2/p5)の所要: ${elapsedMs.toFixed(1)} ms / 上限 500 ms`);
    expectWithinBudget(elapsedMs, 500, '巻数 4');
  });

  it('巻数 20 / 100 の所要を実測する(§0.35。上限は無く実測を報告するだけ)', () => {
    for (const turns of [20, 100]) {
      const started = performance.now();
      const handle = makeSpring(oc, springSpec({ turns }));
      const elapsedMs = performance.now() - started;
      const volume = measureVolume(oc, handle.shape);
      handle.delete();
      console.log(`巻数 ${turns}(D20/d2/p5)の所要: ${elapsedMs.toFixed(1)} ms、体積 ${volume.toFixed(3)}mm³`);
    }
  });

  it('コイル径が 0 以下だと断る', () => {
    expect(() => makeSpring(oc, springSpec({ coilDiameter: 0 }))).toThrow('コイル径は 0 より大きい');
  });

  it('線径が 0 以下だと断る', () => {
    expect(() => makeSpring(oc, springSpec({ wireDiameter: 0 }))).toThrow('線径は 0 より大きい');
  });

  it('線径がコイル径以上だと断る(D20/d20)', () => {
    expect(() => makeSpring(oc, springSpec({ coilDiameter: 20, wireDiameter: 20 }))).toThrow(
      '線径はコイル径より小さく',
    );
  });

  it('ピッチが 0 以下だと断る', () => {
    expect(() => makeSpring(oc, springSpec({ pitch: 0 }))).toThrow('ピッチは 0 より大きい');
  });

  it('ピッチが線径以下だと断り、掃引を実行しない(隣の巻きと交差するため)', () => {
    expect(() => makeSpring(oc, springSpec({ pitch: 2, wireDiameter: 2 }))).toThrow(
      'ピッチは線径より大きく',
    );
  });

  it('巻数が 0 だと断る', () => {
    expect(() => makeSpring(oc, springSpec({ turns: 0 }))).toThrow('巻数は 0 より大きく 200 以下');
  });

  it('巻数が 201 だと断る(§0.35 の上限 200)', () => {
    expect(() => makeSpring(oc, springSpec({ turns: 201 }))).toThrow('巻数は 0 より大きく 200 以下');
  });

  it('軸が 0 ベクトルだと「ばねの軸」を含む理由で断る', () => {
    expect(() => makeSpring(oc, springSpec({ direction: [0, 0, 0] }))).toThrow('ばねの軸');
  });
});
