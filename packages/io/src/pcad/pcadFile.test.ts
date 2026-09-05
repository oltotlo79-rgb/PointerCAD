import {
  createEmptyPartDocument,
  emptyAppearanceTable,
  PART_SCHEMA_VERSION,
  type PartDocument,
} from '@pointercad/model';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import { serializeDocument } from './documentJson.js';
import {
  decodeImportedMeshBytes,
  emptyPcadAttachments,
  encodeImportedMeshBytes,
  PCAD_CANVAS_ENTRY_PREFIX,
  PCAD_CANVAS_ENTRY_SUFFIX,
  PCAD_DOCUMENT_ENTRY,
  PCAD_MESH_ENTRY_PREFIX,
  PCAD_MESH_ENTRY_SUFFIX,
  PCAD_SHAPE_ENTRY_PREFIX,
  PCAD_SHAPE_ENTRY_SUFFIX,
  PCAD_THUMBNAIL_ENTRY,
  readPcadFile,
  writePcadFile,
  type ImportedMeshBytes,
  type PcadAttachments,
  type ReadPcadFileError,
  type ReadPcadFileResult,
} from './pcadFile.js';
import {
  PCAD_APP_NAME,
  PCAD_DOCUMENT_KIND,
  PCAD_SCHEMA_VERSION,
  PCAD_TEMPLATE_KIND,
} from './schema.js';

/** 検査で保存時刻を固定する(時刻が違ってもバイト列が同じであることを確かめるため)。 */
const SAVED_AT = '2026-09-03T01:23:45.678Z';

/** 計画書 §2.8 の例(40×30 の面を 10mm 押し出した箱)に相当する部品文書。 */
function exampleDocument(): PartDocument {
  return {
    id: 'part-1',
    name: '部品1',
    schemaVersion: PART_SCHEMA_VERSION,
    sketches: [
      {
        id: 'sketch-1',
        name: 'スケッチ1',
        features: [
          {
            id: 'line-1',
            kind: 'line',
            name: '線分1',
            planeId: 'xy',
            from: {
              mode: 'absolute',
              x: { source: '0', value: 0, display: '0' },
              y: { source: '0', value: 0, display: '0' },
              z: { source: '0', value: 0, display: '0' },
            },
            to: {
              mode: 'relative',
              base: { kind: 'previous' },
              dx: { source: '40', value: 40, display: '40' },
              dy: { source: '0', value: 0, display: '0' },
              dz: { source: '0', value: 0, display: '0' },
            },
            construction: false,
          },
          {
            id: 'face-1',
            kind: 'face',
            name: '面1',
            planeId: 'xy',
            boundary: [{ featureId: 'line-1' }],
            color: '#7aa2f7',
          },
        ],
      },
    ],
    activeSketchId: 'sketch-1',
    references: [],
    solids: [
      {
        id: 'extrude-1',
        kind: 'extrude',
        name: '押し出し1',
        suppressed: false,
        profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
        distance: { source: '5*2', value: 10, display: '10' },
        reversed: false,
        symmetric: false,
      },
    ],
    // パラメータ表(FR-207、P4b タスク2)。中身の読み書きは版5(タスク21)から。
    parameters: [],
    // 外観の割り当て(FR-1106〜1110、P5 タスク5)。この例は割り当てを持たない。
    appearance: emptyAppearanceTable(),
  };
}

/** PNG の署名で始まる、それらしいバイト列(画像として正しい必要はない)。 */
function fakePng(): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const body: number[] = [];
  for (let index = 0; index < 64; index += 1) {
    body.push((index * 7) % 256);
  }
  return new Uint8Array([...signature, ...body]);
}

/** 他のアプリが作った .pcad を模した ZIP。圧縮の強さを変えられる。 */
function makeZip(entries: Record<string, Uint8Array>, level: 0 | 1 | 9): Uint8Array {
  const withLevel: Zippable = {};
  for (const [name, content] of Object.entries(entries)) {
    withLevel[name] = [content, { level }];
  }
  return zipSync(withLevel);
}

/** 封筒の欄を自由に差し替えた document.json の文字列。 */
function envelopeText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: PCAD_SCHEMA_VERSION,
    kind: PCAD_DOCUMENT_KIND,
    app: PCAD_APP_NAME,
    savedAt: SAVED_AT,
    document: createEmptyPartDocument(),
    ...overrides,
  });
}

type ReadPcadFileSuccess = Extract<ReadPcadFileResult, { readonly ok: true }>;

