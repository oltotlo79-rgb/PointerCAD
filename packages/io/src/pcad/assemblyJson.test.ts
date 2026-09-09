import {
  ASSEMBLY_SCHEMA_VERSION,
  createAssemblyDocument,
  DEFAULT_BOM_SETTINGS,
  PART_SCHEMA_VERSION,
  type AppearanceSpec,
  type AssemblyComponent,
  type AssemblyDocument,
  type Joint,
  type Mate,
  type PresentationStep,
  type SubShapeRef,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  readAssemblyDocument,
  writeAssemblyDocument,
  type ReadAssemblyDocumentResult,
} from './assemblyJson.js';
import type { ExpressionValueJson } from './guards.js';
import {
  PCAD_APP_NAME,
  PCAD_ASSEMBLY_KIND,
  PCAD_DOCUMENT_KIND,
  PCAD_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  type PcadPartFile,
} from './schema.js';

/** 検査で保存時刻を固定する(時刻が違ってもバイト列が同じであることを確かめるため)。 */
const SAVED_AT = '2026-09-06T01:23:45.678Z';

/** 式文字列と評価値の組(FR-202)。 */
function ev(source: string, value: number): ExpressionValueJson {
  return { source, value, display: String(value) };
}

/** 検査で使う平らな面の指紋(P3 §2.2.2)。合致の対象に取る。 */
function faceRef(bodyFeatureId: string, index: number): SubShapeRef {
  return {
    bodyFeatureId,
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position: [0, 0, 10],
      axis: [0, 0, 1],
      radius: null,
    },
  };
}

/** 原点に置いた、抱き込んだ部品のインスタンス。 */
function component(id: string, partRef: string): AssemblyComponent {
  return {
    id,
    name: `${partRef}:1`,
    source: { kind: 'part', partRef },
    placement: {
      position: [ev('0', 0), ev('0', 0), ev('0', 0)],
      rotation: [0, 0, 0, 1],
    },
    fixed: false,
    visible: true,
    suppressed: false,
  };
}

/** 面どうしの一致 1 本(オフセット 5mm、向かい合わせ)。 */
function mate(): Mate {
  return {
    id: 'mate-1',
    name: '合致1',
    kind: 'coincident',
    a: { kind: 'subShape', componentId: 'component-1', ref: faceRef('extrude-1', 3) },
    b: { kind: 'origin', componentId: 'component-2', element: 'xy' },
    value: ev('5', 5),
    flipped: true,
    suppressed: false,
  };
}

/** 回転ジョイント 1 つ(可動範囲つき)。 */
function joint(): Joint {
  return {
    id: 'joint-1',
    name: 'ジョイント1',
    kind: 'revolute',
    a: { kind: 'subShape', componentId: 'component-1', ref: faceRef('extrude-1', 4) },
    b: { kind: 'origin', componentId: 'component-2', element: 'z' },
    minValue: ev('30', 30),
    maxValue: ev('120', 120),
    suppressed: false,
  };
}

/** 分解のステップ 2 つ(部品を離す + ジョイントを回す)。 */
function presentation(): readonly PresentationStep[] {
  return [
    {
      id: 'step-1',
      name: 'ステップ1',
      start: 0,
      end: 0.5,
      body: {
        kind: 'explode',
        componentIds: ['component-1', 'component-2'],
        direction: { kind: 'world', axis: 'z' },
        distance: ev('40', 40),
      },
    },
    {
      id: 'step-2',
      name: 'ステップ2',
      start: 0.5,
      end: 1,
      body: { kind: 'joint', jointId: 'joint-1', from: ev('0', 0), to: ev('90', 90) },
    },
  ];
}

/** 外観の指定(FR-605 の色分け)。 */
function appearance(): AppearanceSpec {
  return {
    preset: 'steel',
    color: '#8899aa',
    transmission: ev('0', 0),
    gloss: ev('60', 60),
    roughness: ev('30', 30),
    pattern: { kind: 'none' },
  };
}

/** 部品 2 つ・合致 1 本・ジョイント 1 つ・分解 2 段・パラメータ 1 つを持つアセンブリ。 */
function richAssembly(): AssemblyDocument {
  const base = createAssemblyDocument('組立1');
  return {
    ...base,
    components: [
      { ...component('component-1', 'part-1'), fixed: true },
      {
        ...component('component-2', 'part-2'),
        placement: {
          position: [ev('板厚*2', 24), ev('0', 0), ev('10', 10)],
          rotation: [0, 0, 0.7071067811865476, 0.7071067811865476],
        },
        appearance: appearance(),
        materialId: 'steel',
      },
    ],
    mates: [mate()],
    joints: [joint()],
    presentation: presentation(),
    parameters: [{ name: '板厚', value: ev('12', 12), unit: 'mm', description: '板の厚み' }],
  };
}

