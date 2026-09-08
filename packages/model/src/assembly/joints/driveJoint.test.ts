import { evaluateExpression, expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import * as driving from '../../index.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { collectMateVariables } from '../constraints/mateVariables.js';
import { exponentialMap, IDENTITY_PLACEMENT, quaternionFromAxisAngle, type RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, Joint, JointKind } from '../types.js';
import type { JointCoordinate, JointFrame, JointFramePair } from './jointFrames.js';
import type { PreparedJointResidual } from './jointResiduals.js';

const frame: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
function component(id: string): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: 'part' }, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: false, visible: true, suppressed: false };
}
function joint(kind: JointKind = 'revolute'): Joint {
  return { id: 'joint', name: 'joint', kind, a: { kind: 'origin', componentId: 'a', element: 'origin' },
    b: { kind: 'origin', componentId: 'b', element: 'origin' }, minValue: null, maxValue: null, suppressed: false };
}
function fixture(kind: JointKind = 'revolute', coordinate: JointCoordinate = 'angle', angle = 0, translation = 0) {
  const frames: JointFramePair = { a: frame, b: frame };
  const prepared: PreparedJointResidual = { jointId: 'joint', kind, componentA: 'a', componentB: 'b', frames };
  const placements = new Map<string, RigidPlacement>([['a', { position: [0, 0, translation],
    rotation: quaternionFromAxisAngle([0, 0, 1], -angle * Math.PI / 180) }], ['b', IDENTITY_PLACEMENT]]);
  const variableSet = collectMateVariables({ ...createAssemblyDocument('drive'), components: [component('a'), component('b')] });
  return { joint: prepared, coordinate, placements, variableSet, referenceAngle: 0 };
}
function value(input: ReturnType<typeof fixture>) {
  const result = driving.jointValue(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe('正本の現在値と明示参照によるunwrap', () => {
  it.each([0, 30, -30, 90, -90, 179.999999, 180])('revoluteの%d度を1e-9度以内で読む', (angle) => {
    const input = fixture('revolute', 'angle', angle);
    const before = structuredClone(input.placements);
    expect(Math.abs(value(input).value - angle)).toBeLessThan(1e-9);
    expect(value(input).unit).toBe('deg');
    expect(input.placements).toEqual(before);
  });
  it.each([
    [170, 170, 170], [-170, 170, 190], [170, -170, -190],
    [0, 360, 360], [90, 450, 450], [-90, -450, -450], [180, 0, 180], [-180, 0, 180],
  ])('principal=%d、参照=%dは%dへ一意に持ち上げる', (angle, referenceAngle, expected) => {
    expect(Math.abs(value({ ...fixture('revolute', 'angle', angle), referenceAngle }).value - expected)).toBeLessThan(1e-9);
  });
  it.each([15, -15, 0])('sliderの%d mmを1e-9 mm以内で読む', (translation) => {
    const result = value(fixture('slider', 'translation', 0, translation));
    expect(Math.abs(result.value - translation)).toBeLessThan(1e-9);
    expect(result.unit).toBe('mm');
  });
  it.each(['angle', 'translation'] as const)('cylindricalの%sだけを選んで読む', (coordinate) => {
    const result = value(fixture('cylindrical', coordinate, 30, 15));
    expect(Math.abs(result.value - (coordinate === 'angle' ? 30 : 15))).toBeLessThan(1e-9);
  });
  it('A/Bを交換すると角度と並進の符号が反転する', () => {
    for (const coordinate of ['angle', 'translation'] as const) {
      const input = fixture('cylindrical', coordinate, 30, 15);
      const reversed = { ...input, joint: { ...input.joint, componentA: 'b', componentB: 'a' } };
      expect(Math.abs(value(input).value + value(reversed).value)).toBeLessThan(1e-9);
    }
  });
  it('1e8の共通移動でも局所の1e-5 mmを先に加算して失わない', () => {
    const input = fixture('slider', 'translation');
    input.joint = { ...input.joint, frames: { a: { ...frame, origin: [0, 0, 1e-5] }, b: frame } };
    input.placements = new Map([['a', { ...IDENTITY_PLACEMENT, position: [1e8, -1e8, 1e8] }],
      ['b', { ...IDENTITY_PLACEMENT, position: [1e8, -1e8, 1e8] }]]);
    expect(value(input).value).toBe(1e-5);
  });
  it('ballの3自由度をscalarへ押し込まずunsupportedを返す', () => {
    expect(driving.jointValue(fixture('ball'))).toMatchObject({ ok: false, reason: 'unsupported' });
  });
  it.each([['revolute', 'translation'], ['slider', 'angle']] as const)('%sの%sは非対応座標として拒否する', (kind, coordinate) => {
    expect(driving.jointValue(fixture(kind, coordinate))).toMatchObject({ ok: false, reason: 'unsupported' });
  });
  it.each([NaN, Infinity, -Infinity])('角度の非有限参照%sを拒否する', (referenceAngle) => {
    expect(driving.jointValue({ ...fixture(), referenceAngle })).toMatchObject({ ok: false, reason: 'invalidReference' });
  });
  it('角度の参照省略で周回数を勝手にゼロとしない', () => {
    const { joint, coordinate, placements, variableSet } = fixture();
    expect(driving.jointValue({ joint, coordinate, placements, variableSet })).toMatchObject({ ok: false, reason: 'invalidReference' });
  });
});

describe('入力だけのclamp、境界状態、式の失敗', () => {
  it.each([
    [145, 30, 120, 120, true, true], [60, 30, 120, 60, false, false],
    [120, 30, 120, 120, true, false], [30, 30, 120, 30, true, false],
    [-10, 0, null, 0, true, true], [10, null, 5, 5, true, true],
    [1000, null, null, 1000, false, false], [5, 5, 5, 5, true, false],
  ] as const)('要求%d、範囲[%s,%s]は%d、境界=%s、範囲外=%s', (requested, min, max, expected, atLimit, outOfRange) => {
    expect(driving.clampToRange(requested, min, max)).toMatchObject({ ok: true, value: expected, atLimit, outOfRange });
  });
  it.each([NaN, Infinity, -Infinity])('非有限の駆動要求%sは無限範囲でも拒否する', (requested) => {
    expect(driving.clampToRange(requested, null, null)).toMatchObject({ ok: false, reason: 'invalidValue' });
  });
  it.each([[10, 5], [NaN, null], [null, NaN], [-Infinity, 10], [0, Infinity]] as const)('壊れた範囲[%s,%s]を無制限へ読み替えない', (min, max) => {
    expect(driving.clampToRange(0, min, max)).toMatchObject({ ok: false, reason: 'invalidRange' });
  });
  it('非driverの範囲違反は値を保ちwarning情報だけ返す', () => {
    const input = fixture('slider', 'translation', 0, 145);
    const before = structuredClone(input.placements);
    const result = driving.inspectJointRange(value(input).value, 30, 120);
    expect(result).toMatchObject({ ok: true, value: 145, atLimit: false, outOfRange: true });
    expect(input.placements).toEqual(before);
  });
  it('角度*2を組のパラメータから評価し、保存値を上限として使わない', () => {
    const input = fixture();
    const j = { ...joint(), minValue: expressionValueFromNumber(30), maxValue: { source: '角度*2', value: 999, display: '999' } };
    const prepared = driving.prepareJointDrive({ joint: j, frames: input.joint.frames, placements: input.placements,
      request: { jointId: j.id, coordinate: 'angle', value: 145, referenceAngle: 0 }, parameters: new Map([['角度', 60]]) });
    expect(prepared).toMatchObject({ ok: true, drive: { requested: 145, target: 120, atLimit: true, outOfRange: true } });
    expect(j.maxValue.value).toBe(999);
  });
  it.each(['missing', '1/0', 'sqrt(-1)'])('無効な式%sを保存済み値で代用しない', (source) => {
    const input = fixture();
    const j = { ...joint(), maxValue: { source, value: 120, display: '120' } };
    expect(driving.prepareJointDrive({ joint: j, frames: input.joint.frames, placements: input.placements,
      request: { jointId: j.id, coordinate: 'angle', value: 60, referenceAngle: 0 } }))
      .toMatchObject({ ok: false, reason: 'invalidExpression' });
  });
  it('cylindricalの保存された一組の限界を両座標へ暗黙適用しない', () => {
    const input = fixture('cylindrical');
    const j = { ...joint('cylindrical'), maxValue: expressionValueFromNumber(5) };
    expect(driving.prepareJointDrive({ joint: j, frames: input.joint.frames, placements: input.placements,
      request: { jointId: j.id, coordinate: 'angle', value: 60, referenceAngle: 0 } }))
      .toMatchObject({ ok: false, reason: 'ambiguousRange' });
    expect(driving.prepareJointDrive({ joint: j, frames: input.joint.frames, placements: input.placements,
      request: { jointId: j.id, coordinate: 'angle', value: 60, referenceAngle: 0, bounds: { min: null, max: null } } }))
      .toMatchObject({ ok: true, drive: { target: 60 } });
  });
  it.each(['missingJoint', 'suppressed', 'missingFrame', 'dangling'] as const)('%sを区別して準備を断る', (reason) => {
    const input = fixture();
    expect(driving.prepareJointDrive({ joint: reason === 'missingJoint' ? undefined : { ...joint(), suppressed: reason === 'suppressed' },
      frames: reason === 'missingFrame' ? undefined : input.joint.frames,
      placements: reason === 'dangling' ? new Map() : input.placements,
      request: { jointId: 'joint', coordinate: 'angle', value: 30, referenceAngle: 0 } }))
      .toMatchObject({ ok: false, reason });
  });
});

describe('driver1行と解析Jacobian、trialの所有', () => {
  it.each(['angle', 'translation'] as const)('%sのdriverは1行だけ、既存joint行数を変更しない', (coordinate) => {
    const input = fixture('cylindrical', coordinate, 30, 15);
    const target = coordinate === 'angle' ? 60 : 25;
    const result = driving.driveJointRows({ ...input, target, characteristicLength: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ jointId: 'joint', coordinate,
      unit: coordinate === 'angle' ? 'angle' : 'length', scale: coordinate === 'angle' ? 1 : 0.01 });
    expect(Math.abs(result.rows[0].value - (coordinate === 'angle' ? -Math.PI / 6 : -0.1))).toBeLessThan(1e-14);
  });
  for (const coordinate of ['angle', 'translation'] as const) for (const config of ['identity', 'arms', 'rotated', 'trial'] as const) {
    it(`${coordinate}/${config}: h=1e-7で解析微分の全12列を独立検算する`, () => {
      const input = fixture('cylindrical', coordinate, 20, 7);
      if (config !== 'identity') input.joint = { ...input.joint, frames: {
        a: { ...frame, origin: [2, -3, 4] }, b: { ...frame, origin: [-1, 5, 2] },
      } };
      if (config === 'rotated' || config === 'trial') input.placements = new Map([
        ['a', { position: [2, 3, -4], rotation: exponentialMap([0.2, -0.3, 0.4]) }],
        ['b', { position: [-2, 5, 1], rotation: exponentialMap([-0.1, 0.2, 0.1]) }],
      ]);
      const increments = config === 'trial' ? [0.1, 0.2, -0.1, 0.03, -0.04, 0.02, -0.2, 0.1, 0.3, -0.02, 0.05, -0.01]
        : new Array<number>(12).fill(0);
      const before = structuredClone({ placements: input.placements, joint: input.joint, increments });
      const evaluate = (step: readonly number[]) => {
        const result = driving.driveJointRows({ ...input, increments: step, target: 50, characteristicLength: 100 });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.reason);
        return result.rows[0];
      };
      const analytic = evaluate(increments);
      for (let column = 0; column < 12; column += 1) {
        const plus = [...increments], minus = [...increments];
        plus[column] += 1e-7; minus[column] -= 1e-7;
        const central = (evaluate(plus).value - evaluate(minus).value) / 2e-7;
        const exact = analytic.gradient.get(column) ?? 0;
        expect(Math.abs(exact - central)).toBeLessThanOrEqual(1e-8 + 1e-6 * Math.max(Math.abs(exact), Math.abs(central)));
      }
      expect({ placements: input.placements, joint: input.joint, increments }).toEqual(before);
    });
  }
  it.each(['all', 'tx', 'rx', 'undefined', 'nan', 'infinity'] as const)('増分%sを密な有限配列として受理しない', (damage) => {
    const increments: number[] = damage === 'all' ? new Array<number>(12) : new Array<number>(12).fill(0);
    if (damage === 'tx') expect(Reflect.deleteProperty(increments, 0)).toBe(true);
    if (damage === 'rx') expect(Reflect.deleteProperty(increments, 3)).toBe(true);
    if (damage === 'undefined') Object.defineProperty(increments, 0, { value: undefined });
    if (damage === 'nan') increments[0] = NaN;
    if (damage === 'infinity') increments[3] = Infinity;
    expect(driving.driveJointRows({ ...fixture(), increments, target: 30 })).toMatchObject({ ok: false, reason: 'invalidIncrement' });
  });
  it('凍結した密な0増分は省略時と完全一致する', () => {
    const input = { ...fixture(), target: 30 };
    expect(driving.driveJointRows({ ...input, increments: Object.freeze(new Array<number>(12).fill(0)) }))
      .toEqual(driving.driveJointRows(input));
  });
  it.each(['short rotation', 'huge norm', 'short position', 'empty origin'] as const)('P7-19で閉じた%sをdriver入口でも拒否する', (damage) => {
    const input = fixture();
    const placement = structuredClone(IDENTITY_PLACEMENT);
    if (damage === 'short rotation') Object.defineProperty(placement, 'rotation', { value: [1] });
    if (damage === 'huge norm') Object.defineProperty(placement, 'rotation', { value: [1e308, 1e308, 1e308, 1e308] });
    if (damage === 'short position') Object.defineProperty(placement, 'position', { value: [] });
    if (damage === 'empty origin') {
      const local = structuredClone(frame);
      Object.defineProperty(local, 'origin', { value: [] });
      input.joint = { ...input.joint, frames: { a: local, b: frame } };
    }
    input.placements.set('a', placement);
    expect(driving.driveJointRows({ ...input, target: 30 })).toMatchObject({ ok: false, reason: 'invalidFrame' });
  });
  it.each([0, -1, NaN, Infinity])('代表長さ%sは拒否し有限の1/Lだけ使う', (characteristicLength) => {
    expect(driving.driveJointRows({ ...fixture('slider', 'translation'), target: 15, characteristicLength }))
      .toMatchObject({ ok: false, reason: 'invalidScale' });
  });
  it.each(['angle', 'translation'] as const)('両端が同じ部品の%sは微分を相殺する', (coordinate) => {
    const input = fixture('cylindrical', coordinate);
    input.joint = { ...input.joint, componentB: 'a' };
    const result = driving.driveJointRows({ ...input, target: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.rows[0].value).toBe(0);
    expect([...result.rows[0].gradient.values()].every((coefficient) => coefficient === 0)).toBe(true);
  });
  it('角度πを跨ぐ微小trialでも参照180の同じchart上で連続に評価する', () => {
    const input = { ...fixture('revolute', 'angle', 180), referenceAngle: 180, target: 180 };
    const plus = new Array<number>(12).fill(0), minus = [...plus];
    plus[5] = 1e-7; minus[5] = -1e-7;
    const high = driving.driveJointRows({ ...input, increments: plus });
    const low = driving.driveJointRows({ ...input, increments: minus });
    expect(high.ok && low.ok).toBe(true);
    if (!high.ok || !low.ok) throw new Error('π chart refusal');
    expect(Math.abs((high.rows[0].value - low.rows[0].value) / 2e-7 + 1)).toBeLessThan(1e-6);
  });
  it('半回転以上のtrialはunwrapの周回を推測せず棄却する', () => {
    const increments = new Array<number>(12).fill(0);
    increments[5] = Math.PI;
    expect(driving.driveJointRows({ ...fixture(), increments, target: 450 })).toMatchObject({ ok: false, reason: 'rotationBranch' });
  });
  it('同一入力20回とplacementsの逆順で現在値・全微分が一致する', () => {
    const input = { ...fixture('cylindrical', 'translation', 30, 15), target: 20 };
    const expected = driving.driveJointRows(input);
    for (let i = 0; i < 20; i += 1) expect(driving.driveJointRows(input)).toEqual(expected);
    expect(driving.driveJointRows({ ...input, placements: new Map([...input.placements].reverse()) })).toEqual(expected);
  });
});

describe('P7-20 M1: 境界式へ非長さ変数の意味を渡す', () => {
  const cases = [
    ['none', '', 2, 2], ['none', 'mm', 2, 2], ['none', 'in', 2, 50.8],
    ['degree', '', 2, 2], ['degree', 'mm', 2, 2], ['degree', 'in', 2, 50.8],
    ['mm', '', 25.4, 25.4], ['mm', 'mm', 25.4, 25.4], ['mm', 'in', 25.4, 25.4],
  ] as const;
  for (const kind of ['slider', 'cylindrical'] as const) {
    it.each(cases)(`${kind}: %s変数の%s境界を既存evaluatorと独立数値で検算する`, (unit, suffix, parameter, limit) => {
      const input = fixture(kind, 'translation');
      const parameters = new Map([['gain', parameter]]);
      const nonLengthVariables = new Set(unit === 'mm' ? [] : ['gain']);
      const source = suffix === '' ? 'gain*1' : `(gain*1)${suffix}`;
      const control = evaluateExpression(source, { variables: parameters, nonLengthVariables });
      expect(control).toMatchObject({ ok: true, value: { value: limit } });
      for (const side of ['lower', 'upper', 'both'] as const) {
        const bounds = {
          min: side === 'upper' ? null : { source: `-(${source})`, value: -999, display: '-999' },
          max: side === 'lower' ? null : { source, value: 999, display: '999' },
        };
        for (const requested of [-60, -30, 0, 30, 60]) {
          const before = structuredClone({ parameters, nonLengthVariables, bounds, placements: input.placements });
          const result = driving.prepareJointDrive({ joint: joint(kind), frames: input.joint.frames,
            placements: input.placements, parameters, nonLengthVariables,
            request: { jointId: 'joint', coordinate: 'translation', value: requested, bounds } });
          const min = side === 'upper' ? -Infinity : -limit;
          const max = side === 'lower' ? Infinity : limit;
          const target = Math.min(max, Math.max(min, requested));
          expect(result).toMatchObject({ ok: true, drive: { target: target === 0 ? 0 : target,
            min: side === 'upper' ? null : -limit, max: side === 'lower' ? null : limit,
            atLimit: target === min || target === max, outOfRange: requested < min || requested > max } });
          expect({ parameters, nonLengthVariables, bounds, placements: input.placements }).toEqual(before);
        }
      }
    });
  }
  it('型情報を省略した直接Mapは従来の全長さ扱い、明示集合だけが倍率を変える', () => {
    const input = fixture('slider', 'translation');
    const args = { joint: joint('slider'), frames: input.joint.frames, placements: input.placements,
      parameters: new Map([['gain', 2]]), request: { jointId: 'joint', coordinate: 'translation' as const,
        value: 30, bounds: { min: null, max: { source: '(gain*1)in', value: 50.8, display: '50.8' } } } };
    expect(driving.prepareJointDrive(args)).toMatchObject({ ok: true, drive: { target: 2 } });
    expect(driving.prepareJointDrive({ ...args, nonLengthVariables: new Set() })).toEqual(driving.prepareJointDrive(args));
    expect(driving.prepareJointDrive({ ...args, nonLengthVariables: new Set(['gain']) }))
      .toMatchObject({ ok: true, drive: { target: 30, max: 50.8, atLimit: false, outOfRange: false } });
  });
});

describe('P7-20 L1: 公開数値のsigned zeroを正規化する', () => {
  it.each([
    [null, null], [-2, null], [null, 2], [-2, 2],
    [-0, null], [0, null], [null, -0], [null, 0], [-0, 0], [0, -0], [-2, -0], [0, 2],
  ] as const)('範囲[%s,%s]と負・正・±0の全組合せでclampとinspectionを分ける', (min, max) => {
    for (const requested of [-3, -1, -0, 0, 1, 3]) {
      const expected = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, requested));
      const clamped = driving.clampToRange(requested, min, max);
      const inspected = driving.inspectJointRange(requested, min, max);
      expect(clamped.ok && inspected.ok).toBe(true);
      if (!clamped.ok || !inspected.ok) throw new Error('valid finite range refused');
      expect(clamped.value).toBe(expected === 0 ? 0 : expected);
      expect(inspected.value).toBe(requested === 0 ? 0 : requested);
      expect(Object.is(clamped.value, -0)).toBe(false);
      expect(Object.is(inspected.value, -0)).toBe(false);
      expect(clamped.atLimit).toBe(expected === min || expected === max);
      expect(inspected.atLimit).toBe(requested === min || requested === max);
      const outside = requested < (min ?? -Infinity) || requested > (max ?? Infinity);
      expect(clamped.outOfRange).toBe(outside);
      expect(inspected.outOfRange).toBe(outside);
    }
  });
  for (const [kind, coordinate] of [['revolute', 'angle'], ['slider', 'translation'],
    ['cylindrical', 'angle'], ['cylindrical', 'translation']] as const) {
    it.each(['neither', 'lower', 'upper', 'both'] as const)(`${kind}.${coordinate}: %s境界の公開値に-0を残さない`, (side) => {
      const input = fixture(kind, coordinate, -0, -0);
      const negativeZero = { source: '-0', value: -0, display: '-0' };
      const bounds = { min: side === 'lower' || side === 'both' ? negativeZero : null,
        max: side === 'upper' || side === 'both' ? negativeZero : null };
      for (const requested of [-1, -0, 0, 1]) {
        const result = driving.prepareJointDrive({ joint: joint(kind), frames: input.joint.frames,
          placements: input.placements, request: { jointId: 'joint', coordinate, value: requested, referenceAngle: -0, bounds } });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.reason);
        for (const number of [result.drive.requested, result.drive.target, result.drive.min,
          result.drive.max, result.drive.referenceAngle]) expect(Object.is(number, -0)).toBe(false);
        expect(result.drive.requested).toBe(requested === 0 ? 0 : requested);
      }
      const current = driving.jointValue({ ...input, referenceAngle: -0 });
      const rows = driving.driveJointRows({ ...input, referenceAngle: -0, target: -0 });
      expect(current.ok && rows.ok).toBe(true);
      if (!current.ok || !rows.ok) throw new Error('valid zero refused');
      expect(current.value).toBe(0);
      expect(rows.actual).toBe(0);
      expect(Object.is(current.value, -0)).toBe(false);
      expect(Object.is(rows.actual, -0)).toBe(false);
    });
  }
});