function expectOk(result: ReadPcadFileResult): ReadPcadFileSuccess {
  if (!result.ok) {
    throw new Error(`読み込みに失敗しました: ${result.error.code} / ${result.error.message}`);
  }
  return result;
}

function expectError(result: ReadPcadFileResult): ReadPcadFileError {
  if (result.ok) {
    throw new Error('断るはずの入力を読み込んでしまいました');
  }
  return result.error;
}

describe('.pcad の書き出し(writePcadFile)', () => {
  it('ZIP の署名 PK で始まる', () => {
    const bytes = writePcadFile(createEmptyPartDocument(), { savedAt: SAVED_AT });
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('入っているのは document.json だけ(サムネイルを渡さないとき)', () => {
    const bytes = writePcadFile(createEmptyPartDocument(), { savedAt: SAVED_AT });
    expect(Object.keys(unzipSync(bytes))).toEqual([PCAD_DOCUMENT_ENTRY]);
  });

  it('サムネイルを渡すと document.json と thumbnail.png の 2 つが入る(要件§8)', () => {
    const bytes = writePcadFile(createEmptyPartDocument(), {
      savedAt: SAVED_AT,
      thumbnailPng: fakePng(),
    });
    expect(Object.keys(unzipSync(bytes))).toEqual([PCAD_DOCUMENT_ENTRY, PCAD_THUMBNAIL_ENTRY]);
  });

  it('中の document.json は serializeDocument の文字列そのもの', () => {
    const document = exampleDocument();
    const bytes = writePcadFile(document, { savedAt: SAVED_AT });
    const entry = unzipSync(bytes)[PCAD_DOCUMENT_ENTRY];
    expect([...entry]).toEqual([...strToU8(serializeDocument(document, { savedAt: SAVED_AT }))]);
  });

  it('document.json は圧縮して入れる(元の文字列より短くなる)', () => {
    const document = exampleDocument();
    const text = strToU8(serializeDocument(document, { savedAt: SAVED_AT }));
    expect(writePcadFile(document, { savedAt: SAVED_AT }).length).toBeLessThan(text.length);
  });

  it('同じ入力からは同じバイト列ができる(決定的)', () => {
    const first = writePcadFile(exampleDocument(), { savedAt: SAVED_AT });
    const second = writePcadFile(exampleDocument(), { savedAt: SAVED_AT });
    expect(second).toEqual(first);
  });

  it('サムネイルつきでも同じ入力からは同じバイト列ができる', () => {
    const first = writePcadFile(exampleDocument(), { savedAt: SAVED_AT, thumbnailPng: fakePng() });
    const second = writePcadFile(exampleDocument(), { savedAt: SAVED_AT, thumbnailPng: fakePng() });
    expect(second).toEqual(first);
  });

  it('書き出した時刻が違ってもバイト列は変わらない(ZIP の日時は固定値)', () => {
    const document = exampleDocument();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
      const first = writePcadFile(document, { savedAt: SAVED_AT });
      vi.setSystemTime(new Date('2027-04-01T12:34:56.000Z'));
      const second = writePcadFile(document, { savedAt: SAVED_AT });
      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('保存時刻を渡さなければ今の時刻が document.json に入る', () => {
    const before = Date.now();
    const bytes = writePcadFile(createEmptyPartDocument());
    const after = Date.now();
    const at = Date.parse(expectOk(readPcadFile(bytes)).savedAt);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it('空の部品文書の .pcad は数百バイトに収まる', () => {
    const bytes = writePcadFile(createEmptyPartDocument(), { savedAt: SAVED_AT });
    // 実測 373 バイト(document.json の文字列は 441 バイト。2026-09-05、P5 タスク5で
    // appearance の欄が増えた後の値。P4b までの実測 337/350 バイトより増えたのは、この
    // 欄の分だけであり、上限には十分収まる)。
    expect(bytes.length).toBeGreaterThan(100);
    expect(bytes.length).toBeLessThan(1000);
  });

  it('計画書 §2.8 の例の .pcad は 4KB 未満に収まる', () => {
    // 実測 728 バイト(document.json の文字列は 2280 バイト。2026-09-05、appearance の
    // 欄が増えた後の値。P4b までの実測 683/2154 バイトより増えたのはこの欄の分だけ)。
    expect(writePcadFile(exampleDocument(), { savedAt: SAVED_AT }).length).toBeLessThan(4096);
  });
});

describe('.pcad の往復(writePcadFile → readPcadFile)', () => {
  it('サムネイルなしで往復し、文書と保存時刻が一致する', () => {
    const document = exampleDocument();
    const result = expectOk(readPcadFile(writePcadFile(document, { savedAt: SAVED_AT })));
    expect(result.document).toEqual(document);
    expect(result.savedAt).toBe(SAVED_AT);
    expect(result.thumbnailPng).toBeUndefined();
  });

  it('サムネイルつきで往復し、PNG のバイト列がそのまま戻る', () => {
    const png = fakePng();
    const bytes = writePcadFile(exampleDocument(), { savedAt: SAVED_AT, thumbnailPng: png });
    const result = expectOk(readPcadFile(bytes));
    expect(result.thumbnailPng).toEqual(png);
  });

  it('空の部品文書も往復で一致する', () => {
    const document = createEmptyPartDocument();
    expect(expectOk(readPcadFile(writePcadFile(document, { savedAt: SAVED_AT }))).document).toEqual(
      document,
    );
  });

  it('往復した文書をもう一度書き出すと同じバイト列になる', () => {
    const bytes = writePcadFile(exampleDocument(), { savedAt: SAVED_AT });
    const again = writePcadFile(expectOk(readPcadFile(bytes)).document, { savedAt: SAVED_AT });
    expect(again).toEqual(bytes);
  });
});

describe('他のアプリが作った ZIP の読み込み', () => {
  it('無圧縮(level 0)で作られた .pcad も読める', () => {
    const zip = makeZip({ [PCAD_DOCUMENT_ENTRY]: strToU8(envelopeText()) }, 0);
    expect(expectOk(readPcadFile(zip)).document).toEqual(createEmptyPartDocument());
  });

  it('強く圧縮(level 9)された .pcad も読める', () => {
    const zip = makeZip({ [PCAD_DOCUMENT_ENTRY]: strToU8(envelopeText()) }, 9);
    expect(expectOk(readPcadFile(zip)).document).toEqual(createEmptyPartDocument());
  });

  it('圧縮された .pcad でもサムネイルを取り出せる', () => {
    const png = fakePng();
    const zip = makeZip(
      { [PCAD_DOCUMENT_ENTRY]: strToU8(envelopeText()), [PCAD_THUMBNAIL_ENTRY]: png },
      9,
    );
    expect(expectOk(readPcadFile(zip)).thumbnailPng).toEqual(png);
  });

  it('知らないエントリが入っていても読める(document.json だけを見る)', () => {
    const zip = makeZip(
      { 'notes.txt': strToU8('メモ'), [PCAD_DOCUMENT_ENTRY]: strToU8(envelopeText()) },
      1,
    );
    expect(expectOk(readPcadFile(zip)).savedAt).toBe(SAVED_AT);
  });
});

describe(
  '版3 → 版4の移行(construction 無し・pointArray がフラット形式、SCHEMA_MIGRATIONS[3]、' +
    'P4 タスク31・§0.a-0.24。元は統括の差し戻し 2026-09-04、要件§8・P3完了条件9)',
  () => {
    it('construction の無い線分・layout の無い点列を含む版3の .pcad も読める', () => {
      const legacyDocument = {
        id: 'part-1',
        name: '部品1',
        // 封筒(schema)と文書自身の版をそろえた、genuine な版3の文書(references も無い)。
        schemaVersion: 3,
        sketches: [
          {
            id: 'sketch-1',
            name: 'スケッチ1',
            features: [
              {
                id: 'line-1',
                kind: 'line',
                name: '線分1',
                planeId: 'xy',
                from: {
                  mode: 'absolute',
                  x: { source: '0', value: 0, display: '0' },
                  y: { source: '0', value: 0, display: '0' },
                  z: { source: '0', value: 0, display: '0' },
                },
                to: {
                  mode: 'absolute',
                  x: { source: '10', value: 10, display: '10' },
                  y: { source: '0', value: 0, display: '0' },
                  z: { source: '0', value: 0, display: '0' },
                },
                // construction は無い(版3以前)。
              },
              {
                id: 'pointArray-1',
                kind: 'pointArray',
                name: '点列1',
                planeId: 'xy',
                // layout を挟まない、版3以前のフラットな形式。
                base: {
                  mode: 'absolute',
                  x: { source: '0', value: 0, display: '0' },
                  y: { source: '0', value: 0, display: '0' },
                  z: { source: '0', value: 0, display: '0' },
                },
                azimuth: { source: '0', value: 0, display: '0' },
                spacing: { source: '10', value: 10, display: '10' },
                count: { source: '3', value: 3, display: '3' },
              },
            ],
          },
        ],
        activeSketchId: 'sketch-1',
        solids: [],
      };
      const zip = makeZip(
        { [PCAD_DOCUMENT_ENTRY]: strToU8(envelopeText({ schema: 3, document: legacyDocument })) },
        1,
      );
      const result = expectOk(readPcadFile(zip));
      const line = result.document.sketches[0].features[0];
      if (line.kind !== 'line') {
        throw new Error('線分のはず');
      }
      expect(line.construction).toBe(false);
      const array = result.document.sketches[0].features[1];
      if (array.kind !== 'pointArray') {
        throw new Error('点列のはず');
      }
      expect(array.layout.kind).toBe('linear');
      // 移行の結果、文書自身も現在の版になっている。
      expect(result.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
      expect(result.document.references).toEqual([]);
    });
  },
);

describe('.pcad の断り方(FR-504、NFR-UX-5)', () => {
  it('空のバイト列は例外にせず理由を返す', () => {
    const error = expectError(readPcadFile(new Uint8Array(0)));
    expect(error.code).toBe('notZip');
    expect(error.message).toContain('開けませんでした');
  });

  it('ZIP でないバイト列も例外にせず理由を返す', () => {
    const error = expectError(readPcadFile(strToU8('これはただの文章です')));
    expect(error.code).toBe('notZip');
    expect(error.message).toContain('開けませんでした');
  });

  it('先頭だけ PK の壊れたバイト列も理由を返す', () => {
    const error = expectError(readPcadFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])));
    expect(error.code).toBe('notZip');
  });

  it('document.json が入っていない ZIP は、その旨を添えて断る', () => {
    const zip = makeZip({ [PCAD_THUMBNAIL_ENTRY]: fakePng() }, 0);
    const error = expectError(readPcadFile(zip));
    expect(error.code).toBe('missingDocument');
    expect(error.message).toContain('document.json が入っていません');
  });

  it('中身が JSON として読めなければ、そのままの理由を返す(タスク14 の文言)', () => {
    const zip = makeZip({ [PCAD_DOCUMENT_ENTRY]: strToU8('{') }, 0);
    const error = expectError(readPcadFile(zip));
    expect(error.code).toBe('invalidJson');
    expect(error.message).toContain('読み取れませんでした');
  });

  it('版 1 のファイルは「対応していない古い版です」と断る', () => {
    const zip = makeZip({ [PCAD_DOCUMENT_ENTRY]: strToU8(envelopeText({ schema: 1 })) }, 0);
    const error = expectError(readPcadFile(zip));
    expect(error.code).toBe('unsupportedOldVersion');
    expect(error.message).toContain('対応していない古い版です');
  });

  it('種別が assembly のファイルは、その種別を添えてまだ対応していないと断る', () => {
    const zip = makeZip({ [PCAD_DOCUMENT_ENTRY]: strToU8(envelopeText({ kind: 'assembly' })) }, 0);
    const error = expectError(readPcadFile(zip));
    expect(error.code).toBe('unsupportedKind');
    expect(error.message).toContain('assembly');
    expect(error.message).toContain('まだ対応していません');
  });

  it('文書の欄が壊れていれば、その場所を添えて断る', () => {
    const zip = makeZip(
      { [PCAD_DOCUMENT_ENTRY]: strToU8(envelopeText({ document: { id: 'part-1' } })) },
      0,
    );
    const error = expectError(readPcadFile(zip));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain('document.name');
  });
});

// ---------------------------------------------------------------------------
// 添付(P6 タスク21、§0.a-0.9・0.24・0.45・0.55)
// ---------------------------------------------------------------------------

/** OCCT の `BinTools` が書いたバイト列を模したもの(中身は解釈しないので何でもよい)。 */
function fakeBrep(seed: number): Uint8Array {
  const bytes = new Uint8Array(256);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * seed) % 256;
  }
  return bytes;
}

/** 三角形 `count` 枚の、それらしい中身の三角形(頂点は三角形ごとに 3 つ持つ)。 */
function makeMesh(count: number): ImportedMeshBytes {
  const positions = new Float32Array(count * 9);
  const normals = new Float32Array(count * 9);
  const indices = new Uint32Array(count * 3);
  for (let triangle = 0; triangle < count; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const at = triangle * 9 + corner * 3;
      positions[at] = triangle * 0.5 + corner;
      positions[at + 1] = corner * 1.25;
      positions[at + 2] = triangle * 0.125;
      normals[at] = 0;
      normals[at + 1] = 0;
      normals[at + 2] = 1;
      indices[triangle * 3 + corner] = triangle * 3 + corner;
    }
  }
  return { positions, normals, indices };
}

/** 読み込んだ形 1 つと読み込んだ三角形 1 つを履歴に持つ部品文書。 */
function importedDocument(): PartDocument {
  return {
    ...createEmptyPartDocument(),
    solids: [
      {
        id: 'importedSolid-1',
        kind: 'importedSolid',
        name: '読み込んだ形1',
        suppressed: false,
        shapeRef: 'shape-1',
        source: {
          format: 'step',
          fileName: 'bracket.step',
          unit: 'inch',
          byteLength: 4494,
          importedAt: '2026-09-06T00:00:00.000Z',
        },
        bodyKind: 'solid',
      },
      {
        id: 'importedMesh-1',
        kind: 'importedMesh',
        name: '読み込んだ三角形の形1',
        suppressed: false,
        meshRef: 'mesh-1',
        source: { format: 'stl', fileName: 'cover.stl', unit: 'mm', byteLength: 684 },
        triangleCount: 12,
        volume: 8000,
      },
    ],
  };
}

/** 上の文書がそろえておくべき添付。 */
function importedAttachments(): PcadAttachments {
  return {
    shapes: new Map([['shape-1', fakeBrep(7)]]),
    meshes: new Map([['mesh-1', makeMesh(12)]]),
    canvases: new Map(),
  };
}

describe('meshes/<id>.bin の並び(PCM1、§2.8)', () => {
  it('頭は PCM1 + 頂点の数 + 三角形の数 の 12 バイトで、全体の長さは 12 + 24n + 12m', () => {
    const mesh = makeMesh(12);
    const bytes = encodeImportedMeshBytes(mesh);
    if (bytes === null) {
      throw new Error('書けるはず');
    }
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x43, 0x4d, 0x31]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(4, true)).toBe(36);
    expect(view.getUint32(8, true)).toBe(12);
    expect(bytes.length).toBe(12 + 36 * 24 + 12 * 12);
  });

  it('位置 → 法線 → 添字の順に並ぶ(§2.8 の並び)', () => {
    const mesh = makeMesh(2);
    const bytes = encodeImportedMeshBytes(mesh);
    if (bytes === null) {
      throw new Error('書けるはず');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // 位置の先頭は positions[0]、法線の先頭は 12 + 6 頂点 × 3 × 4 バイトの位置。
    expect(view.getFloat32(12, true)).toBe(mesh.positions[0]);
    expect(view.getFloat32(12 + 6 * 3 * 4, true)).toBe(mesh.normals[0]);
    expect(view.getUint32(12 + 6 * 3 * 4 * 2, true)).toBe(mesh.indices[0]);
  });

  it('往復して 3 本の配列がそのまま戻る', () => {
    const mesh = makeMesh(37);
    const bytes = encodeImportedMeshBytes(mesh);
    if (bytes === null) {
      throw new Error('書けるはず');
    }
    expect(decodeImportedMeshBytes(bytes)).toEqual(mesh);
  });

  it('マジックが違う・長さが合わない・短すぎるバイト列は null(例外を投げない)', () => {
    const bytes = encodeImportedMeshBytes(makeMesh(3));
    if (bytes === null) {
      throw new Error('書けるはず');
    }
    const wrongMagic = new Uint8Array(bytes);
    wrongMagic[0] = 0x51;
    expect(decodeImportedMeshBytes(wrongMagic)).toBeNull();
    expect(decodeImportedMeshBytes(bytes.slice(0, bytes.length - 4))).toBeNull();
    expect(decodeImportedMeshBytes(new Uint8Array(8))).toBeNull();
    expect(decodeImportedMeshBytes(new Uint8Array(0))).toBeNull();
  });

  it('位置と法線の長さがそろっていない三角形は書けない(null)', () => {
    const mesh = makeMesh(2);
    expect(
      encodeImportedMeshBytes({ ...mesh, normals: new Float32Array(mesh.normals.length - 3) }),
    ).toBeNull();
    expect(
      encodeImportedMeshBytes({
        positions: new Float32Array(4),
        normals: new Float32Array(4),
        indices: new Uint32Array(3),
      }),
    ).toBeNull();
  });
});

