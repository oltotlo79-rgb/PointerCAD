import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { createEmptyPartDocument, PART_SCHEMA_VERSION } from '../part/createPartDocument.js';

import {
  ASSEMBLY_SCHEMA_VERSION,
  BOM_COLUMN_IDS,
  createAssemblyDocument,
  DEFAULT_ASSEMBLY_NAME,
  DEFAULT_BOM_SETTINGS,
  DEFAULT_COMPONENT_PLACEMENT,
  JOINT_KINDS,
  MATE_KINDS,
  nextComponentId,
  nextJointId,
  nextMateId,
  nextPresentationStepId,
  STANDARD_CATALOG_IDS,
} from './createAssemblyDocument.js';
import type { AssemblyComponent, AssemblyDocument, Joint, Mate, PresentationStep } from './types.js';

/** 採番と不変性の検査だけに使う、置いた部品 1 つ。形は見ないので出どころは名前だけ。 */
function componentWithId(id: string): AssemblyComponent {
  return {
    id,
    name: `ブラケット:${id}`,
    source: { kind: 'part', partRef: 'part-1' },
    placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: false,
    visible: true,
    suppressed: false,
  };
}

/** 部品を末尾へ足した新しい文書(履歴操作そのものは P7 タスク7 の `assemblyEdit.ts` の担当)。 */
function withComponent(document: AssemblyDocument, id: string): AssemblyDocument {
  return { ...document, components: [...document.components, componentWithId(id)] };
}

/** 1 つを取り除いた新しい文書。 */
function withoutComponent(document: AssemblyDocument, id: string): AssemblyDocument {
  return {
    ...document,
    components: document.components.filter((component) => component.id !== id),
  };
}

function mateWithId(id: string): Mate {
  return {
    id,
    name: id,
    kind: 'coincident',
    a: { kind: 'origin', componentId: 'component-1', element: 'xy' },
    b: { kind: 'origin', componentId: 'component-2', element: 'xy' },
    flipped: false,
    suppressed: false,
  };
}

function jointWithId(id: string): Joint {
  return {
    id,
    name: id,
    kind: 'revolute',
    a: { kind: 'origin', componentId: 'component-1', element: 'z' },
    b: { kind: 'origin', componentId: 'component-2', element: 'z' },
    minValue: null,
    maxValue: null,
    suppressed: false,
  };
}

function stepWithId(id: string): PresentationStep {
  return {
    id,
    name: id,
    start: 0,
    end: 1,
    body: {
      kind: 'explode',
      componentIds: ['component-1'],
      direction: { kind: 'world', axis: 'z' },
      distance: expressionValueFromNumber(50),
    },
  };
}

