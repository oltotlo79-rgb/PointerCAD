import {
  EMPTY_PART_LIBRARY,
  SUB_ASSEMBLY_CYCLE_MESSAGE,
  addComponent,
  createAssemblyDocument,
  createAssemblyDocumentBundle,
  createComponentFor,
  createEmptyPartDocument,
  emptyEmbeddedPartAttachments,
  type AssemblyDocument,
  type EmbeddedPartAttachments,
  type PartLibrary,
  type MateTarget,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  confirmComponentReplacement,
  placeSubAssemblyBundle,
  prepareComponentReplacement,
} from './replaceCommands.js';

function importedAttachments(): EmbeddedPartAttachments {
  return {
    shapes: new Map([['shape-1', new Uint8Array([1, 2, 3])]]),
    meshes: new Map(),
    canvases: new Map([['canvas-1', new Uint8Array([4, 5])]]),
  };
}

function childBundle() {
  let child = createAssemblyDocument('子組');
  child = addComponent(
    child,
    createComponentFor(child, { kind: 'part', partRef: 'part-1' }, { partName: '板' }),
  );
  const attachments = importedAttachments();
  const library: PartLibrary = {
    parts: new Map([['part-1', createEmptyPartDocument()]]),
    attachments: new Map([['part-1', attachments]]),
    assemblies: new Map(),
    partFiles: [{
      ref: 'part-1',
      fileName: 'plate.pcad',
      path: 'parts/plate.pcad',
      contentHash: 'content',
      attachmentsDigest: 'attachments',
      importedAt: '2026-09-08T00:00:00.000Z',
    }],
  };
  return createAssemblyDocumentBundle(child, library);
}

function placeIntoEmpty() {
  return placeSubAssemblyBundle(
    createAssemblyDocument('親組'),
    EMPTY_PART_LIBRARY,
    childBundle(),
  );
}

describe('placeSubAssemblyBundle', () => {
  it('サブアセンブリを1部品として末尾へ置く', () => {
    const result = placeIntoEmpty();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.components).toHaveLength(1);
    expect(result.component.source.kind).toBe('subAssembly');
  });

  it('置いた行には読み込んだ組の名前を使う', () => {
    const result = placeIntoEmpty();
    if (!result.ok) throw new Error(result.message);
    expect(result.component.name).toContain('子組');
  });

  it('最初に置いた組は通常の部品と同じく固定する', () => {
    const result = placeIntoEmpty();
    if (!result.ok) throw new Error(result.message);
    expect(result.component.fixed).toBe(true);
  });

  it('子組と部品文書をライブラリへ抱き込む', () => {
    const result = placeIntoEmpty();
    if (!result.ok || result.component.source.kind !== 'subAssembly') {
      throw new Error('サブアセンブリを置けませんでした');
    }
    expect(result.library.assemblies?.has(result.component.source.assemblyRef)).toBe(true);
    expect(result.library.parts.size).toBe(1);
  });

  it('既存のpart参照と重なると新しい参照へ写す', () => {
    const existing: PartLibrary = {
      ...EMPTY_PART_LIBRARY,
      parts: new Map([['part-1', createEmptyPartDocument()]]),
      attachments: new Map([['part-1', emptyEmbeddedPartAttachments()]]),
    };
    const result = placeSubAssemblyBundle(createAssemblyDocument('親組'), existing, childBundle());
    if (!result.ok || result.component.source.kind !== 'subAssembly') throw new Error('fixture');
    const stored = result.library.assemblies?.get(result.component.source.assemblyRef);
    expect(stored?.components[0].source).toEqual({ kind: 'part', partRef: 'part-2' });
    expect(result.library.parts.has('part-1')).toBe(true);
    expect(result.library.parts.has('part-2')).toBe(true);
  });

  it('添付も写したpart参照と同じ名前で残す', () => {
    const result = placeIntoEmpty();
    if (!result.ok) throw new Error(result.message);
    const ref = [...result.library.parts.keys()][0];
    expect(result.library.attachments.get(ref)?.shapes.get('shape-1'))
      .toEqual(new Uint8Array([1, 2, 3]));
    expect(result.library.attachments.get(ref)?.canvases.get('canvas-1'))
      .toEqual(new Uint8Array([4, 5]));
  });

  it('元ファイルの記録も写したpart参照へそろえる', () => {
    const result = placeIntoEmpty();
    if (!result.ok) throw new Error(result.message);
    expect(result.library.partFiles).toHaveLength(1);
    expect(result.library.partFiles[0]).toMatchObject({
      ref: [...result.library.parts.keys()][0],
      fileName: 'plate.pcad',
      path: 'parts/plate.pcad',
    });
  });

  it('入力した親文書とライブラリを変更しない', () => {
    const parent = createAssemblyDocument('親組');
    const library = EMPTY_PART_LIBRARY;
    const result = placeSubAssemblyBundle(parent, library, childBundle());
    expect(result.ok).toBe(true);
    expect(parent.components).toEqual([]);
    expect(library.parts.size).toBe(0);
    expect(library.assemblies?.size).toBe(0);
  });

  it('読み込んだ子組の参照も変更しない', () => {
    const bundle = childBundle();
    const before = bundle.document.components[0].source;
    const result = placeSubAssemblyBundle(createAssemblyDocument('親組'), EMPTY_PART_LIBRARY, bundle);
    expect(result.ok).toBe(true);
    expect(bundle.document.components[0].source).toEqual(before);
  });

  it('入れ子の子組参照も衝突しない名前へ一緒に写す', () => {
    const grandchild = createAssemblyDocument('孫組');
    let child = createAssemblyDocument('子組');
    child = addComponent(
      child,
      createComponentFor(child, { kind: 'subAssembly', assemblyRef: 'assembly-1' }, {
        partName: '孫組',
      }),
    );
    const bundle = createAssemblyDocumentBundle(child, {
      ...EMPTY_PART_LIBRARY,
      assemblies: new Map([['assembly-1', grandchild]]),
    });
    const existing = {
      ...EMPTY_PART_LIBRARY,
      assemblies: new Map([['assembly-1', createAssemblyDocument('既存')]]),
    };
    const result = placeSubAssemblyBundle(createAssemblyDocument('親組'), existing, bundle);
    if (!result.ok || result.component.source.kind !== 'subAssembly') throw new Error('fixture');
    const storedRoot = result.library.assemblies?.get(result.component.source.assemblyRef);
    expect(storedRoot?.components[0].source).toEqual({
      kind: 'subAssembly',
      assemblyRef: 'assembly-2',
    });
    expect(result.component.source.assemblyRef).toBe('assembly-3');
  });

  it('読み直して物の同一性が変わっても現在の保存内容なら自分自身として断る', () => {
    const parent = createAssemblyDocument('親組');
    const copied = { ...parent };
    const result = placeSubAssemblyBundle(
      parent,
      EMPTY_PART_LIBRARY,
      createAssemblyDocumentBundle(copied),
      parent,
    );
    expect(result).toEqual({ ok: false, message: SUB_ASSEMBLY_CYCLE_MESSAGE });
  });

  it('別に作った同名・同じローカルIDの組は置ける', () => {
    const parent = createAssemblyDocument('同名');
    const child = createAssemblyDocument('同名');
    expect(placeSubAssemblyBundle(
      parent,
      EMPTY_PART_LIBRARY,
      createAssemblyDocumentBundle(child),
    ).ok).toBe(true);
  });
});

