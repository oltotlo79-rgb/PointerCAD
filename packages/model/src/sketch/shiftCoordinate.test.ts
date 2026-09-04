import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { absoluteCoordinate } from './createSketchDocument.js';
import { polarOffset, WORK_PLANES } from './planeMath.js';
import {
  normalShiftAxis,
  originShiftFromPosition,
  planeShiftAxes,
  shiftCoordinateInput,
  worldShiftAxes,
  type CoordinateShift,
  type OriginShift,
  type ShiftAxes,
} from './shiftCoordinate.js';
import type { CoordinateInput } from './types.js';

function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`評価に失敗しました: ${source} / ${result.error.message}`);
  }
  return result.value;
}

function shiftOf(x: string, y: string, z: string): OriginShift {
  return { x: expr(x), y: expr(y), z: expr(z) };
}

/** 作図面へ写せたことを前提に取り出す。写せなければテストを落とす。 */
function axesOrThrow(axes: ShiftAxes | null): ShiftAxes {
  if (axes === null) {
    throw new Error('作図面の 2 軸へ写せませんでした');
  }
  return axes;
}

/** 極座標を持たない座標を動かすときの指定(作図面は使わない)。 */
function withoutPlane(axes: ShiftAxes): CoordinateShift {
  return { axes, plane: null };
}

/** 絶対座標の3つの式を文字列で取り出す。相対・極が来たらテストを落とす。 */
function sourcesOf(input: CoordinateInput): readonly [string, string, string] {
  if (input.mode !== 'absolute') {
    throw new Error(`絶対座標ではありません: ${input.mode}`);
  }
  return [input.x.source, input.y.source, input.z.source];
}

describe('世界のシフトを作図面へ写す(FR-331、タスク35 ②)', () => {
  it('XY 面は X と Y を動かし、法線方向(Z)は動かさない', () => {
    const axes = axesOrThrow(planeShiftAxes(shiftOf('2', '5', '3'), WORK_PLANES.xy));
    const shifted = shiftCoordinateInput(absoluteCoordinate(10, 20, 30), withoutPlane(axes));
    expect(sourcesOf(shifted)).toEqual(['8', '15', '30']);
  });

  it('XZ 面は X と Z を動かし、Y は動かさない', () => {
    const axes = axesOrThrow(planeShiftAxes(shiftOf('2', '0', '3'), WORK_PLANES.xz));
    const shifted = shiftCoordinateInput(absoluteCoordinate(10, 0, 20), withoutPlane(axes));
    expect(sourcesOf(shifted)).toEqual(['8', '0', '17']);
  });

  it('XZ 面では Y 方向だけのシフトで座標が変わらない', () => {
    const axes = axesOrThrow(planeShiftAxes(shiftOf('0', '5', '0'), WORK_PLANES.xz));
    const shifted = shiftCoordinateInput(absoluteCoordinate(10, 0, 20), withoutPlane(axes));
    expect(sourcesOf(shifted)).toEqual(['10', '0', '20']);
  });

  it('YZ 面は Y と Z を動かし、X は動かさない', () => {
    const axes = axesOrThrow(planeShiftAxes(shiftOf('2', '5', '3'), WORK_PLANES.yz));
    const shifted = shiftCoordinateInput(absoluteCoordinate(10, 20, 30), withoutPlane(axes));
    expect(sourcesOf(shifted)).toEqual(['10', '15', '27']);
  });

  it('3D スケッチ(作図面なし)は世界の 3 成分をそのまま動かす', () => {
    const axes = worldShiftAxes(shiftOf('2', '5', '3'));
    const shifted = shiftCoordinateInput(absoluteCoordinate(10, 20, 30), withoutPlane(axes));
    expect(sourcesOf(shifted)).toEqual(['8', '15', '27']);
  });

  it('式のままの平行移動になり、値は丸めない', () => {
    const axes = worldShiftAxes(shiftOf('10 + π/2', '0', '0'));
    const shifted = shiftCoordinateInput(absoluteCoordinate(3, 0, 0), withoutPlane(axes));
    expect(sourcesOf(shifted)).toEqual(['3 - (10 + π/2)', '0', '0']);
    if (shifted.mode !== 'absolute') {
      throw new Error('絶対座標のはず');
    }
    expect(shifted.x.value).toBeCloseTo(-8.5707963267949, 12);
  });

  it('他の点を基準にした相対・極座標は書き換えない(参照先が動けば追従するため)', () => {
    const shift = withoutPlane(worldShiftAxes(shiftOf('2', '5', '3')));
    const relative: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'previous' },
      dx: expr('10'),
      dy: expr('0'),
      dz: expr('0'),
    };
    expect(shiftCoordinateInput(relative, shift)).toBe(relative);
    const polar: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'point', pointId: 'point-1' },
      distance: expr('10'),
      azimuth: expr('45'),
      elevation: expr('0'),
    };
    expect(shiftCoordinateInput(polar, shift)).toBe(polar);
  });

  it('ワールド原点を基準にした相対座標は、ずれの式ごと動かす(原点が動くため)', () => {
    const shift = withoutPlane(worldShiftAxes(shiftOf('2', '5', '3')));
    const relative: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'origin' },
      dx: expr('10'),
      dy: expr('20'),
      dz: expr('30'),
    };
    const moved = shiftCoordinateInput(relative, shift);
    if (moved.mode !== 'relative') {
      throw new Error('相対座標のはず');
    }
    expect(moved.base).toEqual({ kind: 'origin' });
    expect([moved.dx.source, moved.dy.source, moved.dz.source]).toEqual(['8', '15', '27']);
  });

  it('ワールド原点を基準にした極座標は、同じ点を指す「原点からのずれ」へ書き換える', () => {
    const shift: CoordinateShift = {
      axes: worldShiftAxes(shiftOf('2', '0', '0')),
      plane: WORK_PLANES.xy,
    };
    const polar: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: expr('10'),
      azimuth: expr('45'),
      elevation: expr('0'),
    };
    const moved = shiftCoordinateInput(polar, shift);
    if (moved.mode !== 'relative') {
      throw new Error('相対座標へ書き換わるはず');
    }
    const offset = polarOffset(WORK_PLANES.xy, 10, 45, 0);
    // 位置は寸分変わらない(倍精度をそのまま式にしてからシフトを引く)。
    expect(moved.dx.value).toBe(offset[0] - 2);
    expect(moved.dy.value).toBe(offset[1]);
    expect(moved.dz.value).toBe(offset[2]);
    expect(moved.dx.source).toBe(`${String(offset[0])} - 2`);
  });

  it('何も動かさないシフトでは極座標を書き換えない(利用者の入力を壊さない)', () => {
    const shift: CoordinateShift = {
      axes: worldShiftAxes(shiftOf('0', '0', '0')),
      plane: WORK_PLANES.xy,
    };
    const polar: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: expr('10'),
      azimuth: expr('45'),
      elevation: expr('0'),
    };
    expect(shiftCoordinateInput(polar, shift)).toBe(polar);
  });
});

