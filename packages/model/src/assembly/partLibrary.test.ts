import { describe, expect, it } from 'vitest';

import {
  appendSolid,
  createEmptyPartDocument,
  createPrimitiveFeature,
} from '../part/createPartDocument.js';
import type { PartDocument } from '../part/types.js';

import {
  attachmentsDigestOf,
  canonicalPartDocumentText,
  contentHashOf,
  emptyEmbeddedPartAttachments,
  EMPTY_PART_LIBRARY,
  embedPart,
  nextPartRef,
  partAttachmentsOf,
  partFileOf,
  partOf,
  replacePartDocument,
  staleParts,
} from './partLibrary.js';
import type { EmbeddedPartAttachments, PartLibrary } from './partLibrary.js';

/** 立体を n 個持つ部品文書。基本形状(箱)を並べるだけで、形は作らない(ハッシュの材料だけ要る)。 */
function partWithBoxes(name: string, count: number): PartDocument {
  let document: PartDocument = { ...createEmptyPartDocument(), name };
  for (let index = 0; index < count; index += 1) {
    document = appendSolid(document, createPrimitiveFeature(document, 'box'));
  }
  return document;
}

/** 検査の中で時刻を固定する(取り込み時刻が毎回変わると結果が比べられない)。 */
const IMPORTED_AT = '2026-09-06T00:00:00.000Z';

function sampleAttachments(seed = 1): EmbeddedPartAttachments {
  return {
    shapes: new Map([['shape-1', new Uint8Array([seed, 2, 3])]]),
    meshes: new Map([
      [
        'mesh-1',
        {
          positions: new Float32Array([seed, 0, 0]),
          normals: new Float32Array([0, 0, 1]),
          indices: new Uint32Array([0, 0, 0]),
        },
      ],
    ]),
    canvases: new Map([['canvas-1', new Uint8Array([0x89, 0x50, seed])]]),
  };
}

describe('canonicalPartDocumentText', () => {
  it('読み直すと元の文書に戻る(欄を落とさない)', () => {
    const document = partWithBoxes('ブラケット', 3);
    expect(JSON.parse(canonicalPartDocumentText(document))).toEqual(document);
  });

  it('欄の並び順を辞書順にそろえる(作り方が違っても同じ文字列)', () => {
    const document = partWithBoxes('ブラケット', 1);
    const reordered: PartDocument = {
      canvases: document.canvases,
      selectionSets: document.selectionSets,
      appearance: document.appearance,
      parameters: document.parameters,
      solids: document.solids,
      references: document.references,
      activeSketchId: document.activeSketchId,
      sketches: document.sketches,
      schemaVersion: document.schemaVersion,
      name: document.name,
      id: document.id,
    };
    expect(canonicalPartDocumentText(reordered)).toBe(canonicalPartDocumentText(document));
  });
});

