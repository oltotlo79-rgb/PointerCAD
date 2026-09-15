import React, { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expressionValueFromNumber } from '@pointercad/expression';
import type { Annotation } from '@pointercad/drawing';
import { createDrawingDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { numericToolDefaultError, readNumericToolDefaults, toolDefaultEntries } from '../settings/numericToolDefaults.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { DrawingNotePopover } from './DrawingNotePopover.js';
import { DrawingGdtPanel } from './DrawingGdtPanel.js';
import { DrawingWeldPanel } from './DrawingWeldPanel.js';
import { DrawingTablePanel } from './DrawingTablePanel.js';
import { drawingDefaultId, drawingDefaultText } from './drawingToolDefaults.js';
import { snapshotDrawingToolDefaults } from './useDrawingToolDefaults.js';

beforeEach(() => {
  resetTestStore();
  useAppStore.getState().openDrawing(createDrawingDocument('初期値の図面', {
    sourceRef: 'part', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '',
  }));
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

function settings(values: Readonly<Record<string, string>>) {
  const state = useAppStore.getState(); state.setDisplaySettings({ ...state.displaySettings, numericToolDefaults: values });
}
function markup(element: ReactElement): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(element); } finally { snapshot.mockRestore(); }
}
function label(html: string, text: string): string {
  const result = (html.match(/<label\b[^>]*>[\s\S]*?<\/label>/gu) ?? []).find(item => item.includes(text) && /<input\b/u.test(item));
  if (result === undefined) throw new Error(`欄がありません: ${text}`);
  return result;
}

describe('図面の初期値は新規入力へだけ適用する', () => {
  it('注記・記号・表・線・寸法列を端末設定へ保存し、範囲外を拒否する', () => {
    const entries = toolDefaultEntries().filter(entry => entry.drawingKey !== undefined);
    expect(entries).toHaveLength(12); expect(new Set(entries.map(entry => entry.id)).size).toBe(12);
    for (const [key, value] of [['noteHeight', '101'], ['gdtHeight', '0.5'], ['weldSize', '0'], ['layerWidth', '-1'], ['roughness', '1mm']]) {
      const entry = entries.find(item => item.drawingKey === key);
      if (entry === undefined) throw new Error(`設定がありません: ${key}`);
      expect(numericToolDefaultError(entry, value)).not.toBeNull();
      expect(readNumericToolDefaults({ [entry.id]: value })).toEqual({});
    }
    const valid = { [drawingDefaultId('noteHeight')]: '2*3', [drawingDefaultId('roughness')]: '0' };
    expect(readNumericToolDefaults(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it('新規注記は6mm、保存済み注記は4mmを表示し、描画だけで文書を変更しない', () => {
    settings({ [drawingDefaultId('noteHeight')]: '2*3' });
    const before = useAppStore.getState();
    expect(label(markup(createElement(DrawingNotePopover)), t('drawing.note.height'))).toContain('value="6"');
    const annotation: Annotation = { id: 'note-1', kind: 'note', text: '既存の指示', height: 4, position: [80, 200], layerId: 'layer-5' };
    expect(label(markup(createElement(DrawingNotePopover, { annotation })), t('drawing.note.height'))).toContain('value="4"');
    expect(useAppStore.getState()).toBe(before);
  });

  it('公差・データム・溶接は別の文字高を使い、公差と溶接の原式も表示する', () => {
    settings({ [drawingDefaultId('gdtHeight')]: '6', [drawingDefaultId('datumHeight')]: '7',
      [drawingDefaultId('weldHeight')]: '8', [drawingDefaultId('gdtTolerance')]: '0.1/2', [drawingDefaultId('weldSize')]: '2*4' });
    const gdt = markup(createElement(DrawingGdtPanel, { kind: 'gdt' }));
    expect(label(gdt, t('drawing.note.height'))).toContain('value="6"');
    expect(label(gdt, t('drawing.gdt.value'))).toContain('value="0.1/2"');
    expect(label(markup(createElement(DrawingGdtPanel, { kind: 'datum' })), t('drawing.note.height'))).toContain('value="7"');
    const weld = markup(createElement(DrawingWeldPanel));
    expect(label(weld, t('drawing.note.height'))).toContain('value="8"');
    expect(label(weld, t('drawing.weld.size.leg'))).toContain('value="2*4"');
    expect(snapshotDrawingToolDefaults().expression('gdtTolerance')).toMatchObject({ source: '0.1/2', value: 0.05 });
  });

  it('既存表に省略された文字高は用紙から引き継ぎ、新しい設定で上書きしない', () => {
    const state = useAppStore.getState(), drawing = state.drawing;
    if (drawing === null) throw new Error('図面がありません');
    state.applyDrawing({ ...drawing, sheet: { ...drawing.sheet, textHeight: 5 }, tables: [{
      id: 'table-1', kind: 'revision', position: [20, 270], layerId: 'layer-1', columns: ['revision'], rows: [['A']], options: {},
    }] });
    settings({ [drawingDefaultId('tableRowHeight')]: '12', [drawingDefaultId('tableTextHeight')]: '8' });
    useAppStore.getState().selectDrawingIds(['table-1']);
    const before = useAppStore.getState();
    const existing = markup(createElement(DrawingTablePanel));
    expect(label(existing, t('drawing.table.rowHeight'))).toContain('value="7"');
    expect(label(existing, t('drawing.table.textHeight'))).toContain('value="5"');
    expect(useAppStore.getState()).toBe(before);
    useAppStore.getState().selectDrawingIds([]);
    const fresh = markup(createElement(DrawingTablePanel));
    expect(label(fresh, t('drawing.table.rowHeight'))).toContain('value="12"');
    expect(label(fresh, t('drawing.table.textHeight'))).toContain('value="8"');
  });

  it('図面のパラメータを使い、開始後の設定・係数変更を開いた入力へ持ち込まない', () => {
    const state = useAppStore.getState(), drawing = state.drawing;
    if (drawing === null) throw new Error('図面がありません');
    state.applyDrawing({ ...drawing, parameters: [{ name: '字高', unit: 'mm', description: '', value: expressionValueFromNumber(3) }] });
    settings({ [drawingDefaultId('noteHeight')]: '字高*2' });
    const original = snapshotDrawingToolDefaults(); expect(original.number('noteHeight')).toBe('6');
    settings({ [drawingDefaultId('noteHeight')]: '9' });
    expect(original.number('noteHeight')).toBe('6'); expect(snapshotDrawingToolDefaults().number('noteHeight')).toBe('9');
    expect(drawingDefaultText('noteHeight', { [drawingDefaultId('noteHeight')]: '未知' }, {}, 'number')).toBe('未知');
    expect(drawingDefaultText('tableTextHeight', {}, {}, 'number', 5)).toBe('5');
  });
});