describe('createAssemblyDocument', () => {
  it('部品を 1 つも置いていない空の文書を返す', () => {
    const document = createAssemblyDocument('組立');
    expect(document.components).toHaveLength(0);
    expect(document.mates).toHaveLength(0);
    expect(document.joints).toHaveLength(0);
    expect(document.presentation).toHaveLength(0);
    expect(document.parameters).toHaveLength(0);
  });

  it('渡した名前をそのまま持ち、id は assembly-1', () => {
    const document = createAssemblyDocument('組立');
    expect(document.name).toBe('組立');
    expect(document.id).toBe('assembly-1');
    // 既定の名前もドキュメントの既定データとして持つ(UI 文字列とは別扱い)。
    expect(createAssemblyDocument(DEFAULT_ASSEMBLY_NAME).name).toBe('組立1');
  });

  it('保存形式の版は部品と同じ系列(§0.a-0.2)', () => {
    // 版の系列を分けないので、部品の版と必ず同じ数になる。数を写して 2 か所に持たない。
    expect(ASSEMBLY_SCHEMA_VERSION).toBe(PART_SCHEMA_VERSION);
    expect(createAssemblyDocument('組立').schemaVersion).toBe(PART_SCHEMA_VERSION);
  });

  it('部品表の既定は 5 列・番号順・サブアセンブリを展開しない(§0.a-0.38)', () => {
    const document = createAssemblyDocument('組立');
    expect(document.bom).toEqual(DEFAULT_BOM_SETTINGS);
    expect(document.bom.columns).toEqual(['number', 'name', 'quantity', 'material', 'mass']);
    expect(document.bom.sortBy).toBe('number');
    expect(document.bom.expandSubAssemblies).toBe(false);
  });

  it('アセンブリ文書は名前付き視点を含む10欄(P8-60)', () => {
    // 欄が増減したらここで気づけるようにする(io の読み書きが版と一緒に動くため)。
    expect(Object.keys(createAssemblyDocument('組立')).sort()).toEqual([
      'bom',
      'components',
      'id',
      'joints',
      'mates',
      'name',
      'namedViews',
      'parameters',
      'presentation',
      'schemaVersion',
    ]);
  });

  it('部品文書は承認した名前付き視点と構成を含む14欄(P8-60・62)', () => {
    /*
      P7 はアセンブリの型を新しく作るだけで、部品文書の欄を 1 つも増やさない。

      **実測 11 欄**(2026-09-06)。計画書タスク1 の検証表は「9 のまま」と書いているが、
      それは P5 完了時点の数で、P6 が `selectionSets`(FR-112)と `canvases`(FR-332)を
      足して 11 になっている(`part/types.ts` の注釈と `PART_SCHEMA_VERSION = 7` の由来)。
      期待値を緩めているのではなく、**P7 の着手時点の現在値**を固定している。
    */
    // P8の承認済み追加: namedViews / configurations / activeConfigurationId。
    expect(Object.keys(createEmptyPartDocument()).sort()).toEqual([
      'activeConfigurationId',
      'activeSketchId',
      'appearance',
      'canvases',
      'configurations',
      'id',
      'name',
      'namedViews',
      'parameters',
      'references',
      'schemaVersion',
      'selectionSets',
      'sketches',
      'solids',
    ]);
  });

  it('呼ぶたびに別の配列を返す(前の文書と入れ物を共有しない)', () => {
    const first = createAssemblyDocument('組立');
    const second = createAssemblyDocument('組立');
    expect(second).not.toBe(first);
    expect(second.components).not.toBe(first.components);
  });
});

describe('配置の既定', () => {
  it('位置は原点(0, 0, 0)で、式のまま持つ', () => {
    expect(DEFAULT_COMPONENT_PLACEMENT.position).toHaveLength(3);
    for (const coordinate of DEFAULT_COMPONENT_PLACEMENT.position) {
      expect(coordinate.value).toBe(0);
      expect(coordinate.source).toBe('0');
    }
  });

  it('向きは単位四元数 [0, 0, 0, 1] で、長さ 1・qw >= 0', () => {
    expect(DEFAULT_COMPONENT_PLACEMENT.rotation).toEqual([0, 0, 0, 1]);
    const [qx, qy, qz, qw] = DEFAULT_COMPONENT_PLACEMENT.rotation;
    expect(Math.hypot(qx, qy, qz, qw)).toBe(1);
    // 同じ回転を表す −q と取り違えないよう、保存する向きは qw >= 0 に揃える(§0.a-0.54)。
    expect(qw).toBeGreaterThanOrEqual(0);
  });
});

