import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssemblyDocument, createDrawingDocument } from '@pointercad/model';
import { attachDrawing } from '../drawing/attachDrawing.js';
import { executeCommand } from '../commands/commandRegistry.js';
import { toolbarCommandId } from '../commands/toolbarCommandCatalog.js';
import { DrawingToolbar } from '../drawing/DrawingToolbar.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toolbar } from './Toolbar.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('document mode indicator', () => {
  it.each(['part', 'assembly'] as const)('names %s accessibly without adding an action or a tab stop', kind => {
    if (kind === 'assembly') useAppStore.getState().openAssembly(createAssemblyDocument('Assembly'));
    const before = useAppStore.getState();
    vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    const html = renderToStaticMarkup(createElement(Toolbar));
    const mode = html.match(/<div class="pcad-toolbar__modes"[^>]*>(.*?)<\/div>/u)?.[0];
    expect(mode).toBeDefined();
    expect(mode).toContain(`aria-label="${t('toolbar.mode.groupLabel')}"`);
    expect(mode).toContain(`aria-label="${t(kind === 'assembly' ? 'assembly.mode' : 'toolbar.mode.modeling')}"`);
    expect(mode).toContain('role="img"');
    expect(mode).toContain('pcad-toolbar__mode-label');
    expect(mode).not.toMatch(/<button|<a |tabindex|aria-pressed|pcad-tab/u);
    expect(useAppStore.getState()).toBe(before);
  });
});

describe('名前付き保存点の到達口', () => {
  it('部品と組立の基本ボタンを増やさずファイル一覧へ移す', () => {
    vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    const part = renderToStaticMarkup(createElement(Toolbar));
    expect(part).not.toContain(`aria-label="${t('toolbar.history.savePoints')}"`);
    expect(part).toContain(`aria-label="${t('toolbar.fileMenu.groupLabel')}"`);
    expect(part).toContain('aria-haspopup="true"');
    expect(useAppStore.getState().utilityPanel).toBeNull();
    expect(part.split(`aria-label="${t('toolbar.history.groupLabel')}"`)).toHaveLength(2);
    useAppStore.getState().openAssembly(createAssemblyDocument('Assembly'));
    const assembly = renderToStaticMarkup(createElement(Toolbar));
    expect(assembly).not.toContain(`aria-label="${t('toolbar.history.savePoints')}"`);
    expect(assembly).toContain(`aria-label="${t('toolbar.fileMenu.groupLabel')}"`);
  });
});

describe('図面の道具列の名前付き保存点', () => {
  it('図面も基本ボタンを増やさずファイル一覧へ移す', () => {
    vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    useAppStore.getState().openDrawing(createDrawingDocument('図面', { sourceRef: 'src-1', sourceKind: 'part', fileName: 'a.pcad',
      path: 'a.pcad', contentHash: 'x', importedAt: '2026-01-01T00:00:00.000Z' }));
    const html = renderToStaticMarkup(createElement(DrawingToolbar));
    expect(html).not.toContain(`aria-label="${t('toolbar.history.savePoints')}"`);
    expect(html).toContain(`aria-label="${t('toolbar.fileMenu.groupLabel')}"`);
    expect(useAppStore.getState().utilityPanel).toBeNull();
  });
});

