import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addComponent, createAssemblyDocument, createComponentFor } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { BoltedJointPopover } from './BoltedJointPopover.js';

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
    const tree = BoltedJointPopover();
    if (isValidElement<FormHandlers>(tree)) handlers = tree.props;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (handlers === undefined) throw new Error('BoltedJointPopover form missing');
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
  for (const partRef of ['a', 'b']) document = addComponent(document,
    createComponentFor(document, { kind: 'part', partRef }));
  useAppStore.getState().openAssembly(document);
  expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
  // The view-handler fixture is ready. Real geometry, commit and Undo are exercised in the shared E2E.
  useAppStore.setState({ assemblyBoltedJointPreview: { kind: 'plan', result: { ok: true, plan: {
    configuration: 'throughBoltWithNut', headSideComponentId: 'component-1', farSideComponentId: 'component-2',
    nominal: 'M8', pitch: 1.25, threadSeries: 'coarse', gripLength: 20, boltLength: 40,
    engagedLength: null, penetration: null, protrusion: 13.2, lengthBasis: 'perDiameterEvidence',
    lengthVerified: true, missingFacts: [], sourceIdentities: {}, operations: [],
    alignment: { movedComponentIds: [], delta: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, placementFingerprints: {} },
  } } } });
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('BoltedJointPopover real React form handlers (node, synthetic events)', () => {
  it.each([
    ['Enter', 13, true], ['Escape', 27, true], ['Enter', 229, false], ['Escape', 229, false], ['Process', 0, false],
  ] as const)('does not commit/cancel or prevent IME key defaults for %s code %i composing %s', (value, code, composing) => {
    const form = formHandlers(), before = useAppStore.getState();
    const commit = vi.spyOn(before, 'commitBoltedJoint').mockReturnValue(true);
    const cancel = vi.spyOn(before, 'cancelBoltedJoint');
    const event = key(form, value, code, composing);
    const submitDefault = vi.fn();
    form.onSubmit({ preventDefault: submitDefault });
    expect(commit).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(submitDefault).toHaveBeenCalledOnce();
    const after = useAppStore.getState();
    expect(after.assembly).toBe(before.assembly); expect(after.document).toBe(before.document);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(after.assemblyBoltedJointDraft).toBe(before.assemblyBoltedJointDraft);
  });
  it('compositionend before implicit submit does not turn the confirming Enter into commit; the next normal Enter does', () => {
    const form = formHandlers(), before = useAppStore.getState();
    const commit = vi.spyOn(before, 'commitBoltedJoint').mockReturnValue(true);
    form.onCompositionStart();
    const event = key(form, 'Enter', 13, false);
    form.onCompositionEnd();
    form.onSubmit({ preventDefault: vi.fn() });
    expect(commit).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useAppStore.getState().assemblyBoltedJointDraft).toBe(before.assemblyBoltedJointDraft);
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    key(form, 'Enter', 13);
    form.onSubmit({ preventDefault: vi.fn() });
    expect(commit).toHaveBeenCalledOnce();
  });
  it.each(['pointer', 'Enter', ' '] as const)('explicit %s activation after composition still reaches ready commit once', activation => {
    const form = formHandlers();
    const commit = vi.spyOn(useAppStore.getState(), 'commitBoltedJoint').mockReturnValue(true);
    form.onCompositionStart(); key(form, 'Enter', 229); form.onCompositionEnd();
    if (activation === 'pointer') form.onPointerDownCapture();
    else key(form, activation, activation === 'Enter' ? 13 : 32);
    form.onSubmit({ preventDefault: vi.fn() });
    expect(commit).toHaveBeenCalledOnce();
  });
  it('normal Escape still cancels only the draft and leaves document/Undo unchanged', () => {
    const form = formHandlers(), before = useAppStore.getState();
    const event = key(form, 'Escape', 27);
    expect(useAppStore.getState().assemblyBoltedJointDraft).toBeNull();
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});
