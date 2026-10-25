import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, type AssemblyDocument, type ContextReferenceLink, createAssemblyDocument, createComponentFor,
  type SubShapeRef,
} from '@pointercad/model';
import {
  appendReference, commitContextReference, createAssemblyDocumentBundle, createEmptyPartDocument, embedPart,
  partLibraryOfBundle, type PartLibrary, type ReferencePointFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { isRecord, isUnknownArray } from './guards.js';
import { readDocumentBundle, writeDocumentBundle } from './pcadFile.js';

const SAVED_AT = '2026-10-16T00:00:00.000Z';
const FACE: SubShapeRef = { bodyFeatureId: 'extrude-1', index: 3, fingerprint: { kind: 'face', surfaceKind: 'cylinder',
  area: 10, position: [5, 0, 0], axis: [0, 0, 1], radius: 2 } };

function scene(): { readonly document: AssemblyDocument; readonly link: ContextReferenceLink } {
  let document = createAssemblyDocument('文脈');
  const a = createComponentFor(document, { kind: 'part', partRef: 'part-1' });
  document = addComponent(document, { ...a, placement: { ...a.placement, position: [expressionValueFromNumber(10),
    expressionValueFromNumber(20), expressionValueFromNumber(0)] } });
  const b = createComponentFor(document, { kind: 'part', partRef: 'part-2' });
  document = addComponent(document, b);
  return { document, link: { id: 'context-1', targetComponentId: a.id, targetReferenceId: 'point-1',
    sourceComponentId: b.id, source: FACE } };
}

describe('組立の文脈の参照の保存', () => {
  it('結び付けを書いて読むと同じで、書き直しても同じ文字列になる', () => {
    const { document, link } = scene();
    const saved: AssemblyDocument = { ...document, contextReferences: [link] };
    const text = writeAssemblyDocument(saved, { savedAt: SAVED_AT });
    const restored = readAssemblyDocument(text);
    if (!restored.ok) throw new Error(JSON.stringify(restored.error));
    expect(restored.document.contextReferences).toEqual([link]);
    expect(writeAssemblyDocument(restored.document, { savedAt: SAVED_AT })).toBe(text);
  });

  it('欄の無い古い文書は、欄を作らずに開ける', () => {
    const { document } = scene();
    const restored = readAssemblyDocument(writeAssemblyDocument(document, { savedAt: SAVED_AT }));
    if (!restored.ok) throw new Error(JSON.stringify(restored.error));
    expect('contextReferences' in restored.document).toBe(false);
  });

  it.each<readonly [string, (link: ContextReferenceLink) => readonly ContextReferenceLink[]]>([
    ['同じ id が2つ', (link) => [link, { ...link, targetReferenceId: 'point-2' }]],
    ['同じ基準点を2つの結び付けが決める', (link) => [link, { ...link, id: 'context-2' }]],
    ['元の配置が無い', (link) => [{ ...link, sourceComponentId: 'component-99' }]],
    ['先の配置が無い', (link) => [{ ...link, targetComponentId: 'component-99' }]],
    ['元と先が同じ配置', (link) => [{ ...link, sourceComponentId: link.targetComponentId }]],
  ])('壊れた保存(%s)は開かない', (_case, build) => {
    const { document, link } = scene();
    const text = writeAssemblyDocument({ ...document, contextReferences: build(link) }, { savedAt: SAVED_AT });
    expect(readAssemblyDocument(text).ok).toBe(false);
  });
});

describe('組立の文脈の参照の循環の保存', () => {
  /** 部品の ref を順に置いた組立。同じ ref を2回渡すと、同じ部品の別の配置になる。 */
  function placed(partRefs: readonly string[]): { readonly document: AssemblyDocument; readonly ids: readonly string[] } {
    let document = createAssemblyDocument('循環');
    const ids: string[] = [];
    for (const partRef of partRefs) {
      const component = createComponentFor(document, { kind: 'part', partRef });
      document = addComponent(document, component);
      ids.push(component.id);
    }
    return { document, ids };
  }

  function links(ids: readonly string[], pairs: readonly (readonly [number, number])[]): ContextReferenceLink[] {
    return pairs.map(([target, source], index) => {
      const targetComponentId = ids[target], sourceComponentId = ids[source];
      if (targetComponentId === undefined || sourceComponentId === undefined) throw new Error('component');
      return { id: `context-${String(index + 1)}`, targetComponentId, targetReferenceId: 'point-1', sourceComponentId, source: FACE };
    });
  }

  it.each<readonly [string, readonly string[], readonly (readonly [number, number])[]]>([
    ['2本の循環', ['part-1', 'part-2'], [[0, 1], [1, 0]]],
    ['3本の循環', ['part-1', 'part-2', 'part-3'], [[0, 1], [1, 2], [2, 0]]],
    ['同じ部品の別の配置どうし', ['part-1', 'part-1'], [[0, 1]]],
    ['同じ部品の別の配置を通る2本の循環', ['part-1', 'part-2', 'part-1'], [[0, 1], [1, 2]]],
  ])('循環する保存(%s)は開かない', (_case, partRefs, pairs) => {
    const { document, ids } = placed(partRefs);
    const text = writeAssemblyDocument({ ...document, contextReferences: links(ids, pairs) }, { savedAt: SAVED_AT });
    expect(readAssemblyDocument(text).ok).toBe(false);
  });

  it.each<readonly [string, readonly string[], readonly (readonly [number, number])[]]>([
    ['循環の無い一本道', ['part-1', 'part-2', 'part-3'], [[0, 1], [1, 2]]],
    ['同じ部品を2か所に置いた元', ['part-1', 'part-2', 'part-3', 'part-2'], [[0, 1], [2, 3]]],
  ])('%s は開け、同じ結び付けと同じ文字列に戻る', (_case, partRefs, pairs) => {
    const { document, ids } = placed(partRefs);
    const saved = links(ids, pairs);
    const text = writeAssemblyDocument({ ...document, contextReferences: saved }, { savedAt: SAVED_AT });
    const restored = readAssemblyDocument(text);
    if (!restored.ok) throw new Error(JSON.stringify(restored.error));
    expect(restored.document.contextReferences).toEqual(saved);
    expect(writeAssemblyDocument(restored.document, { savedAt: SAVED_AT })).toBe(text);
  });

  it('1000 部品の一本道は開け、最後で閉じる循環は開かない', () => {
    const { document, ids } = placed(Array.from({ length: 1000 }, (_, index) => `part-${String(index)}`));
    const chain = links(ids, Array.from({ length: 999 }, (_, i) => [i, i + 1] as const));
    const opened = readAssemblyDocument(writeAssemblyDocument({ ...document, contextReferences: chain }, { savedAt: SAVED_AT }));
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    expect(opened.document.contextReferences).toHaveLength(999);
    const closed = links(ids, [...Array.from({ length: 999 }, (_, i) => [i, i + 1] as const), [999, 0]]);
    expect(readAssemblyDocument(writeAssemblyDocument({ ...document, contextReferences: closed }, { savedAt: SAVED_AT })).ok)
      .toBe(false);
  });
});

describe('EX18 W09 循環を含む保存の読込みと修復で循環になる置き換えは断り、開いていた組立と保存先のバイトを変えない', () => {
  const POINT: ReferencePointFeature = { id: 'point-1', name: '点1', visible: true, kind: 'referencePoint',
    definition: { kind: 'coordinate', at: { mode: 'absolute', x: expressionValueFromNumber(0),
      y: expressionValueFromNumber(0), z: expressionValueFromNumber(0) } } };
  /** 製品の読み手が結び付けの欄の誤りとして返す理由(assemblyJson.ts の failField)。 */
  const CYCLE_REFUSAL = ['invalidField', 'ファイルの中身が壊れています(document.contextReferences の形が違います)。'];
  /** 足す結び付けの先の基準点。既存の結び付けと先が重ならないので、重なりではなく循環だけで断られる。 */
  const ADDED_POINT = 'point-9';
  /** 循環しない対照の元(配置 3 = 部品 D。D の点を決める結び付けは無い)。 */
  const CONTROL_SOURCE = 3;
  /** 足す 1 本(先, 元)。配置 0..4 = 部品 A・B・C・D と、A の別の配置(共有 partRef)。 */
  const CYCLES: readonly (readonly [string, number, number])[] = [
    ['2 辺(A←B に B←A を足す)', 1, 0],
    ['3 辺(A←B←C に C←A を足す)', 2, 0],
    ['共有 partRef(A←B←C に、C←A の別の配置を足す)', 2, 4],
  ];

  /**
   * 開いている組立: 配置 0..4 = 部品 A・B・C・D(各々基準点 point-1)と A の別の配置。結び付けは A←B・B←C・C←D
   * (context-1〜3)。製品の書き手で .pcada にし、製品の読み手で開いた束と、そのバイトを返す。
   */
  async function openedAssembly() {
    let library: PartLibrary = { partFiles: [], parts: new Map(), attachments: new Map() };
    const refs: string[] = [];
    for (const name of ['A', 'B', 'C', 'D']) {
      const embedded = await embedPart(library, { ...appendReference(createEmptyPartDocument(), POINT), name },
        `${name}.pcad`, `${name}.pcad`, { importedAt: SAVED_AT });
      library = embedded.library;
      refs.push(embedded.partRef);
    }
    let document = createAssemblyDocument('W09 保存');
    const ids: string[] = [];
    for (const partRef of [...refs, refs[0]]) {
      if (partRef === undefined) throw new Error('part');
      const component = createComponentFor(document, { kind: 'part', partRef });
      document = addComponent(document, component);
      ids.push(component.id);
    }
    const linkOf = (id: string, target: number, source: number, targetReferenceId = 'point-1'): ContextReferenceLink => {
      const targetComponentId = ids[target], sourceComponentId = ids[source];
      if (targetComponentId === undefined || sourceComponentId === undefined) throw new Error('component');
      return { id, targetComponentId, targetReferenceId, sourceComponentId, source: FACE };
    };
    const links = [linkOf('context-1', 0, 1), linkOf('context-2', 1, 2), linkOf('context-3', 2, 3)];
    const bytes = await writeDocumentBundle(createAssemblyDocumentBundle({ ...document, contextReferences: links }, library),
      { savedAt: SAVED_AT });
    const read = await readDocumentBundle(bytes, 'assembly');
    if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('open');
    return { bytes, opened: read.bundle, ids, linkOf };
  }

  /** 保存の JSON の文字列へ、製品の書き手を通さずに結び付けを 1 本足す(面の参照は 1 本目と同じ形を写す)。 */
  function withHandMadeLink(text: string, link: { readonly id: string; readonly target: string; readonly source: string }): string {
    const raw: unknown = JSON.parse(text);
    const document = isRecord(raw) ? raw['document'] : undefined;
    const links = isRecord(document) ? document['contextReferences'] : undefined;
    const first: unknown = isUnknownArray(links) ? links[0] : undefined;
    if (!isRecord(raw) || !isRecord(document) || !isUnknownArray(links) || !isRecord(first)) throw new Error('JSON');
    const added = { id: link.id, targetComponentId: link.target, targetReferenceId: ADDED_POINT,
      sourceComponentId: link.source, source: first['source'] };
    return JSON.stringify({ ...raw, document: { ...document, contextReferences: [...links, added] } });
  }

  it.each(CYCLES)('手で作った JSON の %s は理由付きで開かず、開いていた組立と保存先のバイトが変わらない。元を D に替えた対照は開ける',
    async (_case, target, source) => {
      const { bytes, opened, ids } = await openedAssembly();
      const links = opened.document.contextReferences;
      const text = writeAssemblyDocument(opened.document, { savedAt: SAVED_AT, partFiles: opened.partFiles });
      const id = (index: number): string => {
        const value = ids[index];
        if (value === undefined) throw new Error('component');
        return value;
      };
      const refused = readAssemblyDocument(withHandMadeLink(text, { id: 'hand-1', target: id(target), source: id(source) }));
      expect(refused.ok ? 'opened' : [refused.error.code, refused.error.message]).toEqual(CYCLE_REFUSAL);
      const control = readAssemblyDocument(withHandMadeLink(text, { id: 'hand-1', target: id(target), source: id(CONTROL_SOURCE) }));
      if (!control.ok) throw new Error(JSON.stringify(control.error));
      expect(control.document.contextReferences?.map((link) => link.id)).toEqual(['context-1', 'context-2', 'context-3', 'hand-1']);
      // 開いていた組立は読み込みの前のまま。同じ保存時刻で書き直すと、開いた元のバイトと一致する(保存先の中身が変わらない)。
      expect(opened.document.contextReferences).toBe(links);
      expect(await writeDocumentBundle(opened, { savedAt: SAVED_AT })).toEqual(bytes);
    });

  it.each(CYCLES)('PCAD ZIP(.pcada)の %s は理由付きで開かず、入力のバイト・開いていた組立・保存先が変わらない。対照は開ける',
    async (_case, target, source) => {
      const { bytes, opened, linkOf } = await openedAssembly();
      const links = opened.document.contextReferences ?? [];
      const zipWith = (added: ContextReferenceLink) => writeDocumentBundle(
        { ...opened, document: { ...opened.document, contextReferences: [...links, added] } }, { savedAt: SAVED_AT });
      const cyclic = await zipWith(linkOf('zip-1', target, source, ADDED_POINT));
      const cyclicCopy = Uint8Array.from(cyclic);
      const refused = await readDocumentBundle(cyclic, 'assembly');
      expect(refused.ok ? 'opened' : [refused.error.code, refused.error.message]).toEqual(CYCLE_REFUSAL);
      expect(cyclic).toEqual(cyclicCopy);
      const control = await readDocumentBundle(await zipWith(linkOf('zip-1', target, CONTROL_SOURCE, ADDED_POINT)), 'assembly');
      if (!control.ok || control.bundle.kind !== 'assembly') throw new Error('control');
      expect(control.bundle.document.contextReferences?.map((link) => link.id))
        .toEqual(['context-1', 'context-2', 'context-3', 'zip-1']);
      expect(opened.document.contextReferences).toBe(links);
      expect(await writeDocumentBundle(opened, { savedAt: SAVED_AT })).toEqual(bytes);
    });

  it.each<readonly [string, string, number, number]>([
    ['2 辺(B←C の元を A へ替える)', 'context-2', 1, 0],
    ['3 辺(C←D の元を A へ替える)', 'context-3', 2, 0],
    ['共有 partRef(C←D の元を A の別の配置へ替える)', 'context-3', 2, 4],
  ])('修復で %s と循環になる置き換えは cyclicReference で断り、開いていた組立・一式と保存先のバイトが変わらない',
    async (_case, id, target, source) => {
      const { bytes, opened, linkOf } = await openedAssembly();
      const library = partLibraryOfBundle(opened);
      const document = opened.document;
      const before = writeAssemblyDocument(document, { savedAt: SAVED_AT, partFiles: library.partFiles });
      // 修復: 既存の結び付けの元を、同じ id のまま別の配置の面へ置き換える(画面の「参照を置き換える」と同じ確定)。
      expect(await commitContextReference(document, library, linkOf(id, target, source), () => [5, 0, 0]))
        .toEqual({ code: 'cyclicReference', linkId: id });
      expect(writeAssemblyDocument(document, { savedAt: SAVED_AT, partFiles: library.partFiles })).toBe(before);
      expect(opened.document).toBe(document);
      expect(await writeDocumentBundle(opened, { savedAt: SAVED_AT })).toEqual(bytes);
    });

  it('修復の対照: B←C の元を D へ替える置き換えは循環でなく受け、同じ id のまま元だけが替わり、保存と再読込で戻る', async () => {
    const { bytes, opened, ids, linkOf } = await openedAssembly();
    const result = await commitContextReference(opened.document, partLibraryOfBundle(opened), linkOf('context-2', 1, 3),
      () => [5, 0, 0]);
    if ('code' in result) throw new Error(JSON.stringify(result));
    expect(result.document.contextReferences?.map((link) => [link.id, link.sourceComponentId]))
      .toEqual([['context-1', ids[1]], ['context-2', ids[3]], ['context-3', ids[3]]]);
    const saved = await writeDocumentBundle(createAssemblyDocumentBundle(result.document, result.library), { savedAt: SAVED_AT });
    expect(saved).not.toEqual(bytes);
    const reread = await readDocumentBundle(saved, 'assembly');
    if (!reread.ok || reread.bundle.kind !== 'assembly') throw new Error('reread');
    expect(reread.bundle.document.contextReferences).toEqual(result.document.contextReferences);
    // 受けた確定でも、開いていた組立はその場で書き換えない。
    expect(await writeDocumentBundle(opened, { savedAt: SAVED_AT })).toEqual(bytes);
  });
});
