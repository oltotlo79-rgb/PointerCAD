import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssemblyDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FilletWeldPopover } from './FilletWeldPopover.js';

interface FormHandlers {
  readonly onSubmit: (event: { readonly preventDefault: () => void }) => void;
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

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  const child = createAssemblyDocument('welded cell');
  useAppStore.getState().openAssembly(createAssemblyDocument('assembly'));
  expect(useAppStore.getState().beginFilletWeld()).toBe(true);
  const draft = useAppStore.getState().assemblyFilletWeldDraft;
  if (draft === null) throw new Error('draft missing');
  // Window-only check: the store state the public child command sets (target + edit draft + an OK plan preview).
  useAppStore.setState({
    assemblyFilletWeldDraft: { ...draft, weldId: 'weld-1' },
    assemblyChildWeldEdit: { path: ['P1', 'bead'], assemblyRef: 'welded-cell', child, weldId: 'weld-1', affectedPlacements: 2 },
    assemblyFilletWeldPreview: { kind: 'plan', result: { ok: true, plan: {
      weldId: 'weld-1', firstComponentId: 'a', secondComponentId: 'b',
      frame: { origin: [0, 0, 0], xAxis: [0, 1, 0], yAxis: [0, 0, 1], zAxis: [1, 0, 0] }, contactLength: 50,
      legOnSecond: 3, legOnFirst: 4, segments: [{ start: 10, length: 20 }], materialId: 'aluminum',
      interiorAngle: null, totalLength: 20, nominalVolume: 120, sourceIdentities: {}, replacedComponentIds: ['bead'],
      contact: [{ segment: 0, side: 'first', componentId: 'a', coveredRatio: 1 }],
    } } },
  });
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('FilletWeldPopover shared child-definition confirmation', () => {
  it('shows the actual affected placement count, an unchecked confirmation and a disabled commit, without the remove button', () => {
    const markup = renderToStaticMarkup(<FilletWeldPopover />);
    expect(markup).toContain('data-testid="fillet-weld-affected-placements"');
    expect(markup).toContain(`${t('assembly.filletWeld.sharedDefinition')} 2`);
    expect(markup).toContain(t('assembly.filletWeld.sharedDefinitionConfirm'));
    expect(markup).toMatch(/data-testid="fillet-weld-confirm-definition"(?![^>]*checked)/);
    expect(markup).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(markup).not.toContain('data-testid="fillet-weld-remove"');
  });

  it('does not commit an unconfirmed shared-definition edit through either commit command', () => {
    const state = useAppStore.getState();
    const child = vi.spyOn(state, 'commitChildFilletWeldEdit').mockReturnValue(true);
    const plain = vi.spyOn(state, 'commitFilletWeld').mockReturnValue(true);
    const submitDefault = vi.fn();
    formHandlers().onSubmit({ preventDefault: submitDefault });
    expect(submitDefault).toHaveBeenCalledOnce();
    expect(child).not.toHaveBeenCalled();
    expect(plain).not.toHaveBeenCalled();
  });

  it('keeps the ordinary weld window unchanged when no child-definition edit is active', () => {
    useAppStore.setState({ assemblyChildWeldEdit: null });
    const markup = renderToStaticMarkup(<FilletWeldPopover />);
    expect(markup).not.toContain('data-testid="fillet-weld-shared-definition"');
    expect(markup).toContain('data-testid="fillet-weld-remove"');
    expect(markup).not.toMatch(/<button type="submit"[^>]*disabled=""/);
  });
});
