import { afterAll, describe, expect, it } from 'vitest';
import { matrixRank } from '../../sketch/constraints/solve.js';
import { lengthVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { exponentialMap, IDENTITY_PLACEMENT, quaternionFromAxisAngle, type RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, Joint, JointKind } from '../types.js';
import { collectMateVariables } from '../constraints/mateVariables.js';
import type { JointFrame, JointFramePair } from './jointFrames.js';
import { buildJointResidualReport, buildJointResiduals, prepareJointResiduals, type JointResidualInput } from './jointResiduals.js';

const F: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const kinds = ['revolute', 'slider', 'cylindrical', 'ball'] as const;
function component(id: string, fixed = false): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: 'part' }, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed, visible: true, suppressed: false };
}
function joint(kind: JointKind, id = 'j'): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: 'a', element: 'origin' },
    b: { kind: 'origin', componentId: 'b', element: 'origin' }, minValue: null, maxValue: null, suppressed: false };
}
function fixture(kind: JointKind, frames: JointFramePair = { a: F, b: F },
  placements: ReadonlyMap<string, RigidPlacement> = new Map([['a', IDENTITY_PLACEMENT], ['b', IDENTITY_PLACEMENT]]),
  fixedB = false): JointResidualInput {
  const prepared = prepareJointResiduals({ joints: [joint(kind)], frames: new Map([['j', frames]]), placements });
  expect(prepared.skipped).toEqual([]);
  return { joints: prepared.joints, placements, characteristicLength: 1,
    variableSet: collectMateVariables({ ...createAssemblyDocument('j'), components: [component('a'), component('b', fixedB)] }) };
}
function report(input: JointResidualInput) {
  const value = buildJointResidualReport(input);
  expect(value.skipped).toEqual([]);
  return value;
}
let derivativeCount = 0, maximumAbsoluteError = 0, maximumRelativeError = 0;
afterAll(() => console.log('[P7-19 analytic/central]', JSON.stringify({ derivativeCount, maximumAbsoluteError, maximumRelativeError })));

describe('4種×5配置の解析Jacobianを固定基準の中心差分で検算', () => {
  const configurations = [
    { label: 'identity', a: IDENTITY_PLACEMENT, b: IDENTITY_PLACEMENT, increments: new Array<number>(12).fill(0) },
    { label: 'remote offset', a: { position: [1e8 + 4, -1e8 + 5, 1e8 + 6] as const, rotation: exponentialMap([0.03, -0.04, 0.02]) },
      b: { position: [1e8, -1e8, 1e8] as const, rotation: exponentialMap([-0.04, 0.02, 0.03]) }, increments: new Array<number>(12).fill(0) },
    { label: 'noncommuting', a: { position: [3, -4, 5] as const, rotation: exponentialMap([0.4, -0.2, 0.6]) },
      b: { position: [-2, 3, 1] as const, rotation: exponentialMap([-0.3, 0.5, 0.1]) }, increments: new Array<number>(12).fill(0) },
    { label: 'nonzero trial', a: { position: [2, 3, 4] as const, rotation: exponentialMap([0.2, -0.3, 0.1]) },
      b: { position: [-1, 2, -3] as const, rotation: exponentialMap([-0.1, 0.2, 0.4]) },
      increments: [0.2, -0.1, 0.3, 0.13, -0.21, 0.17, -0.3, 0.2, -0.1, -0.19, 0.16, 0.23] },
    { label: 'pi chart', a: { position: [0, 0, 0] as const, rotation: quaternionFromAxisAngle([1, 2, 3], Math.PI - 1e-8) },
      b: IDENTITY_PLACEMENT, increments: new Array<number>(12).fill(0) },
  ];
  for (const kind of kinds) for (const config of configurations) {
    it(`${kind}: ${config.label}, h=1e-7, 全12列`, () => {
      const input = { ...fixture(kind, { a: { ...F, origin: [1, 2, 3] }, b: { ...F, origin: [-2, 1, 4] } },
        new Map([['a', config.a], ['b', config.b]])), increments: config.increments };
      const before = structuredClone({ joints: input.joints, placements: input.placements, increments: input.increments });
      const rows = report(input).rows;
      for (let column = 0; column < 12; column += 1) {
        const plus = [...config.increments], minus = [...config.increments];
        plus[column] += 1e-7; minus[column] -= 1e-7;
        const high = report({ ...input, increments: plus }).rows;
        const low = report({ ...input, increments: minus }).rows;
        rows.forEach((row, index) => {
          const analytic = row.gradient.get(column) ?? 0;
          const central = (high[index].value - low[index].value) / 2e-7;
          const absolute = Math.abs(analytic - central), size = Math.max(Math.abs(analytic), Math.abs(central));
          derivativeCount += 1;
          maximumAbsoluteError = Math.max(maximumAbsoluteError, absolute);
          if (size >= 0.1) maximumRelativeError = Math.max(maximumRelativeError, absolute / size);
          expect(absolute, `row ${index} column ${column}: ${analytic}/${central}`).toBeLessThanOrEqual(1e-8 + 1e-6 * size);
          if (Math.abs(analytic) >= 0.1) expect(absolute / Math.abs(analytic)).toBeLessThanOrEqual(1e-6);
          expect(row.gradient.size).toBeLessThanOrEqual(12);
        });
      }
      expect({ joints: input.joints, placements: input.placements, increments: input.increments }).toEqual(before);
    });
  }
});

