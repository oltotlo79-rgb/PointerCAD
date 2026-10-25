import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { clampAnchor, NumericInputPopover, popoverMaxHeight } from './NumericInputPopover.js';
import { createNumericInput, reduceNumericInput } from './numericInput.js';
import { exactExpressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import type { PartDocument } from '@pointercad/model';
import { NumericMathDialog } from './NumericMathDialog.js';

interface KeyInput {
  readonly key: string;
  readonly nativeEvent: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}
interface NodeProps { readonly children?: ReactNode; readonly role?: string; readonly onKeyDown?: (event: KeyInput) => void }

function keyInput(key: string, shiftKey = false): KeyInput {
  return { key, nativeEvent: { key, keyCode: 0, isComposing: false }, shiftKey, ctrlKey: key === 'z',
    metaKey: false, altKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

function panelHandler(): (event: KeyInput) => void {
  let handler: NodeProps['onKeyDown'];
  function find(node: ReactNode): void {
    Children.forEach(node, (child) => {
      if (!isValidElement<NodeProps>(child)) return;
      if (child.props.role === 'dialog') handler = child.props.onKeyDown;
      find(child.props.children);
    });
  }
  function Probe(): null { find(NumericInputPopover({ viewportWidth: 800, viewportHeight: 600 })); return null; }
  renderToStaticMarkup(<Probe />);
  if (handler === undefined) throw new Error('NumericInputPopover handler missing');
  return handler;
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  const input = reduceNumericInput(createNumericInput('point', 'point', 'absolute'), { type: 'edit', index: 0, source: '10*2' });
  useAppStore.setState({ activeTool: 'point', numericInput: input, numericInputAnchor: [100, 100] });
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('NumericInputPopover real React handler and store (node, not DOM)', () => {
  it('rejects 100 late numeric-math apply callbacks after cancel without document/Undo/draft changes', async () => {
    const before = useAppStore.getState();
    if (before.numericInput === null) throw new Error('numeric draft missing');
    const tree = NumericMathDialog({ target: { document: before.document, documentVersion: before.documentVersion,
      input: before.numericInput, index: 0, lengthUnit: 'mm' }, onClose: vi.fn() });
    interface ApplyProps {
      readonly onApply: (value: ExpressionValue, prepared: PartDocument, signal: AbortSignal) => Promise<{ readonly ok: boolean }>;
    }
    if (!isValidElement<ApplyProps>(tree)) throw new Error('math callback missing');
    before.closeNumericInput(); const cancelled = useAppStore.getState();
    for (let index = 0; index < 100; index++) {
      expect(await tree.props.onApply(exactExpressionValueFromNumber(30), before.document, new AbortController().signal)).toMatchObject({ ok: false });
    }
    expect(useAppStore.getState().document).toBe(before.document); expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().numericInput).toBe(cancelled.numericInput);
  });
  it('normal Enter commits the expression once and one Undo restores the document', () => {
    const before = useAppStore.getState(), event = keyInput('Enter');
    panelHandler()(event);
    const after = useAppStore.getState();
    expect(after.sketch.features).toHaveLength(before.sketch.features.length + 1);
    expect(JSON.stringify(after.sketch.features.at(-1))).toContain('10*2');
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
    after.undo(); expect(useAppStore.getState().document).toBe(before.document);
  });
  it('normal Escape discards only the draft', () => {
    const before = useAppStore.getState(), event = keyInput('Escape'); panelHandler()(event);
    const after = useAppStore.getState();
    expect(after.numericInput).toBeNull(); expect(after.document).toBe(before.document); expect(after.undoStack).toBe(before.undoStack);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
  it('Tab and ShiftTab move between numeric fields without a document mutation', () => {
    const before = useAppStore.getState(); panelHandler()(keyInput('Tab'));
    expect(useAppStore.getState().numericInput?.focusedIndex).toBe(1);
    panelHandler()(keyInput('Tab', true));
    expect(useAppStore.getState().numericInput?.focusedIndex).toBe(0);
    expect(useAppStore.getState().document).toBe(before.document); expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });
  it.each(['Delete', 'Backspace', 'z'])('leaves native text %s to the input owner', key => {
    const before = useAppStore.getState(), event = keyInput(key); panelHandler()(event);
    expect(useAppStore.getState().numericInput).toBe(before.numericInput);
    expect(useAppStore.getState().document).toBe(before.document); expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
  });
  it.each([
    ['Enter', 13, true], ['Escape', 27, true], ['Enter', 229, false], ['Escape', 229, false], ['Process', 0, false],
  ] as const)('preserves draft/document/Undo for %s code %i composing %s', (key, keyCode, isComposing) => {
    const before = useAppStore.getState();
    const preventDefault = vi.fn(); const stopPropagation = vi.fn();
    panelHandler()({ key, nativeEvent: { key, keyCode, isComposing }, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault, stopPropagation });
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.numericInput).toBe(before.numericInput);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });
});

describe('Extrusion input commits through geometry calculation (EX-14)', () => {
  beforeEach(() => {
    useAppStore.setState({ activeTool: 'extrude', numericInput: createNumericInput('extrude', 'extrudeDistance'),
      numericInputAnchor: [100, 100], partStager: null, stagedSolid: null });
  });

  it('shows the localized preview action only for the extrusion step', () => {
    expect(renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={600} />))
      .toContain(t('numericInput.extrudePreview'));
    useAppStore.setState({ numericInput: createNumericInput('point', 'point', 'absolute') });
    expect(renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={600} />))
      .not.toContain(t('numericInput.extrudePreview'));
  });

  it('Alt+P previews through the same path without touching the document, Undo or the open input', () => {
    const before = useAppStore.getState();
    const event = { ...keyInput('p'), code: 'KeyP', altKey: true };
    panelHandler()(event);
    const after = useAppStore.getState();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(after.numericInput).toBe(before.numericInput);
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.solidErrorKey).toBe('solidError.extrudeUnavailable');
    expect(t('numericInput.extrudePreviewTooltip')).toContain('Alt+P');
  });

  it.each([[136, 100], [240, 200], [300, 280], [480, 470], [800, 760]])(
    'keeps every control inside a %ipx-high viewport by scrolling inside the input (anchor y=%i)', (viewportHeight, anchorY) => {
      const position = clampAnchor([100, anchorY], 800, viewportHeight);
      const maxHeight = popoverMaxHeight(position.top, viewportHeight);
      expect(position.top + maxHeight).toBeLessThanOrEqual(viewportHeight - 8);
      expect(maxHeight).toBeGreaterThanOrEqual(120);
      useAppStore.setState({ numericInputAnchor: [100, anchorY] });
      const markup = renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={viewportHeight} />);
      expect(markup).toContain(`max-height:${String(maxHeight)}px`);
      expect(markup).toContain('overflow-y:auto');
      for (const label of [t('numericInput.extrudePreview'), t('numericInput.commit'), t('numericInput.cancel')]) {
        expect(markup).toContain(label);
      }
    });

  it('Enter without the geometry scheduler keeps the input, document and Undo, and explains what to do', () => {
    const before = useAppStore.getState(), event = keyInput('Enter');
    panelHandler()(event);
    const after = useAppStore.getState();
    expect(after.numericInput).toBe(before.numericInput);
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.solidErrorKey).toBe('solidError.extrudeUnavailable');
    expect(t('solidError.extrudeUnavailable')).toContain(t('numericInput.commit'));
  });
});
