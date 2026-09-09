import { createDrawingDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { drawingFont } from './drawingFont.js';
import { beginDrawingAnnotationDrag, finishDrawingAnnotationDrag, previewDrawingAnnotationDrag, saveDrawingNote } from './noteCommands.js';

const source = { sourceRef: 'part', sourceKind: 'part' as const, fileName: 'box.pcad', path: '', contentHash: 'hash', importedAt: '' };
const input = { text: '角は面取り\n寸法単位 mm', position: [30, 80] as const, heightMm: 3.5 };
const state = () => useAppStore.getState();
function first() { const annotation = state().drawing?.annotations[0]; if (annotation === undefined) throw new Error('注記なし'); return annotation; }
function drag() { const result = beginDrawingAnnotationDrag(first().id, input.position); if (result === null) throw new Error('移動なし'); return result; }

describe('紙面の複数行注記・引出線・編集・移動(P8-52)', () => {
  beforeEach(() => {
    vi.restoreAllMocks(); useAppStore.setState(createInitialDocumentState());
    state().openDrawing(createDrawingDocument('図面', source));
    vi.spyOn(drawingFont, 'outline').mockImplementation((text, sizeMm) => ({ status: 'ready', missingCharacters: [],
      subpaths: [], fillRule: 'nonzero', metrics: { fontId: 'fixture', sizeMm, advanceMm: text.length * sizeMm,
        inkBounds: { left: 0, right: text.length * sizeMm, bottom: 0, top: sizeMm } } }));
  });
  it('複数行・高さ・紙面位置を保存し作った注記を選ぶ', () => {
    expect(saveDrawingNote(input)).toBe(true); expect(first()).toMatchObject({ kind: 'note', text: input.text, position: [30, 80], height: 3.5 });
    expect(state().drawingSelectedIds).toEqual([first().id]);
  });
  it('CRLFを1行の送りへ正規化する', () => { saveDrawingNote({ ...input, text: 'a\r\nb\rc' }); expect(first().text).toBe('a\nb\nc'); });
  it('矢印の先端と方式を保持する', () => {
    saveDrawingNote({ ...input, leader: { target: [0, 20], end: 'arrow' } });
    expect(first()).toMatchObject({ kind: 'leaderNote', leader: [[0, 20]], leaderEnd: 'arrow' });
  });
  it('黒丸を選んでも同じ先端を保持する', () => {
    saveDrawingNote({ ...input, leader: { target: [10, 20], end: 'dot' } }); expect(first().leaderEnd).toBe('dot');
  });
  it('文字変更は同じIDに適用しUndo1回で元の複数行へ戻る', () => {
    saveDrawingNote(input); const id = first().id; saveDrawingNote({ ...input, id, text: '改訂' });
    expect(state().drawing?.annotations).toHaveLength(1); expect(first().id).toBe(id); expect(first().text).toBe('改訂');
    state().undo(); expect(first().text).toBe(input.text); state().redo(); expect(first().text).toBe('改訂');
  });
  it('引出線なしへ変更すると不要な先端を保存しない', () => {
    saveDrawingNote({ ...input, leader: { target: [0, 20], end: 'dot' } }); saveDrawingNote({ ...input, id: first().id });
    expect(first().leader).toBeUndefined(); expect(first().leaderEnd).toBeUndefined(); expect(first().kind).toBe('note');
  });
  it('空白のみの文字で履歴を増やさない', () => {
    expect(saveDrawingNote({ ...input, text: '\n  ' })).toBe(false); expect(state().canUndo).toBe(false);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 101])('不正な高さ%sを拒否する', (heightMm) => {
    expect(saveDrawingNote({ ...input, heightMm })).toBe(false); expect(state().drawing?.annotations).toHaveLength(0);
  });
  it('無効な座標を保存しない', () => { expect(saveDrawingNote({ ...input, position: [Number.NaN, 1] })).toBe(false); });
  it('文書が無い時は作成しない', () => { state().closeDrawing(); expect(saveDrawingNote(input)).toBe(false); });
  it('無いIDを編集指定しても追加しない', () => { expect(saveDrawingNote({ ...input, id: 'missing' })).toBe(false); });
  it('移動中は文書とUndo履歴に書き込まない', () => {
    saveDrawingNote(input); const document = state().drawing, start = drag();
    expect(previewDrawingAnnotationDrag(start, [40, 85])?.position).toEqual([40, 85]); expect(state().drawing).toBe(document);
  });
  it('引出線の先端は動かさず文字だけ移しUndo1回で戻る', () => {
    saveDrawingNote({ ...input, leader: { target: [0, 20], end: 'arrow' } });
    expect(finishDrawingAnnotationDrag(drag(), [40, 85])).toBe(true); expect(first().position).toEqual([40, 85]); expect(first().leader).toEqual([[0, 20]]);
    state().undo(); expect(first().position).toEqual([30, 80]); state().redo(); expect(first().position).toEqual([40, 85]);
  });
  it('移動量0では履歴を増やさない', () => {
    saveDrawingNote(input); const document = state().drawing; expect(finishDrawingAnnotationDrag(drag(), input.position)).toBe(false); expect(state().drawing).toBe(document);
  });
  it('移動中に文書が替わったら古い操作を適用しない', () => {
    saveDrawingNote(input); const start = drag(); state().openDrawing(createDrawingDocument('別図', source));
    expect(finishDrawingAnnotationDrag(start, [40, 85])).toBe(false); expect(state().drawing?.annotations).toHaveLength(0);
  });
});