describe('採番', () => {
  it('空の文書の次の部品は component-1', () => {
    expect(nextComponentId(createAssemblyDocument('組立'))).toBe('component-1');
  });

  it('置くたびに component-1 / component-2 / component-3 と続く', () => {
    let document = createAssemblyDocument('組立');
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const id = nextComponentId(document);
      ids.push(id);
      document = withComponent(document, id);
    }
    expect(ids).toEqual(['component-1', 'component-2', 'component-3']);
  });

  it('途中を消しても番号を再利用しない(3 つ置いて 2 つ目を消すと次は component-4)', () => {
    let document = createAssemblyDocument('組立');
    document = withComponent(document, 'component-1');
    document = withComponent(document, 'component-2');
    document = withComponent(document, 'component-3');
    document = withoutComponent(document, 'component-2');
    expect(document.components).toHaveLength(2);
    expect(nextComponentId(document)).toBe('component-4');
  });

  it('全部消せば component-1 に戻る(重複する相手がいないため)', () => {
    let document = createAssemblyDocument('組立');
    document = withComponent(document, 'component-1');
    document = withoutComponent(document, 'component-1');
    expect(nextComponentId(document)).toBe('component-1');
  });

  it('合致・ジョイント・ステップも同じ方式で採番する', () => {
    const document = createAssemblyDocument('組立');
    expect(nextMateId(document)).toBe('mate-1');
    expect(nextJointId(document)).toBe('joint-1');
    expect(nextPresentationStepId(document)).toBe('step-1');

    const filled: AssemblyDocument = {
      ...document,
      mates: [mateWithId('mate-1'), mateWithId('mate-2')],
      joints: [jointWithId('joint-1')],
      presentation: [stepWithId('step-1'), stepWithId('step-2'), stepWithId('step-3')],
    };
    expect(nextMateId(filled)).toBe('mate-3');
    expect(nextJointId(filled)).toBe('joint-2');
    expect(nextPresentationStepId(filled)).toBe('step-4');
  });

  it('別の種類の id は数に入れない', () => {
    const document: AssemblyDocument = {
      ...createAssemblyDocument('組立'),
      mates: [mateWithId('mate-7')],
    };
    // 合致が 7 番まであっても、部品の採番はそれに引きずられない。
    expect(nextComponentId(document)).toBe('component-1');
    expect(nextMateId(document)).toBe('mate-8');
  });
});

describe('不変性', () => {
  it('部品を足した結果は新しい配列で、元の文書は変わらない', () => {
    const document = createAssemblyDocument('組立');
    const next = withComponent(document, nextComponentId(document));
    expect(next.components).toHaveLength(1);
    expect(document.components).toHaveLength(0);
    expect(next.components).not.toBe(document.components);
    expect(next).not.toBe(document);
  });

  it('部品を消した結果も新しい配列で、元の文書は変わらない', () => {
    const document = withComponent(createAssemblyDocument('組立'), 'component-1');
    const next = withoutComponent(document, 'component-1');
    expect(document.components).toHaveLength(1);
    expect(next.components).toHaveLength(0);
    expect(next.components).not.toBe(document.components);
  });
});

describe('種類の一覧', () => {
  it('合致は 6 種(§0.a-0.13。固定は部品の欄が持つので入れない)', () => {
    expect(MATE_KINDS).toEqual([
      'coincident',
      'concentric',
      'distance',
      'angle',
      'parallel',
      'tangent',
    ]);
    expect(new Set(MATE_KINDS).size).toBe(MATE_KINDS.length);
  });

  it('ジョイントは 4 種(§0.a-0.22)', () => {
    expect(JOINT_KINDS).toEqual(['revolute', 'slider', 'cylindrical', 'ball']);
    expect(new Set(JOINT_KINDS).size).toBe(JOINT_KINDS.length);
  });

  it('規格部品は 9 種で、重複が無い(§0.a-0.32)', () => {
    expect(STANDARD_CATALOG_IDS).toHaveLength(10);
    expect(new Set(STANDARD_CATALOG_IDS).size).toBe(STANDARD_CATALOG_IDS.length);
    expect(STANDARD_CATALOG_IDS).toContain('hexBolt');
    expect(STANDARD_CATALOG_IDS).toContain('deepGrooveBallBearing');
    expect(STANDARD_CATALOG_IDS).toContain('panHeadScrew');
  });

  it('部品表の列は 5 つで、重複が無い(§0.a-0.38)', () => {
    expect(BOM_COLUMN_IDS).toContain('configuration');
    expect(DEFAULT_BOM_SETTINGS.columns).not.toContain('configuration');
    expect(new Set(BOM_COLUMN_IDS).size).toBe(BOM_COLUMN_IDS.length);
  });
});