describe('図面のnative拒否とキーボード用可視理由', () => {
  const open = (sourceKind: 'part' | 'assembly' = 'part') => {
    useAppStore.getState().openDrawing(createDrawingDocument('図面', { sourceRef: 'src-1', sourceKind,
      fileName: 'source.pcad', path: 'source.pcad', contentHash: 'x', importedAt: '2026-01-01T00:00:00.000Z' }));
    vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  };
  const render = () => renderToStaticMarkup(createElement(DrawingToolbar));
  const command = (html: string, id: string) => html.match(/<button[^>]*>/gu)?.find(button => button.includes(`data-command-id="${id}"`));
  const note = (html: string, id: string) => html.match(/<span[^>]*>[^<]*<\/span>/gu)?.find(span => span.includes(`id="${id}"`));
  const explains = (html: string, id: string, text: string) => {
    const element = note(html, id); expect(element).toContain('role="note"'); expect(element).toContain('tabindex="0"');
    expect(element).toContain(text); expect(element).not.toMatch(/hidden|aria-hidden|display:none/u);
  };
  it('履歴なしを可視説明に結び、実undo/redo拒否で文書を変えない', () => {
    open(); const before = useAppStore.getState().drawing; const html = render();
    for (const [id, reason, key] of [['history.undo', 'drawing-undo-unavailable', 'toolbar.history.undoUnavailable'],
      ['history.redo', 'drawing-redo-unavailable', 'toolbar.history.redoUnavailable']] as const) {
      expect(command(html, id)).toContain('disabled=""'); expect(command(html, id)).toContain(`aria-describedby="${reason}"`);
      explains(html, reason, t(key)); expect(executeCommand(id)).toMatchObject({ status: 'disabled' });
      expect(useAppStore.getState().drawing).toBe(before);
    }
  });
  it('公開apply/undoに応じて履歴説明だけが切り替わる', () => {
    open(); const drawing = useAppStore.getState().drawing; if (drawing === null) throw new Error('No drawing');
    useAppStore.getState().applyDrawing({ ...drawing, name: '変更' });
    expect(note(render(), 'drawing-undo-unavailable')).toBeUndefined();
    explains(render(), 'drawing-redo-unavailable', t('toolbar.history.redoUnavailable'));
    useAppStore.getState().undoDrawing();
    explains(render(), 'drawing-undo-unavailable', t('toolbar.history.undoUnavailable'));
    expect(note(render(), 'drawing-redo-unavailable')).toBeUndefined();
  });
  it.each(['part', 'assembly'] as const)('BOMは%s sourceの実ready/refusalに対応する', sourceKind => {
    open(sourceKind); const before = useAppStore.getState().drawing; const html = render();
    const button = command(html, toolbarCommandId('drawing', 'bom'));
    if (sourceKind === 'part') {
      expect(button).toContain('disabled=""'); expect(button).toContain('aria-describedby="drawing-bom-unavailable"');
      explains(html, 'drawing-bom-unavailable', t('drawing.toolbar.assemblyOnly'));
      expect(executeCommand(toolbarCommandId('drawing', 'bom'))).toMatchObject({ status: 'executed' });
      expect(useAppStore.getState().drawingEditor).toBeNull();
      expect(useAppStore.getState().drawingMessage).toBe(t('drawing.toolbar.assemblyOnly'));
    } else { expect(button).not.toContain('disabled=""'); expect(note(html, 'drawing-bom-unavailable')).toBeUndefined(); }
    expect(useAppStore.getState().drawing).toBe(before);
  });
  it('実attachDrawingの計算中はtablesとprintを拒否し、同じ可視理由へ結ぶ', () => {
    open(); useAppStore.getState().setUtilityPanelOpen('drawingPrint', true);
    // Existing public observer makes drawingBusy synchronously; no store/history injection.
    const bridge: Parameters<typeof attachDrawing>[0] = {
      releasePart: () => Promise.resolve(), recomputeSolids: () => Promise.resolve({ bodies: [], failures: [], cacheHits: 0, cancelled: false }),
      checkShapeAvailability: (partId, keys) => Promise.resolve({ partId, missingKeys: [...keys] }),
      hiddenLineViews: () => Promise.resolve({ views: [], failures: [], cancelled: false }),
      sectionViews: request => Promise.resolve({ viewId: request.view.id, visible: [], hidden: [], cuttingCurves: [], failures: [], cancelled: false }),
      tessellateSketchFaces: () => Promise.resolve({ mesh: { faces: [] }, failures: [] }),
      offsetSketchCurves: () => Promise.resolve({ results: [], failures: [] }), projectSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
      sectionSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
      measure: () => Promise.resolve({ kind: 'failed', message: 'unused' }), exportShapes: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
      importShape: () => Promise.resolve({ kind: 'failed', message: 'unused' }), inspectPrintability: () => Promise.resolve({ kind: 'failed', message: 'unused' }), dispose: () => undefined,
    };
    const detach = attachDrawing(bridge);
    try {
      expect(useAppStore.getState().drawingBusy).toBe(true); const before = useAppStore.getState().drawing; const html = render();
      explains(html, 'drawing-busy-unavailable', t('drawing.status.computing'));
      for (const id of ['table', 'bom', 'print'] as const) {
        expect(executeCommand(toolbarCommandId('drawing', id))).toMatchObject({ status: 'disabled' });
        expect(useAppStore.getState().drawing).toBe(before);
      }
      expect(command(html, toolbarCommandId('drawing', 'table'))).toContain('disabled=""');
      expect(command(html, toolbarCommandId('drawing', 'table'))).toContain('aria-describedby="drawing-busy-unavailable"');
      const print = html.match(/<button[^>]*>[^<]*<\/button>/gu)?.find(button => button.includes('>' + t('drawing.print.title') + '</button>'));
      expect(print).toContain('disabled=""'); expect(print).toContain('aria-describedby="drawing-busy-unavailable"');
    } finally { detach(); }
  });
});