describe('contentHashOf', () => {
  it('同じ部品文書を 2 回計算すると一致する', async () => {
    const document = partWithBoxes('ブラケット', 5);
    const first = await contentHashOf(document);
    const second = await contentHashOf(document);
    expect(second).toBe(first);
  });

  it('SHA-256 の 16 進 64 文字を返す', async () => {
    const hash = await contentHashOf(partWithBoxes('ブラケット', 1));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('欄の順序だけが違う同じ内容の文書は同じハッシュになる', async () => {
    const document = partWithBoxes('ブラケット', 2);
    const reordered: PartDocument = {
      canvases: document.canvases,
      selectionSets: document.selectionSets,
      appearance: document.appearance,
      parameters: document.parameters,
      solids: document.solids,
      references: document.references,
      activeSketchId: document.activeSketchId,
      sketches: document.sketches,
      schemaVersion: document.schemaVersion,
      name: document.name,
      id: document.id,
    };
    expect(await contentHashOf(reordered)).toBe(await contentHashOf(document));
  });

  it('フィーチャーを 1 つ足すと違うハッシュになる', async () => {
    const document = partWithBoxes('ブラケット', 3);
    const grown = appendSolid(document, createPrimitiveFeature(document, 'box'));
    expect(await contentHashOf(grown)).not.toBe(await contentHashOf(document));
  });

  it('封筒の保存時刻が違っても同じハッシュになる(対象は文書だけ)', async () => {
    // io が書く `parts/<ref>.json` は封筒つきで `savedAt` を含む。ハッシュの対象を
    // 文書に限っているので、保存し直しただけでは「更新されています」にならない。
    const document = partWithBoxes('ブラケット', 2);
    const saved = { app: 'PointerCAD', schema: 8, savedAt: '2026-09-06T00:00:00.000Z', document };
    const savedAgain = { ...saved, savedAt: '2026-09-07T12:34:56.000Z' };
    expect(await contentHashOf(savedAgain.document)).toBe(await contentHashOf(saved.document));
    expect(canonicalPartDocumentText(document)).not.toContain('savedAt');
  });
});

describe('attachmentsDigestOf', () => {
  it('SHA-256 の 16 進 64 文字で、同じ添付なら Map の挿入順によらず一致する', async () => {
    const first = sampleAttachments();
    const reordered: EmbeddedPartAttachments = {
      shapes: new Map([
        ['z', new Uint8Array([9])],
        ...first.shapes,
      ]),
      meshes: first.meshes,
      canvases: first.canvases,
    };
    const reorderedAgain: EmbeddedPartAttachments = {
      shapes: new Map([
        ...first.shapes,
        ['z', new Uint8Array([9])],
      ]),
      meshes: first.meshes,
      canvases: first.canvases,
    };
    expect(await attachmentsDigestOf(reordered)).toBe(await attachmentsDigestOf(reorderedAgain));
    expect(await attachmentsDigestOf(first)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('文書ハッシュを変えず、添付のバイトだけが変わればダイジェストが変わる', async () => {
    const document = partWithBoxes('ブラケット', 1);
    expect(await contentHashOf(document)).toBe(await contentHashOf(document));
    expect(await attachmentsDigestOf(sampleAttachments(1))).not.toBe(
      await attachmentsDigestOf(sampleAttachments(2)),
    );
  });
});

describe('embedPart', () => {
  it('抱き込むと素性と文書が 1 組そろって増える', async () => {
    const document = partWithBoxes('ブラケット', 2);
    const embedded = await embedPart(EMPTY_PART_LIBRARY, document, 'ブラケット.pcad', '../ブラケット.pcad', {
      importedAt: IMPORTED_AT,
    });
    const emptyDigest = await attachmentsDigestOf(emptyEmbeddedPartAttachments());
    expect(embedded.partRef).toBe('part-1');
    expect(embedded.reused).toBe(false);
    expect(embedded.library.partFiles).toEqual([
      {
        ref: 'part-1',
        fileName: 'ブラケット.pcad',
        path: '../ブラケット.pcad',
        contentHash: await contentHashOf(document),
        attachmentsDigest: emptyDigest,
        importedAt: IMPORTED_AT,
      },
    ]);
    expect(embedded.library.parts.size).toBe(1);
    expect(embedded.library.attachments.size).toBe(1);
  });

  it('元の一式を書き換えない', async () => {
    const embedded = await embedPart(
      EMPTY_PART_LIBRARY,
      partWithBoxes('ブラケット', 1),
      'ブラケット.pcad',
      '../ブラケット.pcad',
      { importedAt: IMPORTED_AT },
    );
    expect(embedded.library).not.toBe(EMPTY_PART_LIBRARY);
    expect(EMPTY_PART_LIBRARY.partFiles).toEqual([]);
    expect(EMPTY_PART_LIBRARY.parts.size).toBe(0);
    expect(EMPTY_PART_LIBRARY.attachments.size).toBe(0);
  });

  it('抱き込んだ後の partOf は元と同じ文書を返す', async () => {
    const document = partWithBoxes('ブラケット', 4);
    const embedded = await embedPart(EMPTY_PART_LIBRARY, document, 'ブラケット.pcad', '../ブラケット.pcad', {
      importedAt: IMPORTED_AT,
    });
    expect(partOf(embedded.library, embedded.partRef)).toEqual(document);
    expect(partOf(embedded.library, 'part-9')).toBeUndefined();
  });

  it('同じ部品を 2 回抱き込んでも partRef が 1 つだけ増える', async () => {
    const document = partWithBoxes('ブラケット', 2);
    const once = await embedPart(EMPTY_PART_LIBRARY, document, 'ブラケット.pcad', '../ブラケット.pcad', {
      importedAt: IMPORTED_AT,
    });
    const twice = await embedPart(once.library, document, 'ブラケット.pcad', '../ブラケット.pcad', {
      importedAt: '2026-09-07T00:00:00.000Z',
    });
    expect(twice.partRef).toBe(once.partRef);
    expect(twice.reused).toBe(true);
    expect(twice.library.partFiles).toHaveLength(1);
    expect(twice.library.parts.size).toBe(1);
  });

  it('中身が同じなら別のファイル名から取り込んでも最初の素性を残す', async () => {
    const document = partWithBoxes('ブラケット', 2);
    const once = await embedPart(EMPTY_PART_LIBRARY, document, 'ブラケット.pcad', '../ブラケット.pcad', {
      importedAt: IMPORTED_AT,
    });
    const twice = await embedPart(once.library, document, '複製.pcad', '../複製.pcad', {
      importedAt: '2026-09-07T00:00:00.000Z',
    });
    expect(partFileOf(twice.library, twice.partRef)?.fileName).toBe('ブラケット.pcad');
    expect(partFileOf(twice.library, twice.partRef)?.importedAt).toBe(IMPORTED_AT);
  });

  it('中身が違えば別の partRef で並んで入る', async () => {
    const first = await embedPart(EMPTY_PART_LIBRARY, partWithBoxes('板', 1), '板.pcad', '../板.pcad', {
      importedAt: IMPORTED_AT,
    });
    const second = await embedPart(first.library, partWithBoxes('軸', 3), '軸.pcad', '../軸.pcad', {
      importedAt: IMPORTED_AT,
    });
    expect(second.partRef).toBe('part-2');
    expect(second.library.partFiles.map((partFile) => partFile.ref)).toEqual(['part-1', 'part-2']);
  });

  it('呼び手が渡した 3 種の添付と別ダイジェストを同じ partRef で保持する', async () => {
    const attachments = sampleAttachments();
    const embedded = await embedPart(
      EMPTY_PART_LIBRARY,
      partWithBoxes('読み込み部品', 1),
      '読み込み部品.pcad',
      '../読み込み部品.pcad',
      { importedAt: IMPORTED_AT, attachments },
    );
    expect(partAttachmentsOf(embedded.library, embedded.partRef)).toEqual(attachments);
    expect(partFileOf(embedded.library, embedded.partRef)?.attachmentsDigest).toBe(
      await attachmentsDigestOf(attachments),
    );
  });

  it('文書が同じでも添付ダイジェストが違えば別の partRef で抱き込む', async () => {
    const document = partWithBoxes('読み込み部品', 1);
    const first = await embedPart(EMPTY_PART_LIBRARY, document, 'a.pcad', '../a.pcad', {
      importedAt: IMPORTED_AT,
      attachments: sampleAttachments(1),
    });
    const second = await embedPart(first.library, document, 'b.pcad', '../b.pcad', {
      importedAt: IMPORTED_AT,
      attachments: sampleAttachments(2),
    });
    expect(second.reused).toBe(false);
    expect(second.partRef).toBe('part-2');
  });
});

describe('nextPartRef', () => {
  it('番号を再利用しない(途中を消しても最大連番の次)', () => {
    const library: PartLibrary = {
      partFiles: [
        {
          ref: 'part-3',
          fileName: '板.pcad',
          path: '../板.pcad',
          contentHash: 'a',
          attachmentsDigest: 'b',
          importedAt: IMPORTED_AT,
        },
      ],
      parts: new Map(),
      attachments: new Map(),
    };
    expect(nextPartRef(library)).toBe('part-4');
    expect(nextPartRef(EMPTY_PART_LIBRARY)).toBe('part-1');
  });
});

describe('replacePartDocument', () => {
  it('差し替えた後のハッシュは新しい文書のハッシュになる', async () => {
    const before = partWithBoxes('ブラケット', 2);
    const after = partWithBoxes('ブラケット', 5);
    const embedded = await embedPart(EMPTY_PART_LIBRARY, before, 'ブラケット.pcad', '../ブラケット.pcad', {
      importedAt: IMPORTED_AT,
    });
    const replaced = await replacePartDocument(embedded.library, embedded.partRef, after, {
      importedAt: '2026-09-07T00:00:00.000Z',
    });
    const partFile = partFileOf(replaced, embedded.partRef);
    expect(partFile?.contentHash).toBe(await contentHashOf(after));
    expect(partFile?.importedAt).toBe('2026-09-07T00:00:00.000Z');
    // 取り込み元のファイル名と相対パスは差し替えても変わらない。
    expect(partFile?.fileName).toBe('ブラケット.pcad');
    expect(partFile?.path).toBe('../ブラケット.pcad');
    expect(partOf(replaced, embedded.partRef)).toEqual(after);
  });

  it('知らない partRef なら何もしない(例外を投げない)', async () => {
    const embedded = await embedPart(
      EMPTY_PART_LIBRARY,
      partWithBoxes('ブラケット', 1),
      'ブラケット.pcad',
      '../ブラケット.pcad',
      { importedAt: IMPORTED_AT },
    );
    const replaced = await replacePartDocument(embedded.library, 'part-9', partWithBoxes('軸', 2));
    expect(replaced).toBe(embedded.library);
  });

  it('他の partRef の素性と文書は変えない', async () => {
    const first = await embedPart(EMPTY_PART_LIBRARY, partWithBoxes('板', 1), '板.pcad', '../板.pcad', {
      importedAt: IMPORTED_AT,
    });
    const second = await embedPart(first.library, partWithBoxes('軸', 3), '軸.pcad', '../軸.pcad', {
      importedAt: IMPORTED_AT,
    });
    const replaced = await replacePartDocument(second.library, 'part-2', partWithBoxes('軸', 6), {
      importedAt: IMPORTED_AT,
    });
    expect(partFileOf(replaced, 'part-1')).toEqual(partFileOf(second.library, 'part-1'));
    expect(partOf(replaced, 'part-1')).toEqual(partOf(second.library, 'part-1'));
  });

  it('差し替えで渡した添付とダイジェストも同じ partRef のまま更新する', async () => {
    const embedded = await embedPart(
      EMPTY_PART_LIBRARY,
      partWithBoxes('部品', 1),
      '部品.pcad',
      '../部品.pcad',
      { importedAt: IMPORTED_AT, attachments: sampleAttachments(1) },
    );
    const nextAttachments = sampleAttachments(2);
    const replaced = await replacePartDocument(
      embedded.library,
      embedded.partRef,
      partWithBoxes('部品', 2),
      { importedAt: IMPORTED_AT, attachments: nextAttachments },
    );
    expect(partAttachmentsOf(replaced, embedded.partRef)).toEqual(nextAttachments);
    expect(partFileOf(replaced, embedded.partRef)?.attachmentsDigest).toBe(
      await attachmentsDigestOf(nextAttachments),
    );
  });
});

describe('staleParts', () => {
  it('ハッシュが違う partRef だけを返す', async () => {
    const first = await embedPart(EMPTY_PART_LIBRARY, partWithBoxes('板', 1), '板.pcad', '../板.pcad', {
      importedAt: IMPORTED_AT,
    });
    const second = await embedPart(first.library, partWithBoxes('軸', 3), '軸.pcad', '../軸.pcad', {
      importedAt: IMPORTED_AT,
    });
    const library = second.library;
    const hashesOnDisk = new Map([
      ['part-1', partFileOf(library, 'part-1')?.contentHash ?? ''],
      ['part-2', await contentHashOf(partWithBoxes('軸', 6))],
    ]);
    expect(staleParts(library, hashesOnDisk)).toEqual(['part-2']);
  });

  it('元のファイルが読めなかったもの(表に無い partRef)は返さない', async () => {
    const embedded = await embedPart(
      EMPTY_PART_LIBRARY,
      partWithBoxes('板', 1),
      '板.pcad',
      '../板.pcad',
      { importedAt: IMPORTED_AT },
    );
    expect(staleParts(embedded.library, new Map())).toEqual([]);
  });

  it('全部そろっていて中身も同じなら空を返す', async () => {
    const document = partWithBoxes('板', 1);
    const embedded = await embedPart(EMPTY_PART_LIBRARY, document, '板.pcad', '../板.pcad', {
      importedAt: IMPORTED_AT,
    });
    const hashesOnDisk = new Map([['part-1', await contentHashOf(document)]]);
    expect(staleParts(embedded.library, hashesOnDisk)).toEqual([]);
  });
});

describe('抱き込んだ部品の大きさ(計画書§1.5-19)', () => {
  it('20 フィーチャーの部品を 10 種抱き込んでも圧縮後 500KB 以下', async () => {
    let library: PartLibrary = EMPTY_PART_LIBRARY;
    for (let index = 1; index <= 10; index += 1) {
      const document = partWithBoxes(`部品${String(index)}`, 20);
      const embedded = await embedPart(
        library,
        document,
        `部品${String(index)}.pcad`,
        `../部品${String(index)}.pcad`,
        { importedAt: IMPORTED_AT },
      );
      library = embedded.library;
    }
    expect(library.partFiles).toHaveLength(10);

    const encoder = new TextEncoder();
    let plainBytes = 0;
    let packedBytes = 0;
    for (const [, document] of library.parts) {
      const bytes = encoder.encode(canonicalPartDocumentText(document));
      plainBytes += bytes.byteLength;
      packedBytes += await deflatedByteLength(bytes);
    }
    // 圧縮の水準は `packages/io` の `DOCUMENT_LEVEL`(6)と同じ既定を使う。
    // 2026-09-06 の実測: そのままで 95,321 バイト、縮めて 5,046 バイト(1 部品あたり
    // 9,480 バイト / 約 505 バイト)。上限 500KB に対して 1% 未満で、自動保存(FR-805)が
    // 5 分ごとに書ける大きさである。基本形状 20 段の部品なので、スケッチを多く持つ部品は
    // これより大きくなる(1 段あたり約 474 バイト、縮める前)。
    expect(packedBytes).toBeLessThanOrEqual(500 * 1024);
    expect(plainBytes).toBeGreaterThan(0);
  });
});

/** DEFLATE で縮めた後のバイト数(`.pcada` の 1 エントリに入る大きさの目安)。 */
async function deflatedByteLength(bytes: Uint8Array<ArrayBuffer>): Promise<number> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  const packed = await new Response(stream).arrayBuffer();
  return packed.byteLength;
}
