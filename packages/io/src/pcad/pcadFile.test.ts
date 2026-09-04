import { createEmptyPartDocument, PART_SCHEMA_VERSION, type PartDocument } from '@pointercad/model';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import { serializeDocument } from './documentJson.js';
import {
  PCAD_DOCUMENT_ENTRY,
  PCAD_THUMBNAIL_ENTRY,
  readPcadFile,
  writePcadFile,
  type ReadPcadFileError,
  type ReadPcadFileResult,
} from './pcadFile.js';
import { PCAD_APP_NAME, PCAD_DOCUMENT_KIND, PCAD_SCHEMA_VERSION } from './schema.js';

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
    // 実測 337 バイト(document.json の文字列は 350 バイト。2026-09-03)。
    expect(bytes.length).toBeGreaterThan(100);
    expect(bytes.length).toBeLessThan(1000);
  });

  it('計画書 §2.8 の例の .pcad は 4KB 未満に収まる', () => {
    // 実測 683 バイト(document.json の文字列は 2154 バイト。2026-09-03)。
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
