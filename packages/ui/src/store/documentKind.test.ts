/**
 * 文書の種類の判定(P7 §0.a-0.10、計画書タスク5)の検査。
 *
 * ここで固定するのは 3 つ。
 * ①種類の判定が 3 つの状態を正しく返す(`part` / `assembly` / `empty`)。
 * ②**アセンブリを開くと部品は読めなくなる**(1 つの窓で 2 つの文書を開かない)。
 * ③種類ごとの `key` は**種類が違えば必ず食い違う**(`rules/06` 10.9 の兄弟の鍵の重なり)。
 *
 * ストアそのものを動かす検査(新規で閉じる・開くと切り替わる)は
 * `useAppStore.test.ts` の側にある。
 */
import { createAssemblyDocument, createEmptyPartDocument } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { useAppStore } from './useAppStore.js';

import {
  activeDocument,
  activeFileName,
  activeAssemblyDocument,
  activeDocumentKind,
  activePartDocument,
  type DocumentKind,
  documentSectionKey,
} from './documentKind.js';

const part = createEmptyPartDocument();
const assembly = createAssemblyDocument('組み立て1');

describe('いま開いている文書の種類(P7 タスク5)', () => {
  it('共通入口の part は従来の文書・保存済み文書・名前を返す', () => {
    const state = { ...useAppStore.getState(), document: part, assembly: null,
      savedDocument: part, fileName: 'part.pcad' };
    expect(activeDocument(state)).toEqual({ kind: 'part', document: part, saved: part,
      fileName: 'part.pcad', documentId: state.activeDocumentId });
    expect(activeFileName(state)).toBe('part.pcad');
  });

  it('共通入口の assembly は裏の part の名前・保存状態を採らない', () => {
    const state = { ...useAppStore.getState(), document: part, assembly,
      fileName: 'hidden.pcad', assemblyFileName: 'assembly.pcada' };
    const active = activeDocument(state);
    expect(active.kind).toBe('assembly');
    expect(active.document).toBe(assembly);
    expect(activeFileName(state)).toBe('assembly.pcada');
  });
  it('部品だけを持っていれば part', () => {
    expect(activeDocumentKind({ document: part, assembly: null })).toBe('part');
  });

  it('アセンブリを持っていれば assembly', () => {
    expect(activeDocumentKind({ document: part, assembly })).toBe('assembly');
  });

  it('どちらも無ければ empty', () => {
    expect(activeDocumentKind({ document: null, assembly: null })).toBe('empty');
  });

  it('アセンブリを開くと部品は読めなくなる(同時に 2 つ開かない)', () => {
    const state = { document: part, assembly };
    expect(activePartDocument(state)).toBeNull();
    expect(activeAssemblyDocument(state)).toBe(assembly);
  });

  it('部品を開いているあいだはアセンブリが読めない', () => {
    const state = { document: part, assembly: null };
    expect(activePartDocument(state)).toBe(part);
    expect(activeAssemblyDocument(state)).toBeNull();
  });

  it('部品を持っていなくても、アセンブリがあれば assembly として読める', () => {
    // 部品を閉じる操作(P8 以降)を足したときに、ここだけで済むことを確かめておく。
    const state = { document: null, assembly };
    expect(activeDocumentKind(state)).toBe('assembly');
    expect(activePartDocument(state)).toBeNull();
  });
});

describe('文書の種類つきの key(rules/06 10.9)', () => {
  const KINDS: readonly DocumentKind[] = ['part', 'assembly', 'empty'];

  it('同じ id でも種類が違えば必ず食い違う', () => {
    const keys = KINDS.map((kind) => documentSectionKey(kind, 'component-1'));
    expect(new Set(keys).size).toBe(KINDS.length);
  });

  it('id をそのまま key にしたものとは重ならない', () => {
    // 木とプロパティでは、文書の id・フィーチャーの id がそのまま key に使われている。
    for (const kind of KINDS) {
      expect(documentSectionKey(kind, 'component-1')).not.toBe('component-1');
      expect(documentSectionKey(kind, 'extrude-1')).not.toBe('extrude-1');
    }
  });

  it('PropertyPanel の既にある接頭辞とも重ならない', () => {
    // 外観・基本形状・つなぎ方・切断・案内線・測定・質量の 7 つ(P5 まで)。
    const existing = ['appearance:', 'primitive:', 'ruled:', 'cut:', 'sphereGrid:', 'measure:', 'mass:'];
    for (const kind of KINDS) {
      const key = documentSectionKey(kind, 'x');
      expect(existing.some((prefix) => key.startsWith(prefix))).toBe(false);
    }
  });
});