function replacementDocument(targetKind: 'origin' | 'face'): AssemblyDocument {
  let document = createAssemblyDocument('置換');
  document = addComponent(
    document,
    createComponentFor(document, { kind: 'part', partRef: 'old' }, { partName: '旧' }),
  );
  document = addComponent(
    document,
    createComponentFor(document, { kind: 'part', partRef: 'other' }, { partName: '相手' }),
  );
  const a: MateTarget = targetKind === 'origin'
    ? { kind: 'origin', componentId: 'component-1', element: 'origin' }
    : {
        kind: 'subShape',
        componentId: 'component-1',
        ref: {
          bodyFeatureId: 'solid-1',
          index: 0,
          fingerprint: {
            kind: 'face',
            surfaceKind: 'plane',
            area: 100,
            position: [0, 0, 0],
            axis: [0, 0, 1],
            radius: null,
          },
        },
      };
  return {
    ...document,
    mates: [{
      id: 'mate-1',
      name: '一致1',
      kind: 'coincident',
      a,
      b: { kind: 'origin', componentId: 'component-2', element: 'origin' },
      flipped: false,
      suppressed: false,
    }],
  };
}

describe('部品置換の予告と確定', () => {
  it('全対象を選び直せると余計な確認を要求しない', () => {
    const prepared = prepareComponentReplacement(
      replacementDocument('origin'),
      'component-1',
      { kind: 'part', partRef: 'new' },
      [],
    );
    expect(prepared?.requiresConfirmation).toBe(false);
  });

  it('選び直せない面があると確認を要求する', () => {
    const prepared = prepareComponentReplacement(
      replacementDocument('face'),
      'component-1',
      { kind: 'part', partRef: 'new' },
      [],
    );
    expect(prepared?.requiresConfirmation).toBe(true);
    expect(prepared?.plan.unmatchedCount).toBe(1);
  });

  it('予告だけでは文書を変更しない', () => {
    const before = replacementDocument('origin');
    prepareComponentReplacement(before, 'component-1', { kind: 'part', partRef: 'new' }, []);
    expect(before.components[0].source).toEqual({ kind: 'part', partRef: 'old' });
  });

  it('確定すると予告済みの文書をそのまま返す', () => {
    const prepared = prepareComponentReplacement(
      replacementDocument('origin'),
      'component-1',
      { kind: 'part', partRef: 'new' },
      [],
    );
    if (prepared === null) throw new Error('置換を予告できませんでした');
    expect(confirmComponentReplacement(prepared)).toBe(prepared.plan.after);
    expect(confirmComponentReplacement(prepared).components[0].source)
      .toEqual({ kind: 'part', partRef: 'new' });
  });
});
