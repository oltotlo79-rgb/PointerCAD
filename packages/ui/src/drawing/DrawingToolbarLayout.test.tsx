import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDrawingDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type MessageKey } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { DrawingToolbar } from './DrawingToolbar.js';

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

function render(sourceKind: 'part' | 'assembly', canUndo: boolean, canRedo: boolean, busy: boolean): string {
  useAppStore.getState().openDrawing(createDrawingDocument('toolbar', {
    sourceRef: 'source', sourceKind, fileName: 'source.pcad', path: '', contentHash: 'hash', importedAt: '',
  }));
  useAppStore.setState({ canUndo, canRedo, drawingBusy: busy });
  return renderToStaticMarkup(<DrawingToolbar />);
}

function button(markup: string, command: string): string {
  const tag = Array.from(markup.matchAll(/<button\b[^>]*>/gu), match => match[0])
    .find(tag => tag.includes(`data-command-id="${command}"`));
  if (tag === undefined) throw new Error(`Missing button: ${command}`);
  return tag;
}

function expectReason(markup: string, id: string, key: MessageKey): void {
  const text = renderToStaticMarkup(<>{t(key)}</>);
  expect(markup).toContain(`<span id="${id}" role="note" tabindex="0">${text}</span>`);
  const aside = markup.match(/<aside\b[^>]*>([\s\S]*?)<\/aside>/u);
  expect(aside?.[0]).toContain(`id="${id}"`);
  expect(aside?.[0]).not.toMatch(/hidden|aria-hidden|display:\s*none|visibility:\s*hidden/u);
}

describe('DrawingToolbar readable explanations and command associations', () => {
  it.each(['part', 'assembly'] as const)('retains five menus and titles in normal %s drawings', source => {
    const markup = render(source, true, true, false);
    expect(markup.match(/class="pcad-button pcad-menu__trigger /gu)).toHaveLength(5);
    for (const match of markup.matchAll(/<button\b[^>]*>/gu)) expect(match[0]).toMatch(/title="[^"]+"/u);
    expect(button(markup, 'history.undo')).not.toContain('aria-describedby');
    expect(button(markup, 'history.redo')).not.toContain('aria-describedby');
    expect(markup).not.toContain('id="drawing-busy-unavailable"');
    if (source === 'assembly') {
      expect(button(markup, 'toolbar.drawing.bom')).not.toContain('disabled');
      expect(markup).not.toContain('id="drawing-bom-unavailable"');
    } else {
      expect(button(markup, 'toolbar.drawing.bom')).toContain('aria-describedby="drawing-bom-unavailable"');
      expectReason(markup, 'drawing-bom-unavailable', 'drawing.toolbar.assemblyOnly');
    }
  });

  it.each(['part', 'assembly'] as const)('keeps unavailable history reasons focusable in %s drawings', source => {
    const markup = render(source, false, false, false);
    expect(button(markup, 'history.undo')).toContain('disabled=""');
    expect(button(markup, 'history.undo')).toContain('aria-describedby="drawing-undo-unavailable"');
    expect(button(markup, 'history.redo')).toContain('disabled=""');
    expect(button(markup, 'history.redo')).toContain('aria-describedby="drawing-redo-unavailable"');
    expectReason(markup, 'drawing-undo-unavailable', 'toolbar.history.undoUnavailable');
    expectReason(markup, 'drawing-redo-unavailable', 'toolbar.history.redoUnavailable');
  });

  it.each(['part', 'assembly'] as const)('retains computing and source explanations together in %s drawings', source => {
    const markup = render(source, false, false, true);
    expectReason(markup, 'drawing-busy-unavailable', 'drawing.status.computing');
    expectReason(markup, 'drawing-undo-unavailable', 'toolbar.history.undoUnavailable');
    expectReason(markup, 'drawing-redo-unavailable', 'toolbar.history.redoUnavailable');
    for (const command of ['toolbar.drawing.bom', 'toolbar.drawing.table']) {
      expect(button(markup, command)).toContain('disabled=""');
      expect(button(markup, command)).toContain('aria-describedby="drawing-busy-unavailable"');
      expect(button(markup, command)).toContain(t('drawing.status.computing'));
    }
    if (source === 'part') expectReason(markup, 'drawing-bom-unavailable', 'drawing.toolbar.assemblyOnly');
    // Every disabled control still points to an existing explanation, including print.
    useAppStore.getState().setUtilityPanelOpen('drawingPrint', true);
    const withPrint = renderToStaticMarkup(<DrawingToolbar />);
    for (const match of withPrint.matchAll(/aria-describedby="([^"]+)"/gu)) {
      for (const id of (match[1] ?? '').split(' ')) expect(withPrint).toContain(`id="${id}"`);
    }
  });

  it('places visible reasons beside controls with drawing-only CSS, leaving pixel validation to P8-66', () => {
    const markup = render('part', false, false, true);
    expect(markup).toContain('class="pcad-toolbar pcad-toolbar--drawing"');
    expect(markup).toContain('class="pcad-toolbar__group-label pcad-drawing-toolbar__reasons"');
    expect(markup.match(/<aside\b[^>]*>/u)?.[0]).not.toContain('style=');
    const css = readFileSync(new URL('../shell/appShell.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.pcad-toolbar--drawing\s*\{[^}]*padding-block:\s*var\(--pcad-space-1\)/u);
    const reasons = css.match(/\.pcad-drawing-toolbar__reasons\s*\{([^}]*)\}/u)?.[1];
    expect(reasons).toContain('display: flex;');
    expect(reasons).toContain('flex-direction: column;');
    expect(reasons).not.toMatch(/100%|hidden|clip|ellipsis|height:|position:/u);
  });
});
