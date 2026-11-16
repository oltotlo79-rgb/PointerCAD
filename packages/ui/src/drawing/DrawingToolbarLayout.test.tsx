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

/** 効かないボタンは、焦点の入る aria-disabled で、理由をボタンの title に持つ(UI の点検の指摘 10。R20 の理由はキーボードでも読める)。 */
function expectFocusableReason(markup: string, command: string, key: MessageKey): void {
  const tag = button(markup, command);
  const text = renderToStaticMarkup(<>{t(key)}</>);
  expect(tag).toContain('aria-disabled="true"');
  expect(tag).not.toContain('disabled=""');
  expect(tag).not.toMatch(/tabindex="-1"|aria-hidden/u);
  expect(tag.match(/title="([^"]*)"/u)?.[1]).toContain(text);
}

function expectNoStandingNotes(markup: string): void {
  expect(markup).not.toContain('role="note"');
  expect(markup).not.toMatch(/<aside\b/u);
  expect(markup).not.toMatch(/aria-describedby="drawing-[a-z]+-unavailable"/u);
}

describe('DrawingToolbar readable explanations and command associations', () => {
  it.each(['part', 'assembly'] as const)('retains five menus and titles in normal %s drawings', source => {
    const markup = render(source, true, true, false);
    expect(markup.match(/class="pcad-button pcad-menu__trigger /gu)).toHaveLength(5);
    for (const match of markup.matchAll(/<button\b[^>]*>/gu)) expect(match[0]).toMatch(/title="[^"]+"/u);
    expect(button(markup, 'history.undo')).not.toContain('aria-disabled');
    expect(button(markup, 'history.redo')).not.toContain('aria-disabled');
    expectNoStandingNotes(markup);
    if (source === 'assembly') {
      expect(button(markup, 'toolbar.drawing.bom')).not.toContain('disabled');
    } else {
      expectFocusableReason(markup, 'toolbar.drawing.bom', 'drawing.toolbar.assemblyOnly');
    }
  });

  it.each(['part', 'assembly'] as const)('keeps unavailable history reasons readable from the focusable buttons in %s drawings', source => {
    const markup = render(source, false, false, false);
    expectFocusableReason(markup, 'history.undo', 'toolbar.history.undoUnavailable');
    expectFocusableReason(markup, 'history.redo', 'toolbar.history.redoUnavailable');
    expectNoStandingNotes(markup);
  });

  it.each(['part', 'assembly'] as const)('retains computing and source explanations together in %s drawings', source => {
    const markup = render(source, false, false, true);
    expectFocusableReason(markup, 'history.undo', 'toolbar.history.undoUnavailable');
    expectFocusableReason(markup, 'history.redo', 'toolbar.history.redoUnavailable');
    for (const command of ['toolbar.drawing.bom', 'toolbar.drawing.table']) expectFocusableReason(markup, command, 'drawing.status.computing');
    expectNoStandingNotes(markup);
    // The print window explains the refusal inside the window and its print button keeps the reason, without a standing note.
    useAppStore.getState().setUtilityPanelOpen('drawingPrint', true);
    const withPrint = renderToStaticMarkup(<DrawingToolbar />);
    const computing = renderToStaticMarkup(<>{t('drawing.status.computing')}</>);
    expect(withPrint).toContain(`<p role="status">${computing}</p>`);
    const print = withPrint.match(/<button[^>]*>[^<]*<\/button>/gu)?.find(tag => tag.includes('>' + t('drawing.print.title') + '</button>'));
    expect(print).toContain('aria-disabled="true"');
    expect(print).not.toContain('disabled=""');
    expect(print?.match(/title="([^"]*)"/u)?.[1]).toBe(computing);
    expectNoStandingNotes(withPrint);
  });

  it('keeps the drawing toolbar on one row without a reasons column (UI の点検の指摘 10)', () => {
    const markup = render('part', false, false, true);
    expect(markup).toContain('class="pcad-toolbar pcad-toolbar--drawing"');
    expect(markup).not.toContain('pcad-drawing-toolbar__reasons');
    const css = readFileSync(new URL('../shell/appShell.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.pcad-toolbar--drawing\s*\{[^}]*padding-block:\s*var\(--pcad-space-1\)/u);
    expect(css).not.toContain('.pcad-drawing-toolbar__reasons');
  });

  it('図面のツリーの選んだ行は、部品のツリーと同じ行の淡い面だけで示す(枠を付けない。UI の点検の指摘 13)', () => {
    const css = readFileSync(new URL('../shell/appShell.css', import.meta.url), 'utf8');
    const pressed = css.match(/\.pcad-drawing-tree-group \.pcad-tree__row > button\[aria-pressed='true'\]\s*\{([^}]*)\}/u)?.[1];
    expect(pressed).toBeDefined();
    expect(pressed).not.toMatch(/outline:\s*1px/u);
    expect(pressed).toMatch(/background:\s*transparent;/u);
    expect(pressed).toMatch(/box-shadow:\s*none;/u);
    expect(css).toMatch(/\.pcad-tree__row--selected\s*\{\s*background:\s*var\(--pcad-accent-soft\);/u);
  });
});