describe('式・自由度・分岐・失敗契約', () => {
  it.each([['revolute', 5, 1], ['slider', 5, 1], ['cylindrical', 4, 2], ['ball', 3, 3]] as const)('%sは%d行、固定1と可動1の自由度%d', (kind, count, dof) => {
    const input = fixture(kind, undefined, undefined, true);
    const rows = buildJointResiduals(input);
    expect(rows).toHaveLength(count);
    expect(rows.every((r) => Math.abs(r.value) < 1e-15 && r.jointId === 'j')).toBe(true);
    const matrix = rows.map((r) => Array.from({ length: 6 }, (_, j) => r.gradient.get(j) ?? 0));
    expect(6 - matrixRank(matrix, 6)).toBe(dof);
  });
  it.each(['revolute', 'cylindrical'] as const)('%sは軸回転を自由にする', (kind) => {
    const input = fixture(kind, undefined, new Map([['a', { ...IDENTITY_PLACEMENT,
      rotation: quaternionFromAxisAngle([0, 0, 1], 1.2) }], ['b', IDENTITY_PLACEMENT]]));
    expect(report(input).rows.every((r) => Math.abs(r.value) < 1e-15)).toBe(true);
  });
  it.each(['slider', 'cylindrical'] as const)('%sは軸方向移動だけを自由にする', (kind) => {
    const input = fixture(kind, undefined, new Map([['a', { ...IDENTITY_PLACEMENT, position: [0, 0, 17] }], ['b', IDENTITY_PLACEMENT]]));
    expect(report(input).rows.every((r) => Math.abs(r.value) < 1e-15)).toBe(true);
    const shifted = report({ ...input, placements: new Map(input.placements).set('a', { ...IDENTITY_PLACEMENT, position: [2, 0, 17] }) });
    expect(shifted.rows.some((r) => r.value === 2)).toBe(true);
  });
  it('球は向き3成分を自由にする', () => {
    const rows = report(fixture('ball', undefined, new Map([['a', { ...IDENTITY_PLACEMENT,
      rotation: exponentialMap([1, 2, 3]) }], ['b', IDENTITY_PLACEMENT]]))).rows;
    expect(rows.map((r) => r.value)).toEqual([0, 0, 0]);
  });
  it.each([
    { axis: [1, 0, 0] as const, rotatedArm: [3, -5, 4] as const },
    { axis: [0, 1, 0] as const, rotatedArm: [5, 4, -3] as const },
    { axis: [0, 0, 1] as const, rotatedArm: [-4, 3, 5] as const },
  ])('非零腕のballは$axisの有限回転と並進補正で取付点を保つ', ({ axis, rotatedArm }) => {
    const mount: Vec3 = [20, 30, 40], arm: Vec3 = [3, 4, 5];
    const rotation = quaternionFromAxisAngle(axis, Math.PI / 2);
    const placements = new Map<string, RigidPlacement>([['a', { position: subVec3(mount, rotatedArm), rotation }], ['b', IDENTITY_PLACEMENT]]);
    const input = fixture('ball', { a: { ...F, origin: arm }, b: { ...F, origin: mount } }, placements, true);
    const rows = report(input).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => Math.abs(r.value) < 1e-12)).toBe(true);
    expect(matrixRank(rows.map((r) => Array.from({ length: 6 }, (_, j) => r.gradient.get(j) ?? 0)), 6)).toBe(3);
    // 補正しない回転では取付点が動く。この検査がorigin=0の特例に戻らないことも固定する。
    const uncompensated = report({ ...input, placements: new Map(placements).set('a', { position: subVec3(mount, arm), rotation }) });
    expect(Math.hypot(...uncompensated.rows.map((r) => r.value))).toBeGreaterThan(1);
  });
  it.each<Vec3>([[1, 0, 0], [0, 1, 0], [0, 0, 1]])('sliderのπ回転%sは偽の零残差にならない', (x, y, z) => {
    const rows = report(fixture('slider', undefined, new Map([['a', { ...IDENTITY_PLACEMENT,
      rotation: quaternionFromAxisAngle([x, y, z], Math.PI) }], ['b', IDENTITY_PLACEMENT]]))).rows;
    expect(Math.hypot(...rows.slice(0, 3).map((r) => r.value))).toBeCloseTo(Math.PI, 12);
    expect(rows.slice(0, 3).every((r) => r.measure === 'rotation')).toBe(true);
  });
  it.each(['revolute', 'cylindrical'] as const)('%sの逆軸は行を保ち分岐違反を返す', (kind) => {
    const value = report(fixture(kind, { a: { ...F, y: [0, -1, 0], z: [0, 0, -1] }, b: F }));
    expect(value.branchViolations).toEqual(['j']);
    expect(value.rows.length).toBe(kind === 'revolute' ? 5 : 4);
    expect(value.rows.every((r) => Math.abs(r.value) < 1e-15)).toBe(true);
  });
  it('同じ部品の両端は微分を加算し相殺する', () => {
    const base = fixture('slider');
    const rows = report({ ...base, joints: base.joints.map((j) => ({ ...j, componentB: j.componentA })) }).rows;
    expect(rows.every((row) => [...row.gradient.values()].every((v) => v === 0))).toBe(true);
  });
  it('固定両端でも残差は消さずgradientを空にする', () => {
    const base = fixture('ball', { a: { ...F, origin: [1, 2, 3] }, b: F });
    const rows = report({ ...base, variableSet: collectMateVariables({ ...createAssemblyDocument('fixed'),
      components: [component('a', true), component('b', true)] }) }).rows;
    expect(rows.map((r) => r.value)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.gradient.size === 0)).toBe(true);
  });
  it.each([1e-3, 1, 1e6])('L=%dで長さの値と微分だけ一度尺度化する', (length) => {
    const input = fixture('revolute', { a: { ...F, origin: [2, 3, 4] }, b: F });
    const raw = report(input).rows, scaled = report({ ...input, characteristicLength: length }).rows;
    scaled.forEach((row, index) => {
      const scale = row.measure === 'length' ? 1 / length : 1;
      expect(row.scale).toBe(scale);
      expect(row.value).toBe(raw[index].value * scale);
      for (const [column, value] of row.gradient) expect(value).toBe(raw[index].gradient.get(column)! * scale);
    });
  });
  it('抑制はframe無しでも行も失敗も返さない', () => {
    expect(prepareJointResiduals({ joints: [{ ...joint('ball'), suppressed: true }], frames: new Map(), placements: new Map() }))
      .toEqual({ joints: [], skipped: [] });
  });
  it('missingFrameとdanglingとinvalidFrameを区別する', () => {
    const placements = fixture('ball').placements;
    const prepare = (frames: ReadonlyMap<string, JointFramePair>, p = placements) => prepareJointResiduals({ joints: [joint('ball')], frames, placements: p }).skipped[0].reason;
    expect(prepare(new Map())).toBe('missingFrame');
    expect(prepare(new Map([['j', { a: F, b: F }]]), new Map())).toBe('dangling');
    expect(prepare(new Map([['j', { a: { ...F, x: [NaN, 0, 0] }, b: F }]]))).toBe('invalidFrame');
  });
  it('不正尺度・増分・後から失った配置を断る', () => {
    const input = fixture('ball');
    for (const length of [0, -1, NaN, Infinity, Number.MIN_VALUE]) {
      expect(buildJointResidualReport({ ...input, characteristicLength: length }).skipped[0].reason).toBe('invalidScale');
    }
    for (const increments of [[0], new Array<number>(12).fill(NaN), new Array<number>(12).fill(Infinity)]) {
      expect(buildJointResidualReport({ ...input, increments }).skipped[0].reason).toBe('invalidIncrement');
    }
    expect(buildJointResidualReport({ ...input, placements: new Map() }).skipped[0].reason).toBe('dangling');
  });
  it.each([
    'all-holes', 'tx-hole', 'rx-hole', 'last-hole', 'inherited-tx',
    'undefined', 'NaN', 'Infinity', '-Infinity', 'numeric-string',
  ] as const)('増分配列の%sをinvalidIncrementで拒否する', (kind) => {
    const input = fixture('slider', undefined, undefined, true);
    expect(input.variableSet.variables).toHaveLength(6);
    const increments = new Array<number>(6);
    if (kind !== 'all-holes') increments.fill(0);
    if (kind === 'tx-hole' || kind === 'inherited-tx') Reflect.deleteProperty(increments, '0');
    if (kind === 'rx-hole') Reflect.deleteProperty(increments, '3');
    if (kind === 'last-hole') Reflect.deleteProperty(increments, '5');
    // 有限の継承値があっても、呼出側が全6添字を所有しない配列は不正。
    if (kind === 'inherited-tx') Object.setPrototypeOf(increments, [0]);
    if (kind === 'undefined') Reflect.set(increments, '3', undefined);
    if (kind === 'NaN') increments[3] = NaN;
    if (kind === 'Infinity') increments[3] = Infinity;
    if (kind === '-Infinity') increments[3] = -Infinity;
    if (kind === 'numeric-string') Reflect.set(increments, '3', '0');
    const before = Object.getOwnPropertyDescriptors(increments);
    const actual = buildJointResidualReport({ ...input, increments });
    expect(actual.rows).toEqual([]);
    expect(actual.skipped.map(({ jointId, reason }) => ({ jointId, reason })))
      .toEqual([{ jointId: 'j', reason: 'invalidIncrement' }]);
    expect(actual.branchViolations).toEqual([]);
    expect(Object.getOwnPropertyDescriptors(increments)).toEqual(before);
  });
  it('増分配列は全値が有限でも変数数より短い・長い入力を拒否する', () => {
    const input = fixture('slider', undefined, undefined, true);
    for (const count of [5, 7]) {
      const actual = buildJointResidualReport({ ...input, increments: new Array<number>(count).fill(0) });
      expect(actual.rows).toEqual([]);
      expect(actual.skipped.map((entry) => entry.reason)).toEqual(['invalidIncrement']);
    }
  });
  it('増分配列のdense全0と省略は同じ5行とJacobianを返す', () => {
    const input = fixture('slider', undefined, undefined, true);
    const increments = Object.freeze([0, 0, 0, 0, 0, 0]);
    const dense = report({ ...input, increments });
    expect(dense.rows.map((row) => row.value)).toEqual([0, 0, 0, 0, 0]);
    expect(dense.branchViolations).toEqual([]);
    expect(report(input)).toEqual(dense);
    expect(increments).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it('準備で借用frameを変更せず控えを取る', () => {
    const origin: [number, number, number] = [1, 2, 3];
    const input = fixture('ball', { a: { ...F, origin }, b: F });
    origin[0] = 9;
    expect(input.joints[0].frames.a.origin).toEqual([1, 2, 3]);
  });
  it('非零trialでworld frameを毎回再生成し、試行順に依存しない', () => {
    const input = fixture('slider');
    const trial = { ...input, increments: [0, 0, 0, 0.2, 0.3, -0.1, 0, 0, 0, 0, 0, 0] };
    const first = report(trial);
    report({ ...input, increments: [0, 0, 0, -1, 2, 0.3, 0, 0, 0, 0, 0, 0] });
    expect(report(trial)).toEqual(first);
    expect(lengthVec3([first.rows[0].value, first.rows[1].value, first.rows[2].value])).toBeCloseTo(Math.sqrt(0.14), 12);
  });
  it('πの基準から2π近傍へ向かう特異chartはrotationBranchで断る', () => {
    const input = fixture('slider', undefined, new Map([['a', { ...IDENTITY_PLACEMENT, rotation: [0, 0, 1, 0] }], ['b', IDENTITY_PLACEMENT]]));
    const result = buildJointResidualReport({ ...input, increments: [0, 0, 0, 0, 0, Math.PI - 1e-8, 0, 0, 0, 0, 0, 0] });
    expect(result.rows).toEqual([]);
    expect(result.skipped.map((r) => r.reason)).toEqual(['rotationBranch']);
    expect(report(input).rows[2].value).toBe(Math.PI);
  });
  it('基準から半回転のtrialで持ち上げが同点なら偽のJacobianを返さない', () => {
    const input = fixture('slider');
    const result = buildJointResidualReport({ ...input, increments: [0, 0, 0, 0, 0, Math.PI, 0, 0, 0, 0, 0, 0] });
    expect(result.rows).toEqual([]);
    expect(result.skipped.map((r) => r.reason)).toEqual(['rotationBranch']);
  });
  it.each(['short-rotation', 'overflow-norm', 'short-position', 'sparse-rotation'] as const)('%sはprepareとbuildの両入口でinvalidFrame', (kind) => {
    const position: [number, number, number] = [0, 0, 0];
    const rotation: [number, number, number, number] = [1, 0, 0, 1];
    if (kind === 'short-rotation') rotation.splice(1, 3);
    if (kind === 'overflow-norm') rotation.fill(1e308);
    if (kind === 'short-position') position.pop();
    if (kind === 'sparse-rotation') Reflect.deleteProperty(rotation, '1');
    const input = fixture('slider');
    const placements = new Map(input.placements).set('a', { position, rotation });
    const before = structuredClone(placements);
    const prepared = prepareJointResiduals({ joints: [joint('slider')], frames: new Map([['j', { a: F, b: F }]]), placements });
    const built = buildJointResidualReport({ ...input, placements });
    expect(prepared.joints).toEqual([]);
    expect(prepared.skipped.map((r) => r.reason)).toEqual(['invalidFrame']);
    expect(built.rows).toEqual([]);
    expect(built.skipped.map((r) => r.reason)).toEqual(['invalidFrame']);
    expect(placements).toEqual(before);
  });
  it('空originをprepare/buildが受け付けず、missingFrameと混同しない', () => {
    const origin: [number, number, number] = [0, 0, 0];
    origin.splice(0, 3);
    const input = fixture('ball');
    const frames = { a: { ...F, origin }, b: F };
    const prepared = prepareJointResiduals({ joints: [joint('ball')], frames: new Map([['j', frames]]), placements: input.placements });
    const built = buildJointResidualReport({ ...input, joints: [{ ...input.joints[0], frames }] });
    expect(prepared.skipped.map((r) => r.reason)).toEqual(['invalidFrame']);
    expect(built.skipped.map((r) => r.reason)).toEqual(['invalidFrame']);
    expect(prepared.joints).toEqual([]);
    expect(built.rows).toEqual([]);
  });
});