function expectOk(
  result: ReadAssemblyDocumentResult,
): Extract<ReadAssemblyDocumentResult, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error(`読み込みに失敗しました: ${result.error.code} / ${result.error.message}`);
  }
  return result;
}

function expectError(result: ReadAssemblyDocumentResult): {
  readonly code: string;
  readonly message: string;
} {
  if (result.ok) {
    throw new Error('断るはずの入力を読み込んでしまいました');
  }
  return result.error;
}

/** 封筒の欄を自由に差し替えた document.json の文字列。 */
function rawFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: PCAD_SCHEMA_VERSION,
    kind: PCAD_ASSEMBLY_KIND,
    app: PCAD_APP_NAME,
    savedAt: SAVED_AT,
    document: createAssemblyDocument('組立1'),
    partFiles: [],
    ...overrides,
  });
}

/** 書き出した文字列の中の 1 か所を差し替えて、壊れたファイルを作る。 */
function brokenFile(document: AssemblyDocument, from: string, to: string): string {
  const text = writeAssemblyDocument(document, { savedAt: SAVED_AT });
  expect(text).toContain(from);
  return text.replace(from, to);
}

/** 保存 → 読み込みの往復。 */
function roundTrip(document: AssemblyDocument, partFiles?: readonly PcadPartFile[]): AssemblyDocument {
  return expectOk(readAssemblyDocument(writeAssemblyDocument(document, { savedAt: SAVED_AT, partFiles })))
    .document;
}

describe('アセンブリの封筒と版(P7 タスク3、§0.a-0.1、§0.a-0.2)', () => {
  it('封筒の種別は assembly で、版は部品と同じ系列(10)', () => {
    expect(PCAD_ASSEMBLY_KIND).toBe('assembly');
    expect(PCAD_SCHEMA_VERSION).toBe(10);
    expect(ASSEMBLY_SCHEMA_VERSION).toBe(PART_SCHEMA_VERSION);
    expect(PCAD_SCHEMA_VERSION).toBe(ASSEMBLY_SCHEMA_VERSION);
  });

  it('封筒の欄は schema / kind / app / savedAt / document / partFiles の 6 つ(§2.2)', () => {
    const text = writeAssemblyDocument(createAssemblyDocument('組立1'), { savedAt: SAVED_AT });
    const parsed: unknown = JSON.parse(text);
    expect(Object.keys(parsed as Record<string, unknown>)).toEqual([
      'schema',
      'kind',
      'app',
      'savedAt',
      'document',
      'partFiles',
    ]);
  });

  it('書き出しは版・種別・アプリ名を封筒に書く', () => {
    const text = writeAssemblyDocument(createAssemblyDocument('組立1'), { savedAt: SAVED_AT });
    expect(text).toContain(`"schema": ${String(PCAD_SCHEMA_VERSION)}`);
    expect(text).toContain(`"kind": "${PCAD_ASSEMBLY_KIND}"`);
    expect(text).toContain(`"app": "${PCAD_APP_NAME}"`);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('同じ文書からは必ず同じ文字列ができる(決定的)', () => {
    const document = richAssembly();
    const first = writeAssemblyDocument(document, { savedAt: SAVED_AT });
    const second = writeAssemblyDocument(document, { savedAt: SAVED_AT });
    expect(second).toBe(first);
  });

  it('保存時刻を渡さなければ今の時刻を書く', () => {
    const before = Date.now();
    const text = writeAssemblyDocument(createAssemblyDocument('組立1'));
    const after = Date.now();
    const stamp = /"savedAt": "([^"]+)"/.exec(text);
    expect(stamp).not.toBeNull();
    const at = Date.parse(stamp === null ? '' : stamp[1]);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });
});

