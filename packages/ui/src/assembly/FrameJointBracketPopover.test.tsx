import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssemblyDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createFrameJointBracketDraft } from './frameJointBracketDraft.js';
import { FrameJointBracketPopover } from './FrameJointBracketPopover.js';

interface KeyInput {
  readonly key: string;
  readonly nativeEvent: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}
interface FormHandlers {
  readonly onKeyDown: (event: KeyInput) => void;
}
function formHandlers(): FormHandlers {
  let handlers: FormHandlers | undefined;
  function Probe(): null {
    const tree = FrameJointBracketPopover();
    if (isValidElement<FormHandlers>(tree)) handlers = tree.props;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (handlers === undefined) throw new Error('FrameJointBracketPopover form missing');
  return handlers;
}
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  useAppStore.getState().openAssembly(createAssemblyDocument('assembly'));
  useAppStore.setState({ assemblyJointBracketDraft: createFrameJointBracketDraft(useAppStore.getState().activeDocumentId, ['joint-1']) });
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('接続を留めるの窓の Esc(C-03。ほかの組立の窓と同じく閉じ、字の変換を確定する Esc では閉じない)', () => {
  it.each([
    ['Escape', 27, false, true], ['Escape', 229, false, false], ['Escape', 27, true, false], ['Process', 0, false, false], ['Enter', 13, false, false],
  ] as const)('%s(keyCode %d・変換中 %s)で閉じるのは %s', (key, keyCode, isComposing, closes) => {
    const preventDefault = vi.fn(), stopPropagation = vi.fn();
    formHandlers().onKeyDown({ key, nativeEvent: { key, keyCode, isComposing }, preventDefault, stopPropagation });
    expect(useAppStore.getState().assemblyJointBracketDraft === null).toBe(closes);
    expect(preventDefault).toHaveBeenCalledTimes(closes ? 1 : 0);
    expect(stopPropagation).toHaveBeenCalledTimes(closes ? 1 : 0);
  });
});