describe('.pcad の添付(§0.a-0.55)', () => {
  it('添付を渡さなければエントリは増えない(版 6 までの .pcad と同じ形)', () => {
    const bytes = writePcadFile(createEmptyPartDocument(), { savedAt: SAVED_AT });
    expect(Object.keys(unzipSync(bytes))).toEqual([PCAD_DOCUMENT_ENTRY]);
  });

  it('添付は shapes/<ref>.brep・meshes/<ref>.bin・canvases/<id>.png に入る', () => {
    const bytes = writePcadFile(importedDocument(), {
      savedAt: SAVED_AT,
      attachments: {
        ...importedAttachments(),
        canvases: new Map([['canvas-1', fakePng()]]),
      },
    });
    expect(Object.keys(unzipSync(bytes))).toEqual([
      PCAD_DOCUMENT_ENTRY,
      `${PCAD_SHAPE_ENTRY_PREFIX}shape-1${PCAD_SHAPE_ENTRY_SUFFIX}`,
      `${PCAD_MESH_ENTRY_PREFIX}mesh-1${PCAD_MESH_ENTRY_SUFFIX}`,
      `${PCAD_CANVAS_ENTRY_PREFIX}canvas-1${PCAD_CANVAS_ENTRY_SUFFIX}`,
    ]);
  });

  it('添付のある .pcad を往復すると、文書も 3 種の添付もそのまま戻る', () => {
    const document = importedDocument();
    const attachments = importedAttachments();
    const png = fakePng();
    const bytes = writePcadFile(document, {
      savedAt: SAVED_AT,
      attachments: { ...attachments, canvases: new Map([['canvas-1', png]]) },
    });
    const result = expectOk(readPcadFile(bytes));
    expect(result.document).toEqual(document);
    expect(result.attachments.shapes.get('shape-1')).toEqual(attachments.shapes.get('shape-1'));
    expect(result.attachments.meshes.get('mesh-1')).toEqual(attachments.meshes.get('mesh-1'));
    expect(result.attachments.canvases.get('canvas-1')).toEqual(png);
  });

  it('読み直した添付でもう一度書くとバイト列が完全に一致する(決定性)', () => {
    const bytes = writePcadFile(importedDocument(), {
      savedAt: SAVED_AT,
      attachments: importedAttachments(),
    });
    const again = writePcadFile(expectOk(readPcadFile(bytes)).document, {
      savedAt: SAVED_AT,
      attachments: expectOk(readPcadFile(bytes)).attachments,
    });
    expect(again).toEqual(bytes);
  });

  it('同じ添付から 2 回書いてもバイト列が完全に一致する(日時を固定しているため)', () => {
    const first = writePcadFile(importedDocument(), {
      savedAt: SAVED_AT,
      attachments: importedAttachments(),
    });
    const second = writePcadFile(importedDocument(), {
      savedAt: SAVED_AT,
      attachments: importedAttachments(),
    });
    expect(second).toEqual(first);
  });

  it('表の並び順が違っても、名前の順に並べるので同じバイト列になる', () => {
    const first = writePcadFile(createEmptyPartDocument(), {
      savedAt: SAVED_AT,
      attachments: {
        ...emptyPcadAttachments(),
        shapes: new Map([
          ['b', fakeBrep(3)],
          ['a', fakeBrep(5)],
        ]),
      },
    });
    const second = writePcadFile(createEmptyPartDocument(), {
      savedAt: SAVED_AT,
      attachments: {
        ...emptyPcadAttachments(),
        shapes: new Map([
          ['a', fakeBrep(5)],
          ['b', fakeBrep(3)],
        ]),
      },
    });
    expect(second).toEqual(first);
  });

  it('B-rep と三角形は圧縮して入れる(素の数値の並びなので deflate が効く)', () => {
    const brep = fakeBrep(7);
    const mesh = makeMesh(200);
    const raw = encodeImportedMeshBytes(mesh);
    if (raw === null) {
      throw new Error('書けるはず');
    }
    const withAttachments = writePcadFile(createEmptyPartDocument(), {
      savedAt: SAVED_AT,
      attachments: {
        shapes: new Map([['shape-1', brep]]),
        meshes: new Map([['mesh-1', mesh]]),
        canvases: new Map(),
      },
    });
    const empty = writePcadFile(createEmptyPartDocument(), { savedAt: SAVED_AT });
    // 添付が増やしたぶんは、素のバイト数より小さい(= 圧縮が効いている)。
    console.log(
      `[実測] 添付 brep ${String(brep.length)} バイト + bin ${String(raw.length)} バイト → ` +
        `.pcad の増分 ${String(withAttachments.length - empty.length)} バイト`,
    );
    expect(withAttachments.length - empty.length).toBeLessThan(brep.length + raw.length);
  });

  it('添付を持たない .pcad を読むと、3 つとも空の表が返る(欄ごと無くさない)', () => {
    const result = expectOk(readPcadFile(writePcadFile(createEmptyPartDocument())));
    expect(result.attachments.shapes.size).toBe(0);
    expect(result.attachments.meshes.size).toBe(0);
    expect(result.attachments.canvases.size).toBe(0);
    expect(emptyPcadAttachments().shapes.size).toBe(0);
  });

  it('文書が参照していない添付も捨てずに返す(まだ欄になっていない下絵を失わない)', () => {
    const bytes = writePcadFile(createEmptyPartDocument(), {
      savedAt: SAVED_AT,
      attachments: {
        shapes: new Map([['unused-shape', fakeBrep(11)]]),
        meshes: new Map([['unused-mesh', makeMesh(2)]]),
        canvases: new Map([['canvas-1', fakePng()]]),
      },
    });
    const result = expectOk(readPcadFile(bytes));
    expect([...result.attachments.shapes.keys()]).toEqual(['unused-shape']);
    expect([...result.attachments.meshes.keys()]).toEqual(['unused-mesh']);
    expect([...result.attachments.canvases.keys()]).toEqual(['canvas-1']);
  });

  it('読んだ shapes の表はそのまま importedShapes(鍵は shapeRef、値はバイト列)になっている', () => {
    const bytes = writePcadFile(importedDocument(), {
      savedAt: SAVED_AT,
      attachments: importedAttachments(),
    });
    const shapes = expectOk(readPcadFile(bytes)).attachments.shapes;
    const solid = importedDocument().solids[0];
    if (solid.kind !== 'importedSolid') {
      throw new Error('読み込んだ形のはず');
    }
    expect(shapes.get(solid.shapeRef)).toBeInstanceOf(Uint8Array);
  });

  it('階層のある名前(shapes/a/b.brep)は添付として扱わず、読み飛ばす', () => {
    const zip = makeZip(
      {
        [PCAD_DOCUMENT_ENTRY]: strToU8(envelopeText()),
        'shapes/a/b.brep': fakeBrep(3),
        'shapes/.brep': fakeBrep(4),
      },
      1,
    );
    expect(expectOk(readPcadFile(zip)).attachments.shapes.size).toBe(0);
  });

  it('文書が指す B-rep の添付が欠けていれば missingField で断る(コードを増やさない)', () => {
    const bytes = writePcadFile(importedDocument(), {
      savedAt: SAVED_AT,
      attachments: { ...importedAttachments(), shapes: new Map() },
    });
    const error = expectError(readPcadFile(bytes));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain(`${PCAD_SHAPE_ENTRY_PREFIX}shape-1${PCAD_SHAPE_ENTRY_SUFFIX}`);
  });

  it('文書が指す三角形の添付が欠けていれば missingField で断る', () => {
    const bytes = writePcadFile(importedDocument(), {
      savedAt: SAVED_AT,
      attachments: { ...importedAttachments(), meshes: new Map() },
    });
    const error = expectError(readPcadFile(bytes));
    expect(error.code).toBe('missingField');
    expect(error.message).toContain(`${PCAD_MESH_ENTRY_PREFIX}mesh-1${PCAD_MESH_ENTRY_SUFFIX}`);
  });

  it('三角形の添付の並びが壊れていれば invalidField で断る', () => {
    const zip = makeZip(
      {
        [PCAD_DOCUMENT_ENTRY]: strToU8(envelopeText()),
        [`${PCAD_MESH_ENTRY_PREFIX}mesh-1${PCAD_MESH_ENTRY_SUFFIX}`]: strToU8('これは三角形ではない'),
      },
      1,
    );
    const error = expectError(readPcadFile(zip));
    expect(error.code).toBe('invalidField');
    expect(error.message).toContain(`${PCAD_MESH_ENTRY_PREFIX}mesh-1${PCAD_MESH_ENTRY_SUFFIX}`);
  });

  it('ひな形(kind: partTemplate)の .pcad も同じ経路で読み書きできる(§0.a-0.35)', () => {
    const bytes = writePcadFile(createEmptyPartDocument(), {
      savedAt: SAVED_AT,
      kind: PCAD_TEMPLATE_KIND,
    });
    const result = expectOk(readPcadFile(bytes));
    expect(result.kind).toBe(PCAD_TEMPLATE_KIND);
    expect(expectOk(readPcadFile(writePcadFile(createEmptyPartDocument()))).kind).toBe(
      PCAD_DOCUMENT_KIND,
    );
  });
});

