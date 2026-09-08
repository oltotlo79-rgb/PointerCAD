/**
 * アセンブリの木の行の組み立ての検査(計画書 P7 タスク9 の検証表)。
 *
 * いちばん大事なのは**兄弟の `key` が必ず食い違う**こと(`rules/06` 10.9。重なると
 * 消したはずの行が DOM に残る)。部品の id と合致の id をわざと同じにした文書でも
 * 食い違うことを、機械的に固定する。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent,
  createAssemblyDocument,
  createComponentFor,
  DEFAULT_ASSEMBLY_NAME,
  setComponentSuppressed,
  setFixed,
  setVisible,
  type AssemblyDocument,
  type AssemblyError,
  type Joint,
  type Mate,
  type MateTarget,
  type PresentationStep,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS } from '../i18n/t.js';
import {
  assemblyRowKey,
  assemblyTreeRowCount,
  assemblyTreeRows,
  ASSEMBLY_BADGE_LABEL_KEYS,
  ASSEMBLY_BADGE_TOOLTIP_KEYS,
  type AssemblyTreeDiagnosis,
  type AssemblyTreeSection,
} from './assemblyTreeRows.js';

/** 部品を `count` 個置いた文書(本番と同じ道筋: 作る → 足す)。 */
function assemblyWith(count: number): AssemblyDocument {
  let document = createAssemblyDocument(DEFAULT_ASSEMBLY_NAME);
  for (let index = 0; index < count; index += 1) {
    document = addComponent(
      document,
      createComponentFor(document, { kind: 'part', partRef: 'part-1' }, { partName: 'ブラケット' }),
    );
  }
  return document;
}

function originTarget(componentId: string): MateTarget {
  return { kind: 'origin', componentId, element: 'origin' };
}

/** 合致 1 本。既定は部品 1 と部品 2 の原点どうしの一致。 */
function mate(overrides: Partial<Mate> = {}): Mate {
  return {
    id: 'mate-1',
    name: '一致1',
    kind: 'coincident',
    a: originTarget('component-1'),
    b: originTarget('component-2'),
    flipped: false,
    suppressed: false,
    ...overrides,
  };
}

function joint(overrides: Partial<Joint> = {}): Joint {
  return {
    id: 'joint-1',
    name: '回転1',
    kind: 'revolute',
    a: originTarget('component-1'),
    b: originTarget('component-2'),
    minValue: null,
    maxValue: null,
    suppressed: false,
    ...overrides,
  };
}

function explodeStep(componentIds: readonly string[]): PresentationStep {
  return {
    id: 'step-1',
    name: '分解1',
    start: 0,
    end: 1,
    body: {
      kind: 'explode',
      componentIds,
      direction: { kind: 'world', axis: 'x' },
      distance: expressionValueFromNumber(50),
    },
  };
}

function jointStep(jointId: string): PresentationStep {
  return {
    id: 'step-2',
    name: '回す1',
    start: 0,
    end: 1,
    body: {
      kind: 'joint',
      jointId,
      from: expressionValueFromNumber(0),
      to: expressionValueFromNumber(90),
    },
  };
}

/** 解いた結果の代わり(中身を引けた部品だけを `partKeys` に入れる)。 */
function diagnosisFor(
  resolvedComponentIds: readonly string[],
  errors: readonly AssemblyError[] = [],
  conflictingIds?: readonly string[],
): AssemblyTreeDiagnosis {
  return {
    partKeys: new Map(resolvedComponentIds.map((id) => [id, 'part-1'])),
    errors,
    conflictingIds: conflictingIds === undefined ? undefined : new Set(conflictingIds),
  };
}

/** 木に出る全部の `key`(束の見出しと行)を 1 本に並べる。 */
function allKeys(sections: readonly AssemblyTreeSection[]): readonly string[] {
  return sections.flatMap((section) => [section.key, ...section.rows.map((row) => row.key)]);
}

