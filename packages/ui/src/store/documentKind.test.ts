/**
 * 文書の種類の判定(P7 §0.a-0.10、計画書タスク5)の検査。
 *
 * ここで固定するのは 2 つ。
 * ①種類の判定が 3 つの状態を正しく返す(`part` / `assembly` / `empty`)。
 * ②**アセンブリを開くと部品は読めなくなる**(1 つの窓で 2 つの文書を開かない)。
 *
 * ストアそのものを動かす検査(新規で閉じる・開くと切り替わる)は
 * `useAppStore.test.ts` の側にある。
 */
import { createAssemblyDocument, createDrawingDocument, createEmptyPartDocument } from '@pointercad/model';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { useAppStore } from './useAppStore.js';

import {
  activeDocument,
  activeFileName,
  activeAssemblyDocument,
  activeDocumentKind,
  activeDrawingDocument,
  activePartDocument,
  type DocumentKind,
} from './documentKind.js';

const part = createEmptyPartDocument();
const assembly = createAssemblyDocument('組み立て1');
const drawing = createDrawingDocument('図面1', {
  sourceRef: 'source-1', sourceKind: 'part', fileName: 'part.pcad', path: '',
  contentHash: 'hash', importedAt: '2026-09-09T00:00:00.000Z',
});

describe('いま開いている文書の種類(P7 タスク5)', () => {
  it('文書を必ず持つ呼出しと、文書がない可能性のある呼出しの型を区別する', () => {
    expectTypeOf(activeDocumentKind({ document: part, assembly: null, drawing: null }))
      .toEqualTypeOf<Exclude<DocumentKind, 'empty'>>();
    expectTypeOf(activeDocumentKind({ document: null, assembly: null, drawing: null }))
      .toEqualTypeOf<DocumentKind>();
    expect(activeDocumentKind({ document: null, assembly: null, drawing: null })).toBe('empty');
  });
  it('共通入口の part は従来の文書・保存済み文書・名前を返す', () => {
    const state = { ...useAppStore.getState(), document: part, assembly: null, drawing: null,
      savedDocument: part, fileName: 'part.pcad' };
    expect(activeDocument(state)).toEqual({ kind: 'part', document: part, saved: part,
      fileName: 'part.pcad', documentId: state.activeDocumentId });
    expect(activeFileName(state)).toBe('part.pcad');
  });

  it('共通入口の assembly は裏の part の名前・保存状態を採らない', () => {
    const state = { ...useAppStore.getState(), document: part, assembly, drawing: null,
      fileName: 'hidden.pcad', assemblyFileName: 'assembly.pcada' };
    const active = activeDocument(state);
    expect(active.kind).toBe('assembly');
    expect(active.document).toBe(assembly);
    expect(activeFileName(state)).toBe('assembly.pcada');
  });
  it('部品だけを持っていれば part', () => {
    expect(activeDocumentKind({ document: part, assembly: null, drawing: null })).toBe('part');
  });

  it('アセンブリを持っていれば assembly', () => {
    expect(activeDocumentKind({ document: part, assembly, drawing: null })).toBe('assembly');
  });

  it('どちらも無ければ empty', () => {
    expect(activeDocumentKind({ document: null, assembly: null, drawing: null })).toBe('empty');
  });

  it('アセンブリを開くと部品は読めなくなる(同時に 2 つ開かない)', () => {
    const state = { document: part, assembly, drawing: null };
    expect(activePartDocument(state)).toBeNull();
    expect(activeAssemblyDocument(state)).toBe(assembly);
  });

  it('部品を開いているあいだはアセンブリが読めない', () => {
    const state = { document: part, assembly: null, drawing: null };
    expect(activePartDocument(state)).toBe(part);
    expect(activeAssemblyDocument(state)).toBeNull();
  });

  it('部品を持っていなくても、アセンブリがあれば assembly として読める', () => {
    // 部品を閉じる操作(P8 以降)を足したときに、ここだけで済むことを確かめておく。
    const state = { document: null, assembly, drawing: null };
    expect(activeDocumentKind(state)).toBe('assembly');
    expect(activePartDocument(state)).toBeNull();
  });

  it('図面を持っていればdrawingが最優先になり他文書は読めない', () => {
    const state = { document: part, assembly, drawing };
    expect(activeDocumentKind(state)).toBe('drawing');
    expect(activeDrawingDocument(state)).toBe(drawing);
    expect(activePartDocument(state)).toBeNull();
    expect(activeAssemblyDocument(state)).toBeNull();
  });
});