describe('作業平面の法線方向のシフト(FR-328 のオフセット)', () => {
  it('XY 面の法線は +Z なので Z 成分を引く', () => {
    expect(normalShiftAxis(shiftOf('2', '5', '3'), WORK_PLANES.xy)).toEqual({
      kind: 'subtract',
      amount: expr('3'),
    });
  });

  it('XZ 面の法線は −Y なので Y 成分を足す', () => {
    expect(normalShiftAxis(shiftOf('2', '5', '3'), WORK_PLANES.xz)).toEqual({
      kind: 'add',
      amount: expr('5'),
    });
  });

  it('YZ 面の法線は +X なので X 成分を引く', () => {
    expect(normalShiftAxis(shiftOf('2', '5', '3'), WORK_PLANES.yz)).toEqual({
      kind: 'subtract',
      amount: expr('2'),
    });
  });
});

describe('解決済みの座標からシフト量を作る(立体の頂点、FR-331 の備考)', () => {
  it('倍精度をそのまま持ち、12 桁へ丸めない', () => {
    const shift = originShiftFromPosition([Math.sqrt(150), 1 / 3, 12.3456789]);
    expect(shift.x.source).toBe('12.24744871391589');
    expect(shift.x.value).toBe(Math.sqrt(150));
    expect(shift.y.source).toBe('0.3333333333333333');
    expect(shift.y.value).toBe(1 / 3);
    expect(shift.z.source).toBe('12.3456789');
  });

  it('式を読み直すと同じ倍精度に戻る(往復できる表記)', () => {
    for (const value of [Math.sqrt(150), 1 / 3, -0.1, 1e-7, 1.2345e21, 0]) {
      const shift = originShiftFromPosition([value, 0, 0]);
      const result = evaluateExpression(shift.x.source);
      if (!result.ok) {
        throw new Error(`式として読めません: ${shift.x.source}`);
      }
      expect(result.value.value).toBe(value);
      expect(shift.x.value).toBe(value);
      // 指数表記はこの式の文法に無いので、普通の 10 進で書く。
      expect(shift.x.source).not.toMatch(/e/i);
    }
  });
});