describe('assemblyTreeRows(束の並び)', () => {
  it('束は必ず 4 つ(部品・合致・ジョイント・分解ステップ)返る', () => {
    const sections = assemblyTreeRows(createAssemblyDocument(DEFAULT_ASSEMBLY_NAME));

    expect(sections.map((section) => section.key)).toEqual(['component', 'mate', 'joint', 'step']);
  });

  it('空のアセンブリでは束 4 つだけが出る(NFR-UX-6)', () => {
    const sections = assemblyTreeRows(createAssemblyDocument(DEFAULT_ASSEMBLY_NAME));

    expect(sections.every((section) => section.rows.length === 0)).toBe(true);
    expect(assemblyTreeRowCount(sections)).toBe(4);
  });

  it('部品 2 つ・合致 1 本の行数は 7(束の見出しも行)', () => {
    const document = { ...assemblyWith(2), mates: [mate()] };

    expect(assemblyTreeRowCount(assemblyTreeRows(document))).toBe(4 + 2 + 1);
  });

  it('並びは文書の順のままで、2 回呼んでも同じ木になる(§0.a-0.54)', () => {
    const document = { ...assemblyWith(3), mates: [mate()] };
    const first = assemblyTreeRows(document);

    expect(first[0].rows.map((row) => row.id)).toEqual([
      'component-1',
      'component-2',
      'component-3',
    ]);
    expect(assemblyTreeRows(document)).toEqual(first);
  });

  it('サブアセンブリの中の部品を親行の子として出す(FR-613)', () => {
    let parent = createAssemblyDocument('親');
    parent = addComponent(
      parent,
      createComponentFor(parent, { kind: 'subAssembly', assemblyRef: 'assembly-1' }, {
        partName: '子組',
      }),
    );
    const child = assemblyWith(2);
    const childDiagnosis = diagnosisFor(['component-1', 'component-2']);
    const diagnosis: AssemblyTreeDiagnosis = {
      partKeys: new Map([['component-1', 'assembly-1']]),
      errors: [],
      subAssemblies: new Map([['component-1', { assembly: child, resolved: childDiagnosis }]]),
    };

    expect(assemblyTreeRows(parent, diagnosis)[0].rows[0].children?.map((row) => row.name))
      .toEqual(['ブラケット:1', 'ブラケット:2']);
  });

  it('入れ子のidとkeyには親からの経路を含める(rules/06 10.9)', () => {
    let parent = createAssemblyDocument('親');
    parent = addComponent(
      parent,
      createComponentFor(parent, { kind: 'subAssembly', assemblyRef: 'assembly-1' }),
    );
    const child = assemblyWith(1);
    const diagnosis: AssemblyTreeDiagnosis = {
      partKeys: new Map([['component-1', 'assembly-1']]),
      errors: [],
      subAssemblies: new Map([['component-1', {
        assembly: child,
        resolved: diagnosisFor(['component-1']),
      }]]),
    };
    const nested = assemblyTreeRows(parent, diagnosis)[0].rows[0].children?.[0];

    expect(nested?.id).toBe('component-1/component-1');
    expect(nested?.key).toBe('component:component-1/component-1');
  });

  it('同じ子組を2つ置いても入れ子の兄弟keyが食い違う', () => {
    let parent = createAssemblyDocument('親');
    for (let index = 0; index < 2; index += 1) {
      parent = addComponent(
        parent,
        createComponentFor(parent, { kind: 'subAssembly', assemblyRef: 'assembly-1' }),
      );
    }
    const child = assemblyWith(1);
    const resolvedChild = diagnosisFor(['component-1']);
    const diagnosis: AssemblyTreeDiagnosis = {
      partKeys: new Map([
        ['component-1', 'assembly-1'],
        ['component-2', 'assembly-1'],
      ]),
      errors: [],
      subAssemblies: new Map([
        ['component-1', { assembly: child, resolved: resolvedChild }],
        ['component-2', { assembly: child, resolved: resolvedChild }],
      ]),
    };
    const roots = assemblyTreeRows(parent, diagnosis)[0].rows;
    const nestedKeys = roots.flatMap((row) => row.children?.map((childRow) => childRow.key) ?? []);

    expect(nestedKeys).toEqual([
      'component:component-1/component-1',
      'component:component-2/component-1',
    ]);
    expect(new Set(nestedKeys).size).toBe(2);
  });

  it('木の行数は畳める入れ子の行も数える', () => {
    let parent = createAssemblyDocument('親');
    parent = addComponent(
      parent,
      createComponentFor(parent, { kind: 'subAssembly', assemblyRef: 'assembly-1' }),
    );
    const diagnosis: AssemblyTreeDiagnosis = {
      partKeys: new Map([['component-1', 'assembly-1']]),
      errors: [],
      subAssemblies: new Map([['component-1', {
        assembly: assemblyWith(2),
        resolved: diagnosisFor(['component-1', 'component-2']),
      }]]),
    };

    expect(assemblyTreeRowCount(assemblyTreeRows(parent, diagnosis))).toBe(4 + 1 + 2);
  });

  it('子組を解決できないときは親だけを未解決として残す', () => {
    let parent = createAssemblyDocument('親');
    parent = addComponent(
      parent,
      createComponentFor(parent, { kind: 'subAssembly', assemblyRef: 'missing' }),
    );
    const diagnosis = diagnosisFor([], [{
      componentId: 'component-1',
      code: 'missingPart',
      message: '子組が見つかりません。',
    }]);
    const row = assemblyTreeRows(parent, diagnosis)[0].rows[0];

    expect(row.badges).toContain('unresolved');
    expect(row.errorMessage).toBe('子組が見つかりません。');
    expect(row.children).toBeUndefined();
  });
});