describe('10 万三角形の添付を含む .pcad の大きさと所要(§1.5-18)', () => {
  // §2.8 の見積もり: 三角形 10 万・頂点 5 万で `12 + 24×50000 + 12×100000` = 2,400,012 バイト。
  // **上限は要件の数値ではなく、この実測で桁が変わったら気づくための見張り**として置く。
  const TRIANGLE_COUNT = 100_000;
  const VERTEX_COUNT = 50_000;
  const WRITE_LIMIT_MS = 5000;
  const READ_LIMIT_MS = 5000;

  /**
   * §2.8 の見積もりと同じ、頂点を共有する三角形(頂点 5 万・三角形 10 万)。
   *
   * **座標が規則的なので deflate がよく効く**(実測 0.13 倍)。実際に読み込んだ形は
   * もっと不規則なので、計画書 §2.8 の見込み「1MB 前後」のほうを目安として扱う
   * ——この検査が測っているのは**圧縮率の下限**ではなく、**桁が変わったら気づく**ことである。
   */
  function sharedMesh(): ImportedMeshBytes {
    const positions = new Float32Array(VERTEX_COUNT * 3);
    const normals = new Float32Array(VERTEX_COUNT * 3);
    const indices = new Uint32Array(TRIANGLE_COUNT * 3);
    for (let vertex = 0; vertex < VERTEX_COUNT; vertex += 1) {
      positions[vertex * 3] = (vertex % 200) * 0.5;
      positions[vertex * 3 + 1] = Math.floor(vertex / 200) * 0.5;
      positions[vertex * 3 + 2] = ((vertex * 7) % 13) * 0.125;
      normals[vertex * 3 + 2] = 1;
    }
    for (let triangle = 0; triangle < TRIANGLE_COUNT; triangle += 1) {
      indices[triangle * 3] = triangle % VERTEX_COUNT;
      indices[triangle * 3 + 1] = (triangle + 1) % VERTEX_COUNT;
      indices[triangle * 3 + 2] = (triangle + 2) % VERTEX_COUNT;
    }
    return { positions, normals, indices };
  }

  it('meshes/<id>.bin の大きさが §2.8 の見積もり(2,400,012 バイト)と一致する', () => {
    const raw = encodeImportedMeshBytes(sharedMesh());
    expect(raw?.length).toBe(2_400_012);
  });

  it('大きさと読み書きの所要を実測して記録する', () => {
    const mesh = sharedMesh();
    const raw = encodeImportedMeshBytes(mesh);
    if (raw === null) {
      throw new Error('書けるはず');
    }
    const document: PartDocument = {
      ...createEmptyPartDocument(),
      solids: [
        {
          id: 'importedMesh-1',
          kind: 'importedMesh',
          name: '読み込んだ三角形の形1',
          suppressed: false,
          meshRef: 'mesh-1',
          source: { format: 'stl', fileName: 'big.stl', unit: 'mm', byteLength: raw.length },
          triangleCount: TRIANGLE_COUNT,
        },
      ],
    };
    const attachments: PcadAttachments = {
      ...emptyPcadAttachments(),
      meshes: new Map([['mesh-1', mesh]]),
    };
    const writeStart = performance.now();
    const bytes = writePcadFile(document, { savedAt: SAVED_AT, attachments });
    const writeMs = performance.now() - writeStart;
    const readStart = performance.now();
    const result = expectOk(readPcadFile(bytes));
    const readMs = performance.now() - readStart;
    console.log(
      `[実測] 三角形 ${String(TRIANGLE_COUNT)} 枚: meshes/mesh-1.bin ${String(raw.length)} バイト → ` +
        `.pcad ${String(bytes.length)} バイト(${(bytes.length / raw.length).toFixed(3)} 倍)、` +
        `書き ${writeMs.toFixed(1)} ms / 読み ${readMs.toFixed(1)} ms`,
    );
    expect(result.attachments.meshes.get('mesh-1')?.indices.length).toBe(TRIANGLE_COUNT * 3);
    expectWithinBudget(writeMs, WRITE_LIMIT_MS, '10 万三角形の .pcad の書き出し');
    expectWithinBudget(readMs, READ_LIMIT_MS, '10 万三角形の .pcad の読み込み');
  });
});