describe('アセンブリの往復(FR-601、FR-603、FR-611)', () => {
  it('空のアセンブリは往復しても変わらない', () => {
    const document = createAssemblyDocument('組立1');
    expect(roundTrip(document)).toEqual(document);
  });

  it('部品 2 つ・合致 1 本を持つアセンブリは往復しても変わらない', () => {
    const document: AssemblyDocument = {
      ...createAssemblyDocument('組立1'),
      components: [component('component-1', 'part-1'), component('component-2', 'part-1')],
      mates: [mate()],
    };
    expect(roundTrip(document)).toEqual(document);
  });

  it('ジョイント・分解ステップ・パラメータ・外観・材質まで含めて往復しても変わらない', () => {
    const document = richAssembly();
    expect(roundTrip(document)).toEqual(document);
  });

  it('ジョイント動作の座標と角度の周回基準を省略せず往復する', () => {
    const document: AssemblyDocument = {
      ...richAssembly(),
      presentation: [{
        id: 'step-1', name: '回転', start: 0, end: 1,
        body: {
          kind: 'joint', jointId: 'joint-1', coordinate: 'angle',
          from: ev('350', 350), to: ev('370', 370), referenceAngle: 360,
        },
      }],
    };
    expect(roundTrip(document)).toEqual(document);
  });

  it('往復した文書をもう一度書き出すと 1 文字も変わらない(正規化が終わっている)', () => {
    const document = richAssembly();
    const first = writeAssemblyDocument(document, { savedAt: SAVED_AT });
    const again = writeAssemblyDocument(expectOk(readAssemblyDocument(first)).document, {
      savedAt: SAVED_AT,
    });
    expect(again).toBe(first);
  });

  it('サブアセンブリと規格部品の出どころも往復する(§0.a-0.35、§0.a-0.41)', () => {
    const document: AssemblyDocument = {
      ...createAssemblyDocument('組立1'),
      components: [
        {
          ...component('component-1', 'part-1'),
          source: { kind: 'subAssembly', assemblyRef: 'sub-1' },
        },
        {
          ...component('component-2', 'part-1'),
          source: {
            kind: 'standardPart',
            catalog: 'hexBolt',
            size: 'M8',
            options: { length: '40' },
            catalogRevision: 'test-catalog',
            generatorRevision: 'test-generator',
          },
        },
      ],
    };
    expect(roundTrip(document)).toEqual(document);
  });

  it('規格部品の追加の指定は鍵の順に書く(同じ中身から同じ文字列)', () => {
    const withOptions = (options: Readonly<Record<string, string>>): AssemblyDocument => ({
      ...createAssemblyDocument('組立1'),
      components: [
        {
          ...component('component-1', 'part-1'),
          source: { kind: 'standardPart', catalog: 'equalAngle', size: 'L50x50x6', options,
            catalogRevision: 'test-catalog', generatorRevision: 'test-generator' },
        },
      ],
    });
    const forward = writeAssemblyDocument(withOptions({ length: '1000', finish: 'raw' }), {
      savedAt: SAVED_AT,
    });
    const backward = writeAssemblyDocument(withOptions({ finish: 'raw', length: '1000' }), {
      savedAt: SAVED_AT,
    });
    expect(backward).toBe(forward);
    expect(forward.indexOf('"finish"')).toBeLessThan(forward.indexOf('"length"'));
  });

  it('抱き込んだ部品の素性(partFiles)も往復する(要件§8)', () => {
    const partFiles: readonly PcadPartFile[] = [
      {
        ref: 'part-1',
        fileName: 'ブラケット.pcad',
        path: '../parts/ブラケット.pcad',
        contentHash: 'abc123',
        importedAt: SAVED_AT,
      },
    ];
    const text = writeAssemblyDocument(richAssembly(), { savedAt: SAVED_AT, partFiles });
    expect(expectOk(readAssemblyDocument(text)).partFiles).toEqual(partFiles);
  });

  it('partFiles を渡さなければ空の一覧を書く(欄ごと省略しない)', () => {
    const text = writeAssemblyDocument(createAssemblyDocument('組立1'), { savedAt: SAVED_AT });
    expect(text).toContain('"partFiles": []');
    expect(expectOk(readAssemblyDocument(text)).partFiles).toEqual([]);
  });

  it('可動範囲が null のジョイントは null のまま往復する(無制限)', () => {
    const document: AssemblyDocument = {
      ...richAssembly(),
      joints: [{ ...joint(), minValue: null, maxValue: null }],
    };
    const text = writeAssemblyDocument(document, { savedAt: SAVED_AT });
    expect(text).toContain('"minValue": null');
    expect(roundTrip(document)).toEqual(document);
  });

  it('部品表の設定は既定のまま往復する(FR-611、§0.a-0.38)', () => {
    const document = createAssemblyDocument('組立1');
    expect(roundTrip(document).bom).toEqual(DEFAULT_BOM_SETTINGS);
  });

  it('部品表の列を並べ替えた設定も往復する', () => {
    const document: AssemblyDocument = {
      ...createAssemblyDocument('組立1'),
      bom: { columns: ['name', 'quantity'], sortBy: 'name', expandSubAssemblies: true },
    };
    expect(roundTrip(document)).toEqual(document);
  });
});