describe('行の key(rules/06 10.9)', () => {
  it('兄弟の key がすべて食い違う', () => {
    const document: AssemblyDocument = {
      ...assemblyWith(2),
      mates: [mate()],
      joints: [joint()],
      presentation: [explodeStep(['component-1']), jointStep('joint-1')],
    };
    const keys = allKeys(assemblyTreeRows(document));

    expect(keys.length).toBe(4 + 2 + 1 + 1 + 2);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('部品と合致に同じ id が付いていても key は食い違う', () => {
    const one = assemblyWith(1);
    const document: AssemblyDocument = {
      ...one,
      mates: [mate({ id: one.components[0].id })],
    };
    const [components, mates] = assemblyTreeRows(document);

    // 壊れたファイルでしか起きないが、起きた瞬間に古い行が残るのが 10.9 の事故。
    expect(components.rows[0].id).toBe(mates.rows[0].id);
    expect(components.rows[0].key).not.toBe(mates.rows[0].key);
    expect(allKeys(assemblyTreeRows(document))).toContain('mate:component-1');
  });

  it('接頭辞の付け方は assemblyRowKey の 1 か所だけ', () => {
    expect(assemblyRowKey('component', 'component-1')).toBe('component:component-1');
    expect(assemblyRowKey('step', 'step-1')).toBe('step:step-1');
  });
});

describe('行の印', () => {
  it('固定した部品には fixed の印が付く(FR-602)', () => {
    const one = assemblyWith(1);
    const [components] = assemblyTreeRows(one);

    // 1 つ目の部品は置いた時点で固定される(§0.a-0.7)。
    expect(components.rows[0].badges).toEqual(['fixed']);
    expect(assemblyTreeRows(setFixed(one, 'component-1', false))[0].rows[0].badges).toEqual([]);
  });

  it('非表示と抑制の印が付き、抑制した行は薄くなる(FR-605、FR-503)', () => {
    const two = assemblyWith(2);
    const hidden = setVisible(two, 'component-2', false);
    const suppressed = setComponentSuppressed(hidden, 'component-2', true);
    const rows = assemblyTreeRows(suppressed)[0].rows;

    expect(assemblyTreeRows(hidden)[0].rows[1].badges).toEqual(['hidden']);
    expect(rows[1].badges).toEqual(['hidden', 'suppressed']);
    expect(rows[1].dimmed).toBe(true);
    expect(rows[0].dimmed).toBe(false);
  });

  it('中身が引けなかった部品には unresolved の印と理由が出る(FR-504)', () => {
    const two = assemblyWith(2);
    const errors: readonly AssemblyError[] = [
      { componentId: 'component-2', code: 'missingPart', message: '部品が見つかりません。' },
    ];
    const rows = assemblyTreeRows(two, diagnosisFor(['component-1'], errors))[0].rows;

    expect(rows[0].badges).toEqual(['fixed']);
    expect(rows[0].errorMessage).toBeNull();
    expect(rows[1].badges).toEqual(['unresolved']);
    expect(rows[1].errorMessage).toBe('部品が見つかりません。');
    expect(rows[1].dimmed).toBe(true);
  });

  it('抑制した部品は解決の対象外なので unresolved にはしない', () => {
    const suppressed = setComponentSuppressed(assemblyWith(2), 'component-2', true);
    // 抑制した部品は `partKeys` に入らない(`resolveAssembly` が飛ばす)。
    const rows = assemblyTreeRows(suppressed, diagnosisFor(['component-1']))[0].rows;

    expect(rows[1].badges).toEqual(['suppressed']);
  });

  it('消えた部品を指す合致には unresolved の印が付く(§0.a-0.40)', () => {
    const document = { ...assemblyWith(1), mates: [mate()] };
    const [, mates] = assemblyTreeRows(document);

    // 相手(component-2)が文書に無い。診断が無くても文書だけで分かる。
    expect(mates.rows[0].badges).toEqual(['unresolved']);
    expect(mates.rows[0].dimmed).toBe(true);
    expect(assemblyTreeRows({ ...assemblyWith(2), mates: [mate()] })[1].rows[0].badges).toEqual([]);
  });

  it('いま中身が引けていない部品を指す合致も未解決になる', () => {
    const document = { ...assemblyWith(2), mates: [mate()] };
    const sections = assemblyTreeRows(document, diagnosisFor(['component-1']));

    expect(sections[1].rows[0].badges).toEqual(['unresolved']);
  });

  it('抑制した合致には suppressed の印が付く', () => {
    const document = { ...assemblyWith(2), mates: [mate({ suppressed: true })] };

    expect(assemblyTreeRows(document)[1].rows[0].badges).toEqual(['suppressed']);
  });

  it('同時に成り立たない合致には conflicting の印が付く(§0.a-0.20)', () => {
    const document = { ...assemblyWith(2), mates: [mate()] };
    const sections = assemblyTreeRows(document, diagnosisFor(['component-1', 'component-2'], [], ['mate-1']));

    expect(sections[1].rows[0].badges).toEqual(['conflicting']);
    // 診断を渡さない間は付かない(P7 タスク16 が入るまで誰も渡さない)。
    expect(assemblyTreeRows(document)[1].rows[0].badges).toEqual([]);
  });

  it('指し先の消えた分解ステップは未解決、揃っていれば印は付かない(FR-617)', () => {
    const two = assemblyWith(2);
    const alive: AssemblyDocument = {
      ...two,
      joints: [joint()],
      presentation: [explodeStep(['component-1', 'component-2']), jointStep('joint-1')],
    };
    const broken: AssemblyDocument = {
      ...two,
      presentation: [explodeStep(['component-1', 'component-9']), jointStep('joint-9')],
    };

    expect(assemblyTreeRows(alive)[3].rows.map((row) => row.badges)).toEqual([[], []]);
    expect(assemblyTreeRows(broken)[3].rows.map((row) => row.badges)).toEqual([
      ['unresolved'],
      ['unresolved'],
    ]);
  });
});

describe('行の種類と文言', () => {
  it('部品の行は出どころごとに種類が分かれる(§0.a-0.35)', () => {
    let document = createAssemblyDocument(DEFAULT_ASSEMBLY_NAME);
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'part-1' }));
    document = addComponent(
      document,
      createComponentFor(document, { kind: 'subAssembly', assemblyRef: 'part-2' }),
    );
    document = addComponent(
      document,
      createComponentFor(document, {
        kind: 'standardPart',
        catalog: 'hexBolt',
        size: 'M10',
        options: {},
        catalogRevision: 'test-catalog',
        generatorRevision: 'test-generator',
      }),
    );

    expect(assemblyTreeRows(document)[0].rows.map((row) => row.kind)).toEqual([
      'part',
      'subAssembly',
      'standardPart',
    ]);
  });

  it('合致・ジョイントの種類の名前は道具の一覧と同じ鍵を引く', () => {
    const document: AssemblyDocument = {
      ...assemblyWith(2),
      mates: [mate({ kind: 'concentric' })],
      joints: [joint({ kind: 'ball' })],
    };
    const sections = assemblyTreeRows(document);

    expect(sections[1].rows[0].kindLabelKey).toBe('assembly.tool.mateConcentric');
    expect(sections[2].rows[0].kindLabelKey).toBe('assembly.tool.jointBall');
  });

  it('束の見出し・空の案内・行の種類・印の鍵がすべて文言の表にある(NFR-MA-5)', () => {
    const document: AssemblyDocument = {
      ...assemblyWith(1),
      mates: [mate()],
      joints: [joint()],
      presentation: [explodeStep(['component-1']), jointStep('joint-1')],
    };
    const known = new Set<string>(MESSAGE_KEYS);
    const used = [
      ...assemblyTreeRows(document).flatMap((section) => [
        section.titleKey,
        section.emptyKey,
        ...section.rows.map((row) => row.kindLabelKey),
      ]),
      ...Object.values(ASSEMBLY_BADGE_LABEL_KEYS),
      ...Object.values(ASSEMBLY_BADGE_TOOLTIP_KEYS),
    ];

    expect(used.filter((key) => !known.has(key))).toEqual([]);
  });
});
