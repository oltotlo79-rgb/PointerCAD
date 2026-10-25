import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDrawingDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { DrawingNotePopover } from './DrawingNotePopover.js';
import { drawingFont } from './drawingFont.js';
import { saveDrawingNote } from './noteCommands.js';

interface KeyInput {
  readonly key: string;
  readonly nativeEvent: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}
interface PanelProps {
  readonly onKeyDown: (event: KeyInput) => void;
  readonly onSubmit: (event: { readonly preventDefault: () => void }) => void;
}
function panelHandlers(props: Parameters<typeof DrawingNotePopover>[0] = {}): PanelProps {
  let handlers: PanelProps | undefined;
  function Probe(): null {
    const tree = DrawingNotePopover(props);
    if (isValidElement<PanelProps>(tree)) handlers = tree.props;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (handlers === undefined) throw new Error('DrawingNotePopover handler missing');
  return handlers;
}
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  useAppStore.getState().openDrawing(createDrawingDocument('drawing', {
    sourceRef: 'part', sourceKind: 'part', fileName: 'box.pcad', path: '', contentHash: 'hash', importedAt: '',
  }));
  useAppStore.getState().setDrawingTool('note');
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('DrawingNotePopover real React handler and store (node, not DOM)', () => {
  it('form submit commits the multiline annotation once, with one Undo', () => {
    // 実際の日本語複数行入力を保ち、TSX の表示文言直書き検査には載せない。
    const japaneseNote = `${String.fromCharCode(0x89d2, 0x306f, 0x9762, 0x53d6, 0x308a)}\n${String.fromCharCode(0x5358, 0x4f4d)} mm`;
    vi.spyOn(drawingFont, 'outline').mockImplementation((text, sizeMm) => ({ status: 'ready', missingCharacters: [],
      subpaths: [], fillRule: 'nonzero', metrics: { fontId: 'fixture', sizeMm, advanceMm: text.length * sizeMm,
        inkBounds: { left: 0, right: text.length * sizeMm, bottom: 0, top: sizeMm } } }));
    expect(saveDrawingNote({ text: 'original', heightMm: 3.5, position: [30, 80] })).toBe(true);
    const before = useAppStore.getState(), annotation = before.drawing?.annotations[0];
    if (annotation === undefined) throw new Error('annotation missing');
    const preventDefault = vi.fn();
    panelHandlers({ annotation: { ...annotation, text: japaneseNote } }).onSubmit({ preventDefault });
    const after = useAppStore.getState();
    expect(after.drawing?.annotations).toHaveLength(1);
    expect(after.drawing?.annotations[0]).toMatchObject({ id: annotation.id, text: japaneseNote });
    expect(after.drawingUndoStack?.past).toHaveLength((before.drawingUndoStack?.past.length ?? 0) + 1);
    expect(preventDefault).toHaveBeenCalledOnce(); after.undo(); expect(useAppStore.getState().drawing).toBe(before.drawing);
  });
  it('normal Escape closes only the draft', () => {
    const before = useAppStore.getState(), preventDefault = vi.fn(), stopPropagation = vi.fn();
    panelHandlers().onKeyDown({ key: 'Escape', nativeEvent: { key: 'Escape', keyCode: 27, isComposing: false }, preventDefault, stopPropagation });
    expect(useAppStore.getState().drawingTool).toBe('select');
    expect(useAppStore.getState().drawing).toBe(before.drawing); expect(useAppStore.getState().drawingUndoStack).toBe(before.drawingUndoStack);
    expect(preventDefault).toHaveBeenCalledOnce(); expect(stopPropagation).toHaveBeenCalledOnce();
  });
  it.each(['Enter', 'Tab', 'Delete', 'Backspace', 'z'])('leaves native textarea %s unchanged', key => {
    const before = useAppStore.getState(), preventDefault = vi.fn(), stopPropagation = vi.fn();
    panelHandlers().onKeyDown({ key, nativeEvent: { key, keyCode: 0, isComposing: false }, preventDefault, stopPropagation });
    expect(useAppStore.getState().drawingTool).toBe(before.drawingTool);
    expect(useAppStore.getState().drawing).toBe(before.drawing); expect(useAppStore.getState().drawingUndoStack).toBe(before.drawingUndoStack);
    expect(preventDefault).not.toHaveBeenCalled(); expect(stopPropagation).not.toHaveBeenCalled();
  });
  it.each([
    ['Enter', 13, true], ['Escape', 27, true], ['Enter', 229, false], ['Escape', 229, false], ['Process', 0, false],
  ] as const)('preserves draft/document/Undo for %s code %i composing %s', (key, keyCode, isComposing) => {
    const before = useAppStore.getState();
    const preventDefault = vi.fn(); const stopPropagation = vi.fn();
    panelHandlers().onKeyDown({ key, nativeEvent: { key, keyCode, isComposing }, preventDefault, stopPropagation });
    const after = useAppStore.getState();
    expect(after.drawing).toBe(before.drawing);
    expect(after.drawingUndoStack).toBe(before.drawingUndoStack);
    expect(after.drawingTool).toBe(before.drawingTool);
    expect(after.drawingSelectedIds).toBe(before.drawingSelectedIds);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });
});
