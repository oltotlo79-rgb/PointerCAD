import { readFileSync } from 'node:fs';
import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addComponent, createAssemblyDocument, createComponentFor } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FilletWeldPopover } from './FilletWeldPopover.js';

interface KeyInput {
  readonly key: string;
  readonly nativeEvent: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}
interface FormHandlers {
  readonly onKeyDown: (event: KeyInput) => void;
  readonly onSubmit: (event: { readonly preventDefault: () => void }) => void;
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: () => void;
  readonly onPointerDownCapture: () => void;
}
function formHandlers(): FormHandlers {
  let handlers: FormHandlers | undefined;
  function Probe(): null {
    const tree = FilletWeldPopover();
    if (isValidElement<FormHandlers>(tree)) handlers = tree.props;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (handlers === undefined) throw new Error('FilletWeldPopover form missing');
  return handlers;
}
function key(form: FormHandlers, value: string, keyCode = 0, isComposing = false) {
  const preventDefault = vi.fn(), stopPropagation = vi.fn();
  form.onKeyDown({ key: value, nativeEvent: { key: value, keyCode, isComposing }, preventDefault, stopPropagation });
  return { preventDefault, stopPropagation };
}
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  let document = createAssemblyDocument('assembly');
  for (const partRef of ['a', 'b']) document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }));
  useAppStore.getState().openAssembly(document);
  expect(useAppStore.getState().beginFilletWeld()).toBe(true);
  // 窓の手続きの検査用に、確定できる予告を置く。実際の形・確定・Undo は filletWeldStore.test と Root の E2E。
  useAppStore.setState({ assemblyFilletWeldPreview: { kind: 'plan', result: { ok: true, plan: {
    weldId: 'weld-1', firstComponentId: 'component-1', secondComponentId: 'component-2',
    frame: { origin: [0, 34, 10], xAxis: [0, 1, 0], yAxis: [0, 0, 1], zAxis: [1, 0, 0] }, contactLength: 100,
    legOnSecond: 6, legOnFirst: 8, segments: [{ start: 10, length: 20 }, { start: 40, length: 15 }], materialId: 'steel',
    interiorAngle: null, totalLength: 35, nominalVolume: 840, sourceIdentities: {}, replacedComponentIds: [],
    contact: [{ segment: 0, side: 'first', componentId: 'component-1', coveredRatio: 1 }],
  } } } });
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('FilletWeldPopover real React form handlers (node, synthetic events)', () => {
  it.each([
    ['Enter', 13, true], ['Escape', 27, true], ['Enter', 229, false], ['Escape', 229, false], ['Process', 0, false],
  ] as const)('does not commit/cancel or prevent IME key defaults for %s code %i composing %s', (value, code, composing) => {
    const form = formHandlers(), before = useAppStore.getState();
    const commit = vi.spyOn(before, 'commitFilletWeld').mockReturnValue(true);
    const cancel = vi.spyOn(before, 'cancelFilletWeld');
    const event = key(form, value, code, composing);
    const submitDefault = vi.fn();
    form.onSubmit({ preventDefault: submitDefault });
    expect(commit).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(submitDefault).toHaveBeenCalledOnce();
    const after = useAppStore.getState();
    expect(after.assembly).toBe(before.assembly);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.assemblyFilletWeldDraft).toBe(before.assemblyFilletWeldDraft);
  });

  it('compositionend before implicit submit does not turn the confirming Enter into commit; the next normal Enter does', () => {
    const form = formHandlers(), before = useAppStore.getState();
    const commit = vi.spyOn(before, 'commitFilletWeld').mockReturnValue(true);
    form.onCompositionStart();
    const event = key(form, 'Enter', 13, false);
    form.onCompositionEnd();
    form.onSubmit({ preventDefault: vi.fn() });
    expect(commit).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useAppStore.getState().assemblyFilletWeldDraft).toBe(before.assemblyFilletWeldDraft);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    key(form, 'Enter', 13);
    form.onSubmit({ preventDefault: vi.fn() });
    expect(commit).toHaveBeenCalledOnce();
  });

  it('explicit pointer activation after composition still reaches ready commit once', () => {
    const form = formHandlers();
    const commit = vi.spyOn(useAppStore.getState(), 'commitFilletWeld').mockReturnValue(true);
    form.onCompositionStart(); key(form, 'Enter', 229); form.onCompositionEnd();
    form.onPointerDownCapture();
    form.onSubmit({ preventDefault: vi.fn() });
    expect(commit).toHaveBeenCalledOnce();
  });

  it('normal Escape cancels only the draft and leaves document/Undo unchanged', () => {
    const form = formHandlers(), before = useAppStore.getState();
    const event = key(form, 'Escape', 27);
    expect(useAppStore.getState().assemblyFilletWeldDraft).toBeNull();
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it('shows the first pick prompt, the plan summary and both honesty notes without inventing a material', () => {
    const markup = renderToStaticMarkup(<FilletWeldPopover />);
    expect(markup).toContain(t('assembly.filletWeld.pickFirstFace'));
    expect(markup).toContain(t('assembly.filletWeld.contactNote'));
    expect(markup).toContain(t('assembly.filletWeld.strengthNote'));
    expect(markup).toContain('data-testid="fillet-weld-volume"');
    expect(markup).toMatch(/<option value="" selected="">/u);
    expect(markup).not.toContain('data-testid="fillet-weld-remove"');
  });
});

// .tsx には注釈の外へ日本語を書かない(i18n.test.ts)。文言そのものの検査は filletWeldStatus.test.ts(.ts)にある。
describe('FilletWeldPopover oblique joint summary', () => {
  it('shows no angle line for a right-angle plan and the localized interior angle for an oblique plan', () => {
    expect(renderToStaticMarkup(<FilletWeldPopover />)).not.toContain('fillet-weld-angle');
    const preview = useAppStore.getState().assemblyFilletWeldPreview;
    if (preview?.kind !== 'plan' || !preview.result.ok) throw new Error('fixture');
    useAppStore.setState({ assemblyFilletWeldPreview: { kind: 'plan', result: { ok: true, plan: {
      ...preview.result.plan, interiorAngle: { degrees: 60, cos: 0.5, sin: Math.sqrt(3) / 2 } } } } });
    const markup = renderToStaticMarkup(<FilletWeldPopover />);
    expect(markup).toContain('data-testid="fillet-weld-angle"');
    expect(markup).toContain(`${t('assembly.filletWeld.interiorAngle')} 60`);
  });
});

describe('FilletWeldPopover stacking order', () => {
  it('draws the weld window above the later assembly timeline in the same absolute layer (same rule as the bolted joint window)', () => {
    const css = readFileSync(new URL('../shell/appShell.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
    const weld = /\.pcad-popover--fillet-weld\s*(?:,[^{]*)?\{[^}]*z-index:\s*(\d+);/u.exec(css);
    const timeline = /\.pcad-assembly-motion\s*\{[^}]*z-index:\s*(\d+);/u.exec(css);
    expect(timeline?.[1]).toBe('2');
    // 規則が無ければ窓は .pcad-popover の z-index 2 のままで、後に描く時間軸に「溶接する」が隠れる。
    expect(Number(weld?.[1])).toBeGreaterThan(Number(timeline?.[1]));
  });
});
