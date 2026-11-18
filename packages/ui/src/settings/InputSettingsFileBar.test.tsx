import ReactHooks, * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { decodeInputSettingsFile, encodeInputSettingsFile, inputSettingsValuesOf, type InputSettingsReading } from './inputSettingsFile.js';
import { InputSettingsFileBar } from './InputSettingsFileBar.js';
import { DEFAULT_VIEW_CONTROLS, type ViewTrigger } from './viewControlSettings.js';

vi.mock('react', { spy: true });

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/* 設計 B-09 3-1: 操作の割り当ての窓の「書き出す」「読み込む」の帯。読んだ内容は確かめてから置き換え、直後なら元に戻せる。 */

/** The bar's own state (its only useState) is forced when given; the store is read at its current snapshot. */
function renderBar(state?: object): string {
  if (state !== undefined) vi.spyOn(React, 'useState').mockReturnValueOnce([state, vi.fn()]);
  vi.spyOn(ReactHooks, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  return renderToStaticMarkup(React.createElement(InputSettingsFileBar, { hasDraft: () => false }));
}

function decoded(bytes: Uint8Array): InputSettingsReading {
  const result = decodeInputSettingsFile(bytes);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

/** 窓に結果を出す欄の札(視点の操作・キー・マウスのボタン・放射メニューはタブの名前、吸着を止めるキーは form の題)。 */
const SECTION_LABELS = {
  view: 'settings.inputBindings.tab.view', keys: 'settings.inputBindings.tab.keys', mouse: 'settings.inputBindings.tab.mouse',
  radial: 'settings.inputBindings.tab.radial', snap: 'settings.snapPause.title',
} as const;

const button = (label: string, guide: string, disabled = false): string =>
  `<button type="button" class="pcad-button" title="${guide}"${disabled ? ' disabled=""' : ''}>${label}</button>`;

describe('設定のファイルの帯', () => {
  it('説明つきの「書き出す」「読み込む」だけを出し、知らせは出さない', () => {
    const markup = renderBar();
    expect(markup).toContain(`<section class="pcad-input-bindings__file" aria-label="${t('settings.inputBindings.file.title')}">`);
    expect(markup).toContain(button(t('settings.inputBindings.file.export'), t('settings.inputBindings.file.exportGuide')));
    expect(markup).toContain(button(t('settings.inputBindings.file.import'), t('settings.inputBindings.file.importGuide')));
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain('role="status"');
  });

  it('断った理由は警告として出す', () => {
    const text = t('settings.inputBindings.file.refusal.futureVersion');
    expect(renderBar({ kind: 'message', text, alert: true }))
      .toContain(`<p role="alert" class="pcad-input-bindings__file-note">${text}</p>`);
  });

  it('読んだ内容を欄ごとに示し、置き換えるまで保存しない(置き換える・やめるを出す)', () => {
    const reading = decoded(encodeInputSettingsFile(useAppStore.getState().displaySettings));
    const markup = renderBar({ kind: 'preview', fileName: 'mine.pcadinput', reading });
    expect(markup).toContain(t('settings.inputBindings.file.preview').replace('{name}', 'mine.pcadinput'));
    for (const label of Object.values(SECTION_LABELS)) {
      expect(markup).toContain(`<li>${t(label)}: ${t('settings.inputBindings.file.state.read')}</li>`);
    }
    expect(markup).toContain(button(t('settings.inputBindings.file.replace'), t('settings.inputBindings.file.replaceGuide')));
    expect(markup).toContain(button(t('settings.inputBindings.file.cancel'), t('settings.inputBindings.file.cancelGuide')));
    expect(markup).not.toContain('role="alert"');
  });

  it('今の視点のキーと読んだキーの割り当てが重なる時は、理由を出して置き換えを押せなくする', () => {
    const numpad: ViewTrigger = { kind: 'keys', keys: 'numpad', alt: false, shift: false, ctrl: false, meta: false };
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, viewControls: {
      ...DEFAULT_VIEW_CONTROLS, bindings: { ...DEFAULT_VIEW_CONTROLS.bindings, orbit: [...DEFAULT_VIEW_CONTROLS.bindings.orbit, numpad] } } });
    const reading = decoded(new TextEncoder().encode(
      JSON.stringify({ format: 'pointercad-input-settings', version: 1, mouseButtonCommands: { back: 'history.undo' } })));
    const markup = renderBar({ kind: 'preview', fileName: 'mouse.pcadinput', reading });
    expect(markup).toContain(`<li>${t('settings.inputBindings.tab.view')}: ${t('settings.inputBindings.file.state.absent')}</li>`);
    expect(markup).toContain(`<p role="alert" class="pcad-input-bindings__file-note">${t('settings.inputBindings.file.blocked')}</p>`);
    expect(markup).toContain(button(t('settings.inputBindings.file.replace'), t('settings.inputBindings.file.replaceGuide'), true));
  });

  it('置き換えた直後は「元に戻す」を出し、その後に割り当てが変わっていれば戻せないと知らせる', () => {
    const written = inputSettingsValuesOf(useAppStore.getState().displaySettings);
    const fresh = renderBar({ kind: 'replaced', previous: written, written });
    expect(fresh).toContain(t('settings.inputBindings.file.replaced'));
    expect(fresh).toContain(button(t('settings.inputBindings.file.undo'), t('settings.inputBindings.file.undoGuide')));
    const stale = renderBar({ kind: 'replaced', previous: written, written: { ...written, radialCommands: {} } });
    expect(stale).toContain(t('settings.inputBindings.file.undoUnavailable'));
    expect(stale).not.toContain(t('settings.inputBindings.file.undoGuide'));
  });
});