describe('壊れたアセンブリのファイルを断る(FR-504、NFR-UX-5)', () => {
  it('JSON として読めなければ invalidJson', () => {
    expect(expectError(readAssemblyDocument('{')).code).toBe('invalidJson');
  });

  it('アプリ名が違えば notPcad', () => {
    expect(expectError(readAssemblyDocument(rawFile({ app: 'ほかのアプリ' }))).code).toBe('notPcad');
  });

  it('種別 part / partTemplate / drawing は「アセンブリではありません」と断る', () => {
    for (const kind of [PCAD_DOCUMENT_KIND, 'partTemplate', 'drawing']) {
      const error = expectError(readAssemblyDocument(rawFile({ kind })));
      expect(error.code).toBe('unsupportedKind');
      expect(error.message).toContain('アセンブリではありません');
      expect(error.message).toContain(kind);
    }
  });

  it('現在より1つ新しい版は「新しい版で保存されています」と断る', () => {
    const error = expectError(readAssemblyDocument(rawFile({ schema: PCAD_SCHEMA_VERSION + 1 })));
    expect(error.code).toBe('unsupportedNewVersion');
  });

  it('版 1 は「対応していない古い版です」と断る(版 2 への移行が無いため)', () => {
    const error = expectError(readAssemblyDocument(rawFile({ schema: 1 })));
    expect(error.code).toBe('unsupportedOldVersion');
  });

  it('封筒の版と文書の版が食い違えば versionMismatch', () => {
    const document = { ...createAssemblyDocument('組立1'), schemaVersion: 7 };
    const error = expectError(readAssemblyDocument(rawFile({ document })));
    expect(error.code).toBe('versionMismatch');
  });

  it('必要な欄が無ければ場所つきで断る(missingField)', () => {
    const error = expectError(
      readAssemblyDocument(brokenFile(richAssembly(), '"mates"', '"matez"')),
    );
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.mates');
  });

  it('知らない合致の種類は断る(MATE_KINDS に無い)', () => {
    const error = expectError(
      readAssemblyDocument(brokenFile(richAssembly(), '"kind": "coincident"', '"kind": "welded"')),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.mates[0].kind');
  });

  it('知らないジョイントの種類は断る(JOINT_KINDS に無い)', () => {
    const error = expectError(
      readAssemblyDocument(brokenFile(richAssembly(), '"kind": "revolute"', '"kind": "planar"')),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.joints[0].kind');
  });

  it('知らない規格部品の種類は断る(STANDARD_CATALOG_IDS に無い)', () => {
    const document: AssemblyDocument = {
      ...createAssemblyDocument('組立1'),
      components: [
        {
          ...component('component-1', 'part-1'),
          source: { kind: 'standardPart', catalog: 'hexBolt', size: 'M8', options: {},
            catalogRevision: 'test-catalog', generatorRevision: 'test-generator' },
        },
      ],
    };
    const error = expectError(
      readAssemblyDocument(brokenFile(document, '"catalog": "hexBolt"', '"catalog": "rivet"')),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.components[0].source.catalog');
  });

  it('知らない部品表の列は断る(BOM_COLUMN_IDS に無い)', () => {
    const error = expectError(
      readAssemblyDocument(brokenFile(richAssembly(), '"number"', '"weight"')),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('document.bom.columns[0]');
  });

  it('知らない基準ジオメトリの名前は断る(origin / x / y / z / xy / xz / yz だけ)', () => {
    const error = expectError(
      readAssemblyDocument(brokenFile(richAssembly(), '"element": "xy"', '"element": "uv"')),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('element');
  });

  it('部品の id が重なっていれば断る(合致がどちらを指すか決まらない)', () => {
    const document: AssemblyDocument = {
      ...createAssemblyDocument('組立1'),
      components: [component('component-1', 'part-1'), component('component-1', 'part-2')],
    };
    const error = expectError(readAssemblyDocument(writeAssemblyDocument(document, { savedAt: SAVED_AT })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('部品の id が重なっています');
  });

  it('合致の id が重なっていれば断る', () => {
    const document: AssemblyDocument = {
      ...createAssemblyDocument('組立1'),
      mates: [mate(), mate()],
    };
    const error = expectError(readAssemblyDocument(writeAssemblyDocument(document, { savedAt: SAVED_AT })));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('合致の id が重なっています');
  });

  it('抱き込んだ部品の素性の欄が欠けていれば断る', () => {
    const text = rawFile({ partFiles: [{ ref: 'part-1', fileName: 'a.pcad' }] });
    const error = expectError(readAssemblyDocument(text));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('partFiles[0].path');
  });
});

describe('四元数の検査(§2.4。壊れたファイルで NaN を通さない)', () => {
  it('4 数そろっていれば読める', () => {
    const document = richAssembly();
    expect(roundTrip(document).components[1].placement.rotation).toEqual([
      0, 0, 0.7071067811865476, 0.7071067811865476,
    ]);
  });

  it('3 数しかないファイルは断る', () => {
    const error = expectError(
      readAssemblyDocument(
        brokenFile(richAssembly(), '"rotation": [\n            0,\n            0,\n            0,\n            1\n          ]', '"rotation": [0, 0, 1]'),
      ),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('rotation');
  });

  it('null(JSON に書けない NaN)が入ったファイルは断る', () => {
    const text = writeAssemblyDocument(richAssembly(), { savedAt: SAVED_AT });
    const broken = text.replace('"rotation": [\n            0,\n            0,\n            0,\n            1\n          ]', '"rotation": [0, 0, 0, null]');
    expect(broken).not.toBe(text);
    const error = expectError(readAssemblyDocument(broken));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('rotation');
  });

  it('Infinity になる大きすぎる数(1e999)が入ったファイルは断る', () => {
    const text = writeAssemblyDocument(richAssembly(), { savedAt: SAVED_AT });
    const broken = text.replace('"rotation": [\n            0,\n            0,\n            0,\n            1\n          ]', '"rotation": [0, 0, 0, 1e999]');
    expect(broken).not.toBe(text);
    const error = expectError(readAssemblyDocument(broken));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('rotation');
  });

  it('位置が 3 数でなければ断る', () => {
    const error = expectError(
      readAssemblyDocument(
        rawFile({
          document: {
            ...createAssemblyDocument('組立1'),
            components: [
              {
                ...component('component-1', 'part-1'),
                placement: { position: [ev('0', 0), ev('0', 0)], rotation: [0, 0, 0, 1] },
              },
            ],
          },
        }),
      ),
    );
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain('position');
  });
});

describe('版 7 → 版 8 の移行(P7 §0.a-0.2)', () => {
  it('アセンブリの封筒を持ち上げると bom が既定で補われる', () => {
    const migrate = SCHEMA_MIGRATIONS[7];
    if (migrate === undefined) {
      throw new Error('版 7 の移行があるはず');
    }
    const lifted: unknown = migrate({
      schema: 7,
      kind: PCAD_ASSEMBLY_KIND,
      document: { id: 'assembly-1', schemaVersion: 7 },
    });
    expect(lifted).toEqual({
      schema: 8,
      kind: PCAD_ASSEMBLY_KIND,
      document: { id: 'assembly-1', schemaVersion: 8, bom: DEFAULT_BOM_SETTINGS },
    });
  });

  it('bom をすでに持つ文書は上書きしない', () => {
    const migrate = SCHEMA_MIGRATIONS[7];
    if (migrate === undefined) {
      throw new Error('版 7 の移行があるはず');
    }
    const bom = { columns: ['name'], sortBy: 'name', expandSubAssemblies: true };
    const lifted: unknown = migrate({
      schema: 7,
      kind: PCAD_ASSEMBLY_KIND,
      document: { schemaVersion: 7, bom },
    });
    expect(lifted).toMatchObject({ document: { bom } });
  });

  it('版 7 のアセンブリのファイルは開けて、版 8 として読み込まれる(前方互換、要件§8)', () => {
    const { bom, ...withoutBom } = createAssemblyDocument('組立1');
    expect(bom).toEqual(DEFAULT_BOM_SETTINGS);
    const text = rawFile({ schema: 7, document: { ...withoutBom, schemaVersion: 7 } });
    const result = expectOk(readAssemblyDocument(text));
    expect(result.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    expect(result.document.bom).toEqual(DEFAULT_BOM_SETTINGS);
  });
});
