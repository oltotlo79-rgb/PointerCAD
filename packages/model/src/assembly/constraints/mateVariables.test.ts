/**
 * 合致の変数・自由度・連結成分の検査(計画書 docs/plans/P7-アセンブリ.md タスク13 の検証表)。
 *
 * 期待値はすべて手で導ける数にしてある(部品 50 個で 1 つ固定なら `6 × 49 = 294`、
 * 上限 600 はちょうど動かせる部品 100 個ぶん、など)。**形も配置も作らない**——
 * `collectMateVariables` はアセンブリ文書だけを読む純関数で、カーネルにもソルバーにも触れない。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { Parameter } from '../../parameters/types.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { assemblyVariables } from '../resolveAssembly.js';
import type {
  AssemblyComponent,
  AssemblyDocument,
  Joint,
  JointKind,
  Mate,
  MateKind,
  MateTarget,
} from '../types.js';
import type { MateTargetKind } from './mateTargets.js';
import {
  coincidentEquationCount,
  collectMateVariables,
  countMateDegreesOfFreedom,
  jointEquationCount,
  MATE_VARIABLE_AXES,
  MATE_VARIABLES_PER_COMPONENT,
  MAX_ASSEMBLY_VARIABLES,
  MAX_MOVABLE_COMPONENTS,
  mateComponentGroups,
  mateEquationCount,
  mateValueOf,
  TOO_MANY_COMPONENTS_MESSAGE,
  type MateVariableSet,
} from './mateVariables.js';

/* ------------------------------------------------------------------ *
 * 材料
 * ------------------------------------------------------------------ */

function componentOf(id: string, overrides: Partial<AssemblyComponent> = {}): AssemblyComponent {
  return {
    id,
    name: id,
    source: { kind: 'part', partRef: 'part-1' },
    placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: false,
    visible: true,
    suppressed: false,
    ...overrides,
  };
}

function assemblyOf(
  components: readonly AssemblyComponent[],
  mates: readonly Mate[] = [],
  joints: readonly Joint[] = [],
  parameters: readonly Parameter[] = [],
): AssemblyDocument {
  return { ...createAssemblyDocument('組立1'), components, mates, joints, parameters };
}

/** 部品を n 個(1 つ目だけ固定)。`component-1` … `component-n`。 */
function componentsFixedFirst(count: number): readonly AssemblyComponent[] {
  return Array.from({ length: count }, (_unused, index) =>
    componentOf(`component-${index + 1}`, { fixed: index === 0 }),
  );
}

/** 合致の対象。部品の原点どうしを指す(この検査は対象の中身を見ない)。 */
function targetOf(componentId: string): MateTarget {
  return { kind: 'origin', componentId, element: 'origin' };
}

function mateOf(
  id: string,
  a: string,
  b: string,
  kind: MateKind = 'parallel',
  overrides: Partial<Mate> = {},
): Mate {
  return {
    id,
    name: id,
    kind,
    a: targetOf(a),
    b: targetOf(b),
    flipped: false,
    suppressed: false,
    ...overrides,
  };
}

function jointOf(id: string, a: string, b: string, kind: JointKind = 'revolute'): Joint {
  return {
    id,
    name: id,
    kind,
    a: targetOf(a),
    b: targetOf(b),
    minValue: null,
    maxValue: null,
    suppressed: false,
  };
}

/** 変数の並びを「部品 id.軸」の文字列にして、丸ごと突き合わせられるようにする。 */
function columnNames(variableSet: MateVariableSet): readonly string[] {
  return variableSet.variables.map((variable) => `${variable.componentId}.${variable.axis}`);
}

/* ------------------------------------------------------------------ *
 * 1. 変数(§2.5.1)
 * ------------------------------------------------------------------ */

