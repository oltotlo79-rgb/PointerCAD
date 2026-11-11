import React, { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSubShapeReference } from '@pointercad/model';
import { solidCadFaceKey } from '@pointercad/model/beam-analysis';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { ExpressionField, type ExpressionFieldProps } from '../sketch/ExpressionField.js';
import { t } from '../i18n/t.js';
import { SolidBoundaryFields } from './SolidBoundaryFields.js';
import { solidSavedInput } from './solidAnalysisSession.js';
import { context } from './solidAnalysis.testSupport.js';

interface ButtonProps { readonly 'data-testid'?: string; readonly onClick?: () => void; readonly disabled?: boolean }
interface CheckboxProps { readonly 'data-testid'?: string; readonly checked?: boolean;
  readonly onChange?: (event: { readonly currentTarget: { readonly checked: boolean } }) => void }
function view() {
  const nodes: ReactNode[] = [];
  const walk = (node: ReactNode): void => { Children.forEach(node, child => {
    nodes.push(child);
    if (isValidElement<{ readonly children?: ReactNode }>(child)) walk(child.props.children);
  }); };
  function Probe(): React.JSX.Element {
    const session = useAppStore.getState().solidAnalysisSession;
    if (!session) throw new Error('Missing session');
    const node = SolidBoundaryFields({ session }); walk(node); return node;
  }
  const html = renderToStaticMarkup(<Probe />);
  return { html, button: (id: string): ButtonProps => {
    for (const node of nodes) if (isValidElement<ButtonProps>(node) && node.type === 'button' && node.props['data-testid'] === id) return node.props;
    throw new Error(`Missing button ${id}`);
  }, checkbox: (id: string): CheckboxProps => {
    for (const node of nodes) if (isValidElement<CheckboxProps>(node) && node.type === 'input' && node.props['data-testid'] === id) return node.props;
    throw new Error(`Missing checkbox ${id}`);
  }, field: (key: string): ExpressionFieldProps => {
    for (const node of nodes) if (isValidElement<ExpressionFieldProps>(node) && node.type === ExpressionField && node.props.field.key === key) return node.props;
    throw new Error(`Missing field ${key}`);
  } };
}
function install() {
  const body = context().body;
  const face = (index: number): string => {
    const reference = createSubShapeReference(body, 'face', index);
    if (!reference?.origin) throw new Error('Missing origin');
    return solidCadFaceKey(reference);
  };
  useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidAnalysis();
  const session = useAppStore.getState().solidAnalysisSession;
  if (!session) throw new Error('Missing session');
  const runner = { run: vi.fn(), validate: vi.fn(), captureFaces: vi.fn(), cancel: vi.fn(), cancelModal: vi.fn(), cancelBuckling: vi.fn() };
  useAppStore.setState({ bodies: [body], solidAnalysisRunner: runner, solidAnalysisSession: { ...session,
    bodyFeatureId: body.featureId, fixedFaces: [face(0)], loadedFaces: [face(1)],
    values: { ...session.values, young: '210000', poisson: '0.3', tz: '2', volume: '1' } } });
  return { runner, face };
}
beforeEach(() => {
  resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null });
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
});
afterEach(() => {
  vi.restoreAllMocks(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); resetTestStore();
});
describe('solid boundary controls use actual store handlers (not browser acceptance)', () => {
  it('converts a full clamp once, edits signed displacement and removes editable fields from free axes', () => {
    const rig = install(), initial = view();
    expect(initial.html).toContain('面 1'); expect(initial.html).not.toContain(rig.face(0));
    initial.button('solid-clamp-convert-0').onClick?.();
    expect(useAppStore.getState().solidAnalysisSession?.fixedFaces).toEqual([]);
    expect(useAppStore.getState().solidAnalysisSession?.supports).toHaveLength(1);
    view().checkbox('solid-support-0-y-fixed').onChange?.({ currentTarget: { checked: false } });
    view().checkbox('solid-support-0-z-fixed').onChange?.({ currentTarget: { checked: false } });
    view().field('solid-support-0-x').onChange('-2mm');
    const next = view();
    expect(next.html).toContain('solid-support-0-y-free');
    expect(next.html).not.toMatch(/data-testid="solid-support-0-[yz]-free"[^>]*>[^<]*0 mm/u);
    expect(() => next.field('solid-support-0-y')).toThrow('Missing field');
    const session = useAppStore.getState().solidAnalysisSession;
    if (!session) throw new Error('Missing session');
    expect(solidSavedInput(session, useAppStore.getState().document.id, []).supports)
      .toEqual([{ face: rig.face(0), fixed: [true, false, false], prescribedMm: [-2, 0, 0] }]);
    next.button('solid-support-remove-0').onClick?.();
    expect(useAppStore.getState().solidAnalysisSession?.supports).toEqual([]);
  });
  it('wires selection capture and the existing strength help topic', () => {
    const { runner } = install();
    view().button('solid-support-add').onClick?.(); expect(runner.captureFaces).toHaveBeenCalledExactlyOnceWith('support');
    view().button('solid-boundary-help').onClick?.(); expect(useAppStore.getState().helpTopicId).toBe('strength');
  });
  it('authors gravity and clears surface faces without deleting its physical values', () => {
    install();
    view().checkbox('solid-gravity-enabled').onChange?.({ currentTarget: { checked: true } });
    for (const [name, value] of [['x', '1.25'], ['y', '-9.81'], ['z', '2.5'], ['density', '7800 kg/m³']])
      view().field(`solid-gravity-${name}`).onChange(value);
    view().button('solid-loaded-clear').onClick?.();
    const session = useAppStore.getState().solidAnalysisSession;
    if (!session) throw new Error('Missing session');
    const definition = solidSavedInput(session, useAppStore.getState().document.id, []);
    expect(definition.loadedFaces).toEqual([]);
    expect(definition.gravity).toEqual({ accelerationMps2: [1.25, -9.81, 2.5], densityKgM3: 7800 });
    expect(view().field('solid-gravity-density').unitLabel).toBe('kg/m³');
  });
  it('shows an all-free error and leaves focus changes outside calculation history', () => {
    const { runner } = install(); view().button('solid-clamp-convert-0').onClick?.();
    const before = useAppStore.getState().solidAnalysisSession?.revision;
    runner.cancel.mockClear(); runner.cancelModal.mockClear(); runner.cancelBuckling.mockClear();
    view().field('solid-support-0-x').onFocus();
    expect(useAppStore.getState().solidAnalysisSession?.revision).toBe(before);
    expect(runner.cancel).not.toHaveBeenCalled(); expect(runner.cancelModal).not.toHaveBeenCalled();
    for (const axis of ['x', 'y', 'z']) view().checkbox(`solid-support-0-${axis}-fixed`).onChange?.({ currentTarget: { checked: false } });
    expect(view().html).toContain(t('solidAnalysis.supportAllFree'));
  });
});
