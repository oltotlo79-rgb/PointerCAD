import React, { Children, cloneElement, isValidElement, type DependencyList, type EffectCallback, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDocumentBundle, writePcadaFile } from '@pointercad/io';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { savedBoltFixture } from '../../../model/src/analysis/cadNativeBoltPreloadInput.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachBeamAnalysis, type BeamAttachment } from '../beam/attachBeamAnalysis.js';
import { StrengthPropertyPanel } from './StrengthPropertyPanel.js';
import { BoltPreloadPanel } from '../beam/BoltPreloadPanel.js';

interface Control { readonly children?: ReactNode; readonly 'data-testid'?: string; readonly 'data-preload-open'?: string; readonly onClick?: () => void }
const captured = { buttons: [] as ReactElement<Control>[] };
const lifecycle = vi.hoisted(() => ({ pending: [] as { readonly callback: EffectCallback; readonly deps: DependencyList | undefined }[] }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useEffect: (callback: EffectCallback, deps?: DependencyList) => { lifecycle.pending.push({ callback, deps }); } };
});
function walk(node: ReactNode): void {
  Children.forEach(node, child => {
    if (!isValidElement<Control>(child)) return;
    if (child.type === 'button') captured.buttons.push(child);
    walk(child.props.children);
  });
}
function ParentProbe(): ReactElement | null {
  const panel = StrengthPropertyPanel();
  if (!isValidElement<Control>(panel)) return null;
  return cloneElement(panel, undefined, Children.map(panel.props.children, child => {
    if (!isValidElement(child) || child.type !== BoltPreloadPanel) return child;
    const rendered = BoltPreloadPanel(); walk(rendered); return rendered;
  }));
}

// Node統合: 実親/全子のSSRと実handler/store。passive effectの設置/破棄だけを明示駆動する。
// DOM/ネイティブ表示の成功ではない。activeDocumentIdを文書idへ書き換えない。
interface Effect { readonly deps: DependencyList | undefined; readonly cleanup: (() => void) | undefined }
let effects: Effect[] = [];
let attachment: BeamAttachment | null = null;
function unmount(): void { for (const effect of effects) effect.cleanup?.(); effects = []; }
function render(): string {
  captured.buttons = []; lifecycle.pending = [];
  const html = renderToStaticMarkup(<ParentProbe />);
  const next = lifecycle.pending.map((entry, index) => {
    const before = effects[index];
    if (before !== undefined && entry.deps !== undefined && before.deps !== undefined
      && entry.deps.length === before.deps.length && entry.deps.every((value, i) => Object.is(value, before.deps?.[i]))) return before;
    before?.cleanup?.(); const cleanup = entry.callback(); return { deps: entry.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
  });
  for (const effect of effects.slice(next.length)) effect.cleanup?.();
  effects = next; return html;
}
function click(id: string, saved = false): void {
  render();
  const controls = captured.buttons.filter(element => saved ? element.props['data-preload-open'] === id : element.props['data-testid'] === id);
  expect(controls).toHaveLength(1); controls[0].props.onClick?.();
}
async function open(): Promise<void> {
  const fixture = savedBoltFixture();
  const document = withBeamAnalysisInputs(fixture.document, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'native-bolt-preload', definition: fixture.saved }] });
  const read = await readDocumentBundle(await writePcadaFile(document, { savedAt: '2026-10-27T00:00:00.000Z' }), 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error('Actual saved assembly refused');
  useAppStore.getState().openAssembly(read.bundle.document);
  useAppStore.getState().toggleStrength();
  expect(useAppStore.getState().activeDocumentId).not.toBe(read.bundle.document.id);
  attachment = attachBeamAnalysis(useAppStore, () => { throw new Error('These lifecycle actions must not dispatch native work'); });
}
beforeEach(() => {
  resetTestStore(); effects = []; lifecycle.pending = [];
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
});
afterEach(() => { unmount(); attachment?.dispose(); attachment = null; vi.restoreAllMocks(); resetTestStore(); });

describe('strength parent with ordinary saved bolt input and distinct opening owner', () => {
  it('opens from the actual saved input handler, hides the ordinary form and keeps the current draft', async () => {
    await open();
    expect(render()).toContain('pcad-strength');
    const before = useAppStore.getState(), document = before.assembly;
    click('axial', true);
    expect(useAppStore.getState().boltPreloadError).toBeNull();
    expect(render()).toContain('data-testid="preload-reassociate"');
    expect(render()).not.toContain('class="pcad-panel__body pcad-strength"');
    expect(useAppStore.getState().assembly).toBe(document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });
  it('closes, reopens with the same strength owner, and releases through the real runner on unmount', async () => {
    await open(); click('axial', true);
    const owner = useAppStore.getState().strengthSession, runner = useAppStore.getState().boltPreloadRunner;
    if (runner === null) throw new Error('Real runner missing');
    const cancel = vi.spyOn(runner, 'cancel');
    click('preload-close'); expect(useAppStore.getState().boltPreloadDraft).toBeNull();
    expect(render()).toContain('pcad-strength');
    click('axial', true); expect(render()).toContain('data-testid="preload-reassociate"');
    expect(useAppStore.getState().strengthSession).toBe(owner);
    cancel.mockClear(); unmount();
    expect(cancel).toHaveBeenCalledOnce(); expect(useAppStore.getState().boltPreloadDraft).toBeNull();
    expect(attachment?.statistics().live).toBe(0);
    expect(render()).toContain('data-preload-open="axial"');
  });
  it.each(['analysis', 'same-document-reopen', 'opening-owner'] as const)('drops the old draft after %s changes', async reason => {
    await open(); click('axial', true);
    expect(render()).toContain('data-testid="preload-reassociate"');
    const document = useAppStore.getState().assembly, history = useAppStore.getState().assemblyUndoStack;
    if (document === null) throw new Error('Assembly missing');
    if (reason === 'analysis') useAppStore.getState().editStrength({ kind: 'calculation', calculation: { kind: 'shaft' } });
    else if (reason === 'same-document-reopen') useAppStore.getState().openAssembly(document);
    else useAppStore.setState({ activeDocumentId: 'different-opening-owner' });
    expect(useAppStore.getState().boltPreloadDraft).toBeNull();
    expect(useAppStore.getState().boltPreloadAuthor).toBeNull();
    expect(render()).not.toContain('data-testid="preload-result"');
    if (reason !== 'same-document-reopen') expect(useAppStore.getState().assemblyUndoStack).toBe(history);
    expect(useAppStore.getState().assembly).toBe(document); expect(attachment?.statistics().live).toBe(0);
  });
});
