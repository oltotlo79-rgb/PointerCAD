/**
 * 非同期の文書操作の採用判定(`documentRequest.ts`)の検査と、
 * 同じ種類の誤り(待ちの後に古い文書へ結果を当てる)を機械で見張る検査
 * (docs/review-2026-09-28-codex.md R01・R02・§6.1 の1)。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEmptyPartDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { beginDocumentRequest } from './documentRequest.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

beforeEach(resetTestStore);

function renamePart(name: string): void {
  const state = useAppStore.getState();
  state.applyDocument({ ...state.document, name }, { coalesceKey: 'name' });
}

describe('採用判定の札', () => {
  it('何も変わらなければ current', () => {
    const request = beginDocumentRequest('test');
    expect(request.status()).toBe('current');
    expect(request.isCurrent()).toBe(true);
  });

  it('版の番号が増えない編集でも changed になる', () => {
    const request = beginDocumentRequest('test');
    const version = useAppStore.getState().documentVersion;
    renamePart('編集');
    expect(useAppStore.getState().documentVersion).toBe(version);
    expect(request.status()).toBe('changed');
  });

  it('取り消しとやり直しで同じ本文へ戻っても changed のまま(履歴が変わったため)', () => {
    renamePart('前の編集');
    const request = beginDocumentRequest('test');
    const document = useAppStore.getState().document;
    useAppStore.getState().undo();
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toBe(document);
    expect(request.status()).toBe('changed');
  });

  it('添付(読み込んだ形・下絵)だけが変わっても changed になる', () => {
    const request = beginDocumentRequest('test');
    useAppStore.getState().addImportedAttachments(new Map([['shape', Uint8Array.of(1)]]), new Map());
    expect(request.status()).toBe('changed');
  });

  it('新規・開くで別の文書になれば switched', () => {
    const request = beginDocumentRequest('test');
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    expect(request.status()).toBe('switched');
  });

  it('同じ種類の依頼を後から始めると先の札は superseded、別の種類は影響しない', () => {
    const first = beginDocumentRequest('import');
    const other = beginDocumentRequest('open');
    const second = beginDocumentRequest('import');
    expect(first.status()).toBe('superseded');
    expect(second.status()).toBe('current');
    expect(other.status()).toBe('current');
  });

  it('accept は今の状態を新しい基準にするが、順序の判定は引き継ぐ', () => {
    const request = beginDocumentRequest('test');
    renamePart('確認の前の編集');
    expect(request.status()).toBe('changed');
    request.accept();
    expect(request.status()).toBe('current');
    beginDocumentRequest('test');
    expect(request.status()).toBe('superseded');
  });
});

// ---------------------------------------------------------------------------
// 同じ種類の誤りを機械で見張る(rules/06 に記録する対策の本体)
// ---------------------------------------------------------------------------

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'testing') found.push(...listSources(fullPath));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      found.push(fullPath);
    }
  }
  return found;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 文書・履歴・添付を差し替える口。待ちの後に呼ぶなら、開始時の文書との照合が要る。 */