describe('collectMateVariables', () => {
  it('上限は変数 600・動かせる部品 100 個(§0.a-0.17)', () => {
    expect(MAX_ASSEMBLY_VARIABLES).toBe(600);
    expect(MATE_VARIABLES_PER_COMPONENT).toBe(6);
    expect(MAX_MOVABLE_COMPONENTS).toBe(100);
  });

  it('部品 2 個(1 つ固定)の変数は 6 個', () => {
    const set = collectMateVariables(assemblyOf(componentsFixedFirst(2)));
    expect(set.variables.length).toBe(6);
    expect(set.movableComponentIds).toEqual(['component-2']);
    expect(set.tooMany).toBe(false);
  });

  it('並び順は components の順 → tx, ty, tz, rx, ry, rz', () => {
    const set = collectMateVariables(assemblyOf(componentsFixedFirst(3)));
    expect(MATE_VARIABLE_AXES).toEqual(['tx', 'ty', 'tz', 'rx', 'ry', 'rz']);
    expect(columnNames(set)).toEqual([
      'component-2.tx',
      'component-2.ty',
      'component-2.tz',
      'component-2.rx',
      'component-2.ry',
      'component-2.rz',
      'component-3.tx',
      'component-3.ty',
      'component-3.tz',
      'component-3.rx',
      'component-3.ry',
      'component-3.rz',
    ]);
  });

  it('部品 50 個(1 つ固定)の変数は 294 個(6 × 49)', () => {
    const set = collectMateVariables(assemblyOf(componentsFixedFirst(50)));
    expect(set.variables.length).toBe(294);
  });

  it('抑制した部品は変数を持たない', () => {
    const set = collectMateVariables(
      assemblyOf([
        componentOf('component-1', { fixed: true }),
        componentOf('component-2', { suppressed: true }),
        componentOf('component-3'),
      ]),
    );
    expect(set.movableComponentIds).toEqual(['component-3']);
    expect(set.frozen.get('component-2')).toBe('suppressed');
    expect(set.columnOf('component-2', 'tx')).toBeNull();
  });

  it('非表示の部品は変数を持つ(見えなくても組み立ての一部)', () => {
    const set = collectMateVariables(
      assemblyOf([
        componentOf('component-1', { fixed: true }),
        componentOf('component-2', { visible: false }),
      ]),
    );
    expect(set.movableComponentIds).toEqual(['component-2']);
    expect(set.variables.length).toBe(6);
    expect(set.frozen.has('component-2')).toBe(false);
  });

  it('固定した部品は理由つきで変数から外れる(FR-602)', () => {
    const set = collectMateVariables(assemblyOf(componentsFixedFirst(2)));
    expect(set.frozen.get('component-1')).toBe('fixed');
    expect(set.columnOf('component-1', 'tx')).toBeNull();
  });

  it('部品 101 個(1 つ固定)は変数 600 でちょうど上限を通る', () => {
    const set = collectMateVariables(assemblyOf(componentsFixedFirst(101)));
    expect(set.variables.length).toBe(600);
    expect(set.tooMany).toBe(false);
  });

  it('部品 102 個(変数 606)は断る', () => {
    const set = collectMateVariables(assemblyOf(componentsFixedFirst(102)));
    expect(set.variables.length).toBe(606);
    expect(set.tooMany).toBe(true);
  });

  it('多すぎるときの文言は §2.12 のまま', () => {
    expect(TOO_MANY_COMPONENTS_MESSAGE).toBe(
      '組める部品が多すぎます(上限 100 個)。組を入れ子にして分けてください。',
    );
  });

  it('2 回呼んでも変数の並びが同じ(決定性)', () => {
    const assembly = assemblyOf(componentsFixedFirst(8));
    expect(columnNames(collectMateVariables(assembly))).toEqual(
      columnNames(collectMateVariables(assembly)),
    );
  });

  it('columnOf と componentOf が往復する', () => {
    const set = collectMateVariables(assemblyOf(componentsFixedFirst(3)));
    const column = set.columnOf('component-3', 'rz');
    expect(column).toBe(11);
    expect(column === null ? null : set.componentOf(column)).toBe('component-3');
    expect(set.columnOf('component-2', 'tx')).toBe(0);
  });

  it('componentOf は範囲の外で null', () => {
    const set = collectMateVariables(assemblyOf(componentsFixedFirst(2)));
    expect(set.componentOf(-1)).toBeNull();
    expect(set.componentOf(6)).toBeNull();
    expect(set.componentOf(0)).toBe('component-2');
  });

  it('初期値は全部 0(変数はいまの配置からの増分)', () => {
    const set = collectMateVariables(assemblyOf(componentsFixedFirst(4)));
    expect(set.initial.length).toBe(set.variables.length);
    expect(set.initial.every((value) => value === 0)).toBe(true);
  });

  it('部品が 1 つも無ければ変数も 0 個', () => {
    const set = collectMateVariables(assemblyOf([]));
    expect(set.variables).toEqual([]);
    expect(mateComponentGroups(set, [], [])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 合致の値(§0.a-0.9)
 * ------------------------------------------------------------------ */

describe('mateValueOf', () => {
  const parameter = (name: string, source: string, value: number): Parameter => ({
    name,
    value: { source, value, display: `${value}` },
    unit: 'mm',
    description: '',
  });

  it('アセンブリのパラメータ表で式を数にする', () => {
    const assembly = assemblyOf([componentOf('component-1')], [], [], [parameter('隙間', '3', 3)]);
    const value: ExpressionValue = { source: '隙間 * 2', value: 0, display: '0' };
    expect(mateValueOf(value, assemblyVariables(assembly))).toBe(6);
  });

  it('欄が無ければ null', () => {
    expect(mateValueOf(undefined, new Map())).toBeNull();
    expect(mateValueOf(null, new Map())).toBeNull();
  });

  it('評価できない式は保存された評価値を使う', () => {
    const value: ExpressionValue = { source: '知らない名前', value: 12.5, display: '12.5' };
    expect(mateValueOf(value, new Map())).toBe(12.5);
  });

  it('数にならなければ null(NaN を残差へ流さない)', () => {
    const value: ExpressionValue = { source: '知らない名前', value: Number.NaN, display: '' };
    expect(mateValueOf(value, new Map())).toBeNull();
  });

  it('数値リテラルはそのまま', () => {
    expect(mateValueOf(expressionValueFromNumber(-1), new Map())).toBe(-1);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 式の本数(§2.5.2、§2.6)
 * ------------------------------------------------------------------ */

describe('mateEquationCount', () => {
  it('平行・接線は 2 本、同心は 4 本、距離・角度は 1 本', () => {
    expect(mateEquationCount('parallel', null)).toBe(2);
    expect(mateEquationCount('concentric', null)).toBe(4);
    expect(mateEquationCount('distance', null)).toBe(1);
    expect(mateEquationCount('angle', null)).toBe(1);
    expect(mateEquationCount('tangent', null)).toBe(2);
  });

  it('一致は対象の種類で本数が変わる(面と面 3・点と点 3・点と面 1)', () => {
    expect(coincidentEquationCount('plane', 'plane')).toBe(3);
    expect(coincidentEquationCount('point', 'point')).toBe(3);
    expect(coincidentEquationCount('point', 'plane')).toBe(1);
    expect(coincidentEquationCount('plane', 'point')).toBe(1);
    expect(mateEquationCount('coincident', ['plane', 'plane'])).toBe(3);
  });

  it('一致は対象の種類が分からないと数えられない', () => {
    expect(mateEquationCount('coincident', null)).toBeNull();
  });

  it('ジョイントは回転 5・スライド 5・円筒 4・球 3(§2.6)', () => {
    expect(jointEquationCount('revolute')).toBe(5);
    expect(jointEquationCount('slider')).toBe(5);
    expect(jointEquationCount('cylindrical')).toBe(4);
    expect(jointEquationCount('ball')).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 自由度(§2.5.5)
 * ------------------------------------------------------------------ */

describe('countMateDegreesOfFreedom', () => {
  it('部品 2 個(1 つ固定)に同心 1 本で残りは 2', () => {
    const assembly = assemblyOf(componentsFixedFirst(2), [
      mateOf('mate-1', 'component-1', 'component-2', 'concentric'),
    ]);
    const set = collectMateVariables(assembly);
    const count = countMateDegreesOfFreedom(set, assembly.mates, assembly.joints);
    expect(count.variables).toBe(6);
    expect(count.equations).toBe(4);
    expect(count.ground).toBe(0);
    expect(count.remaining).toBe(2);
    expect(count.excess).toBe(0);
  });

  it('回転ジョイント 1 つなら残りは 1(§6.7 の検算)', () => {
    const assembly = assemblyOf(
      componentsFixedFirst(2),
      [],
      [jointOf('joint-1', 'component-1', 'component-2')],
    );
    const set = collectMateVariables(assembly);
    expect(countMateDegreesOfFreedom(set, assembly.mates, assembly.joints).remaining).toBe(1);
  });

  it('固定が 1 つも無ければ 6 を引いて数える(§0.a-0.20)', () => {
    const assembly = assemblyOf([componentOf('component-1'), componentOf('component-2')], [
      mateOf('mate-1', 'component-1', 'component-2', 'concentric'),
    ]);
    const set = collectMateVariables(assembly);
    const count = countMateDegreesOfFreedom(set, assembly.mates, assembly.joints);
    expect(count.variables).toBe(12);
    expect(count.ground).toBe(6);
    expect(count.remaining).toBe(2);
  });

  it('式が多すぎる分は excess に出て、remaining は負にならない', () => {
    const assembly = assemblyOf(componentsFixedFirst(2), [
      mateOf('mate-1', 'component-1', 'component-2', 'concentric'),
      mateOf('mate-2', 'component-1', 'component-2', 'concentric'),
    ]);
    const set = collectMateVariables(assembly);
    const count = countMateDegreesOfFreedom(set, assembly.mates, assembly.joints);
    expect(count.equations).toBe(8);
    expect(count.remaining).toBe(0);
    expect(count.excess).toBe(2);
  });

  it('抑制した合致は数えず、理由を残す(FR-503)', () => {
    const assembly = assemblyOf(componentsFixedFirst(2), [
      mateOf('mate-1', 'component-1', 'component-2', 'concentric', { suppressed: true }),
    ]);
    const set = collectMateVariables(assembly);
    const count = countMateDegreesOfFreedom(set, assembly.mates, assembly.joints);
    expect(count.equations).toBe(0);
    expect(count.skipped).toEqual([{ id: 'mate-1', reason: 'suppressed' }]);
  });

  it('固定どうしの合致は数えない(動かせる数を 1 つも含まない)', () => {
    const assembly = assemblyOf(
      [
        componentOf('component-1', { fixed: true }),
        componentOf('component-2', { fixed: true }),
        componentOf('component-3'),
      ],
      [mateOf('mate-1', 'component-1', 'component-2', 'concentric')],
    );
    const set = collectMateVariables(assembly);
    const count = countMateDegreesOfFreedom(set, assembly.mates, assembly.joints);
    expect(count.equations).toBe(0);
    expect(count.skipped).toEqual([{ id: 'mate-1', reason: 'grounded' }]);
  });

  it('一致は対象の種類が分かるときだけ数える(消さずに理由を残す)', () => {
    const assembly = assemblyOf(componentsFixedFirst(2), [
      mateOf('mate-1', 'component-1', 'component-2', 'coincident'),
    ]);
    const set = collectMateVariables(assembly);
    const without = countMateDegreesOfFreedom(set, assembly.mates, assembly.joints);
    expect(without.equations).toBe(0);
    expect(without.skipped).toEqual([{ id: 'mate-1', reason: 'unknownTargets' }]);

    const targetKinds = new Map<string, readonly [MateTargetKind, MateTargetKind]>([
      ['mate-1', ['plane', 'plane']],
    ]);
    const withKinds = countMateDegreesOfFreedom(set, assembly.mates, assembly.joints, {
      targetKinds,
    });
    expect(withKinds.equations).toBe(3);
    expect(withKinds.skipped).toEqual([]);
    expect(withKinds.remaining).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * 5. 連結成分(§2.5.3、§0.a-0.18)
 * ------------------------------------------------------------------ */

describe('mateComponentGroups', () => {
  it('合致が 1 本も無い 5 部品は 5 つの成分', () => {
    const assembly = assemblyOf(
      Array.from({ length: 5 }, (_unused, index) => componentOf(`component-${index + 1}`)),
    );
    const groups = mateComponentGroups(collectMateVariables(assembly), [], []);
    expect(groups.length).toBe(5);
    expect(groups.map((group) => group.componentIds)).toEqual([
      ['component-1'],
      ['component-2'],
      ['component-3'],
      ['component-4'],
      ['component-5'],
    ]);
  });

  it('A-B、C-D、E の 5 部品は 3 つの成分', () => {
    const assembly = assemblyOf(
      Array.from({ length: 5 }, (_unused, index) => componentOf(`component-${index + 1}`)),
      [
        mateOf('mate-1', 'component-1', 'component-2'),
        mateOf('mate-2', 'component-3', 'component-4'),
      ],
    );
    const groups = mateComponentGroups(
      collectMateVariables(assembly),
      assembly.mates,
      assembly.joints,
    );
    expect(groups.map((group) => group.componentIds)).toEqual([
      ['component-1', 'component-2'],
      ['component-3', 'component-4'],
      ['component-5'],
    ]);
    expect(groups.map((group) => group.mateIds)).toEqual([['mate-1'], ['mate-2'], []]);
  });

  it('固定 F と A、F と B は 2 つの成分(固定への辺は無視する)', () => {
    const assembly = assemblyOf(
      [
        componentOf('component-1', { fixed: true }),
        componentOf('component-2'),
        componentOf('component-3'),
      ],
      [
        mateOf('mate-1', 'component-1', 'component-2'),
        mateOf('mate-2', 'component-1', 'component-3'),
      ],
    );
    const groups = mateComponentGroups(
      collectMateVariables(assembly),
      assembly.mates,
      assembly.joints,
    );
    expect(groups.map((group) => group.componentIds)).toEqual([
      ['component-2'],
      ['component-3'],
    ]);
    // 地面への合致も、動かせる側の塊で解く(式そのものは効く)。
    expect(groups.map((group) => group.mateIds)).toEqual([['mate-1'], ['mate-2']]);
  });

  it('成分の順序は components の順で決まる(辺をつなぐ順に依らない)', () => {
    const components = Array.from({ length: 4 }, (_unused, index) =>
      componentOf(`component-${index + 1}`),
    );
    const forward = assemblyOf(components, [
      mateOf('mate-1', 'component-2', 'component-4'),
      mateOf('mate-2', 'component-1', 'component-3'),
    ]);
    const backward = assemblyOf(components, [
      mateOf('mate-2', 'component-3', 'component-1'),
      mateOf('mate-1', 'component-4', 'component-2'),
    ]);
    const shape = (assembly: AssemblyDocument): readonly (readonly string[])[] =>
      mateComponentGroups(
        collectMateVariables(assembly),
        assembly.mates,
        assembly.joints,
      ).map((group) => group.componentIds);
    expect(shape(forward)).toEqual([
      ['component-1', 'component-3'],
      ['component-2', 'component-4'],
    ]);
    expect(shape(backward)).toEqual(shape(forward));
  });

  it('抑制した合致は辺にならない', () => {
    const assembly = assemblyOf(
      [componentOf('component-1'), componentOf('component-2')],
      [mateOf('mate-1', 'component-1', 'component-2', 'parallel', { suppressed: true })],
    );
    const groups = mateComponentGroups(
      collectMateVariables(assembly),
      assembly.mates,
      assembly.joints,
    );
    expect(groups.length).toBe(2);
    expect(groups.every((group) => group.mateIds.length === 0)).toBe(true);
  });

  it('ジョイントも辺になる', () => {
    const assembly = assemblyOf(
      [componentOf('component-1'), componentOf('component-2'), componentOf('component-3')],
      [],
      [jointOf('joint-1', 'component-1', 'component-3')],
    );
    const groups = mateComponentGroups(
      collectMateVariables(assembly),
      assembly.mates,
      assembly.joints,
    );
    expect(groups.map((group) => group.componentIds)).toEqual([
      ['component-1', 'component-3'],
      ['component-2'],
    ]);
    expect(groups.map((group) => group.jointIds)).toEqual([['joint-1'], []]);
  });

  it('鎖のようにつながった 4 部品は 1 つの成分', () => {
    const assembly = assemblyOf(
      Array.from({ length: 4 }, (_unused, index) => componentOf(`component-${index + 1}`)),
      [
        mateOf('mate-1', 'component-4', 'component-3'),
        mateOf('mate-2', 'component-3', 'component-2'),
        mateOf('mate-3', 'component-2', 'component-1'),
      ],
    );
    const groups = mateComponentGroups(
      collectMateVariables(assembly),
      assembly.mates,
      assembly.joints,
    );
    expect(groups.length).toBe(1);
    expect(groups[0].componentIds).toEqual([
      'component-1',
      'component-2',
      'component-3',
      'component-4',
    ]);
    expect(groups[0].mateIds).toEqual(['mate-1', 'mate-2', 'mate-3']);
  });

  it('消された部品を指す合致は辺にならない(投げない。FR-504)', () => {
    const assembly = assemblyOf(
      [componentOf('component-1'), componentOf('component-2')],
      [mateOf('mate-1', 'component-1', 'component-9')],
    );
    const groups = mateComponentGroups(
      collectMateVariables(assembly),
      assembly.mates,
      assembly.joints,
    );
    expect(groups.map((group) => group.componentIds)).toEqual([
      ['component-1'],
      ['component-2'],
    ]);
    expect(groups.map((group) => group.mateIds)).toEqual([['mate-1'], []]);
  });
});