const DOCUMENT_MUTATION = /\b(?:applyDocument|applyAssembly|applyDrawing|openAssembly|openDrawing|resetDocument|setSketch|addImportedAttachments|setImportedAttachments|setCanvasImages|addCanvas)\(/;
const ASYNC_WAIT = /\bawait\b|\.then\(/;
/** 共通の判定とその薄い包み(開く操作の `file/documentOpenGuard.ts`)。 */
const SHARED_GUARD = /\b(?:beginDocumentRequest|compareDocumentIdentity|beginOpenRequest|mayOpenAfterRead)\(/;

/**
 * 共通の判定(`beginDocumentRequest`)を使わずに、待ちをはさんで文書を差し替える
 * ファイルの一覧。**1 件ずつ読んで、待ちの後に文書・組立・図面の参照で照合している
 * (または待ちの後に差し替えない)ことを確かめたもの**だけを理由とともに載せる
 * (2026-09-28 w83a の点検)。新しいファイルを足すときは共通の判定を使うこと。
 */
const REVIEWED_WITHOUT_SHARED_GUARD: Readonly<Record<string, string>> = {
  'assembly/placeComponentActions.ts': '要求ID・activeDocumentId・assembly の参照で照合',
  'assembly/replaceActions.ts': '要求ID・activeDocumentId・assembly と部品ライブラリの参照で照合',
  'drawing/arrangeDimensionCommands.ts': '字体の待ちの後に drawing・参照元・選択の参照で照合',
  'drawing/autoDimensionCommands.ts': '字体の待ちの後に drawing・参照元・解決結果の参照で照合',
  'drawing/createDrawingCommands.ts': 'document・assembly・部品ライブラリ・activeDocumentId の参照で照合',
  'drawing/dimensionSeriesCommands.ts': '字体の待ちの後に drawing・編集中の欄・対象の参照で照合',
  'drawing/DrawingCanvas.tsx': '待ち(字体)は表示だけ。applyDrawing は同期の操作の中',
  'drawing/drawingTemplateActions.ts': 'document・assembly・drawing・部品ライブラリ・activeDocumentId の参照で照合',
  'drawing/refreshDrawingSource.ts': 'activeDocumentId・版・drawing・参照元の参照で照合',
  'functionPlot/FunctionDirectionDialog.tsx': 'document の参照と版で照合し、変われば窓を閉じる',
  'functionPlot/FunctionPlotDialog.tsx': 'document の参照と版で照合し、変われば窓を閉じる',
  'functionPlot/FunctionPointDialog.tsx': 'document の参照と版で照合し、変われば窓を閉じる',
  'functionPlot/FunctionSectionDialog.tsx': 'document の参照と版で照合し、変われば窓を閉じる',
  'math/mathGeometryCommands.ts': '版・部品文書の参照・計算の世代で照合',
  'math/PropertyMathField.tsx': 'document の参照と版で照合',
  'parameters/mathConfigurationActions.ts': '版と部品文書の参照で照合',
  'parameters/mathParameterActions.ts': '版と部品文書の参照で照合',
  'parameters/ParameterMathDialog.tsx': 'document の参照と版で照合',
  'parameters/ParameterPanel.tsx': '待ちの後の差し替えは mathParameterActions 側で照合済み',
  'scripting/scriptActions.ts': 'document・activeDocumentId・版・添付などの参照で照合',
  'sheetMetal/sheetCreationActions.ts': '道具の状態・activeDocumentId・document の参照で照合',
  'sheetMetal/sheetUnfoldActions.ts': '道具の状態・activeDocumentId・document の参照で照合',
  'shell/menus/fileToolbarActions.tsx': 'ひな形の新規: activeDocumentId・版・document・assembly・drawing の参照で照合',
  'sketch/textCommands.ts': '字体の待ちの後に document・sketch の参照で照合',
  'store/assemblySlice.ts': '待ち(干渉の解析)の後は結果の表示だけを更新し、文書は差し替えない',
  'viewport/ViewportCanvas.tsx': '待ち(画像の復号)の後は表示だけ。setSketch は描画の口',
};

/** 版の番号だけの照合(documentVersion は通常の編集で増えない)を見つける。 */
const VERSION_COMPARISON = /\bdocumentVersion\s*[!=]==|[!=]==\s*[\w.]*documentVersion\b/;
const REFERENCE_COMPARISON = /\b(?:document|assembly|drawing|assemblyLibrary|drawingSources)\s*[!=]==|[!=]==\s*(?:[\w.]+\.)?(?:document|assembly|drawing)\b|activePartDocument\([^)]*\)\s*[!=]==|\b(?:beginDocumentRequest|compareDocumentIdentity|beginOpenRequest|mayOpenAfterRead)\(/;

describe('待ちをはさむ文書操作の見張り', () => {
  const files = listSources(sourceRoot).map((file) => ({
    file,
    name: relative(sourceRoot, file).split('\\').join('/'),
    source: stripComments(readFileSync(file, 'utf8')),
  }));
  const asyncMutators = files.filter(({ source }) => ASYNC_WAIT.test(source) && DOCUMENT_MUTATION.test(source));

  it('待ちの後に文書を差し替えるファイルは、共通の判定を使うか、点検済みの一覧に理由がある', () => {
    const unreviewed = asyncMutators
      .filter(({ source, name }) => !SHARED_GUARD.test(source) && REVIEWED_WITHOUT_SHARED_GUARD[name] === undefined)
      .map(({ name }) => name);
    expect(unreviewed, 'store/documentRequest.ts の beginDocumentRequest で照合してください').toEqual([]);
  });

  it('点検済みの一覧に、もう当てはまらないファイルを残さない', () => {
    const matching = new Set(asyncMutators.filter(({ source }) => !SHARED_GUARD.test(source)).map(({ name }) => name));
    const stale = Object.keys(REVIEWED_WITHOUT_SHARED_GUARD).filter((name) => !matching.has(name));
    expect(stale, '一覧から外してください').toEqual([]);
  });

  it('待ちの後に文書を差し替えるファイルは、版の番号だけで照合しない', () => {
    const offenders: string[] = [];
    for (const { name, source } of asyncMutators) {
      const lines = source.split('\n');
      lines.forEach((line, index) => {
        if (!VERSION_COMPARISON.test(line)) return;
        const around = lines.slice(Math.max(0, index - 2), index + 3).join('\n');
        if (!REFERENCE_COMPARISON.test(around)) offenders.push(`${name}:${String(index + 1)}`);
      });
    }
    expect(offenders, '文書・組立・図面の参照か beginDocumentRequest で照合してください').toEqual([]);
  });

  it('見張りの正規表現が、実際の誤りの形(版と ID だけ)を見つける', () => {
    const versionOnly = 'if (current.activeDocumentId !== before.activeDocumentId || current.documentVersion !== before.documentVersion) return;';
    expect(VERSION_COMPARISON.test(versionOnly)).toBe(true);
    expect(REFERENCE_COMPARISON.test(versionOnly)).toBe(false);
    expect(REFERENCE_COMPARISON.test('current.document !== before.document')).toBe(true);
    expect(DOCUMENT_MUTATION.test('before.openAssembly(result.bundle.document, library)')).toBe(true);
  });
});
