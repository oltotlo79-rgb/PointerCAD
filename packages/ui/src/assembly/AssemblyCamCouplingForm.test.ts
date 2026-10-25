import React, { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssemblyDocument, createComponentFor, IDENTITY_PLACEMENT, type AssemblyDocument,
  type JointFrame, type MechanismCamCoupling } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { AssemblyCamCouplingForm, ignoreComposingEnter } from './AssemblyCamCouplingForm.js';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  vi.mocked(useState).mockImplementation(actual.useState);
  vi.restoreAllMocks(); resetTestStore();
});

interface CamFormHandlers {
  readonly onSubmit: (event: { readonly preventDefault: () => void }) => void;
  readonly children?: React.ReactNode;
}
function camHandlers(coupling?: MechanismCamCoupling): CamFormHandlers {
  let handlers: CamFormHandlers | undefined;
  function Probe(): null {
    const form = AssemblyCamCouplingForm({ jointId: 'jc', coupling });
    if (React.isValidElement<CamFormHandlers>(form)) handlers = form.props;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (handlers === undefined) throw new Error('actual cam form missing');
  return handlers;
}
function removeCam(form: CamFormHandlers): void {
  let remove: (() => void) | undefined;
  function visit(children: React.ReactNode): void {
    React.Children.forEach(children, child => {
      if (!React.isValidElement<{ readonly children?: React.ReactNode; readonly onClick?: () => void;
        readonly 'data-testid'?: string }>(child)) return;
      if (child.props['data-testid'] === 'assembly-cam-remove') remove = child.props.onClick;
      visit(child.props.children);
    });
  }
  visit(form.children);
  if (remove === undefined) throw new Error('actual remove button missing');
  remove();
}
async function replaceInitial(from: string, to: string): Promise<void> {
  const actual = await vi.importActual<typeof import('react')>('react');
  vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, React.Dispatch<React.SetStateAction<unknown>>] => {
    const state = actual.useState(initial);
    return initial === from ? [to, state[1]] : state;
  });
}
/** Cam revolute and follower slider on the fixed ground; the follower's slider origin (roller centre) is 29 mm out on x. */
function camFixture() {
  const base = createAssemblyDocument('cam UI');
  const ground = createComponentFor(base, { kind: 'part', partRef: 'ground' });
  const cam = createComponentFor({ ...base, components: [ground] }, { kind: 'part', partRef: 'cam' });
  const follower = createComponentFor({ ...base, components: [ground, cam] }, { kind: 'part', partRef: 'follower' });
  const document: AssemblyDocument = { ...base, components: [{ ...ground, fixed: true }, cam, follower], joints: [
    { id: 'jc', name: 'cam', kind: 'revolute', a: { kind: 'origin', componentId: cam.id, element: 'origin' },
      b: { kind: 'origin', componentId: ground.id, element: 'origin' }, minValue: null, maxValue: null, suppressed: false },
    { id: 'jf', name: 'follower', kind: 'slider', a: { kind: 'origin', componentId: follower.id, element: 'origin' },
      b: { kind: 'origin', componentId: ground.id, element: 'origin' }, minValue: null, maxValue: null, suppressed: false }] };
  const camFrame: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const sliderFrame: JointFrame = { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
  const view = { sourceDocument: document, resolved: { parts: new Map(), errors: [], partKeys: new Map(),
    placements: new Map([[ground.id, IDENTITY_PLACEMENT], [cam.id, IDENTITY_PLACEMENT],
      [follower.id, { ...IDENTITY_PLACEMENT, position: [29, 0, 0] as const }]]) },
    bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(),
    jointFrames: new Map([['jc', { a: camFrame, b: camFrame }], ['jf', { a: sliderFrame, b: sliderFrame }]]) };
  useAppStore.getState().openAssembly(document);
  useAppStore.setState({ assemblyView: view, selection: ['jc'], isComputing: false });
  return { document, view };
}

describe('EX12 actual cam form handlers and immutable operations', () => {
  it('shows the law and validity bounds, then create, update and remove each commit one Undo', async () => {
    const f = camFixture();
    const html = renderToStaticMarkup(createElement(AssemblyCamCouplingForm, { jointId: 'jc' }));
    for (const key of ['assembly.cam.title', 'assembly.cam.law', 'assembly.cam.validity', 'assembly.cam.follower',
      'assembly.cam.discRadius', 'assembly.cam.eccentricity', 'assembly.cam.rollerRadius', 'assembly.cam.phase',
      'assembly.cam.create'] as const) expect(html).toContain(renderToStaticMarkup(createElement(React.Fragment, null, t(key))));
    const preventDefault = vi.fn();
    camHandlers().onSubmit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    const created = useAppStore.getState().assembly, coupling = created?.camCouplings?.[0];
    if (created === null || coupling === undefined) throw new Error('actual form commit failed');
    expect(coupling).toMatchObject({ id: 'cam-1', kind: 'cam', camJointId: 'jc', followerJointId: 'jf',
      discRadiusMm: { source: '20', value: 20 }, eccentricityMm: { source: '5', value: 5 },
      rollerRadiusMm: { source: '0', value: 0 }, phaseDeg: { source: '0', value: 0 }, referenceAngleCam: 0, suppressed: false });
    expect(f.document.camCouplings).toBeUndefined();
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    useAppStore.setState({ assemblyView: { ...f.view, sourceDocument: created } });
    await replaceInitial('20', '18+2*1');
    camHandlers(coupling).onSubmit({ preventDefault: vi.fn() });
    const edited = useAppStore.getState().assembly, editedCoupling = edited?.camCouplings?.[0];
    if (edited === null || editedCoupling === undefined) throw new Error('actual edit failed');
    expect(editedCoupling.discRadiusMm).toMatchObject({ source: '18+2*1', value: 20 });
    expect(editedCoupling.id).toBe(coupling.id);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(2);
    useAppStore.setState({ assemblyView: { ...f.view, sourceDocument: edited } });
    removeCam(camHandlers(editedCoupling));
    expect(useAppStore.getState().assembly?.camCouplings).toEqual([]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.camCouplings?.[0].discRadiusMm.source).toBe('18+2*1');
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.camCouplings?.[0].discRadiusMm.source).toBe('20');
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(f.document);
  });

  it.each([['5', '25'], ['20', '0'], ['5', 'undefinedLength']])('refuses %s replaced by %s without document or Undo change', async (from, to) => {
    const f = camFixture(), before = useAppStore.getState();
    await replaceInitial(from, to);
    camHandlers().onSubmit({ preventDefault: vi.fn() });
    expect(useAppStore.getState().assembly).toBe(f.document);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });

  it('refuses a stale view or a running computation without document change', () => {
    const f = camFixture();
    useAppStore.setState({ assemblyView: { ...f.view, sourceDocument: { ...f.document } } });
    camHandlers().onSubmit({ preventDefault: vi.fn() });
    expect(useAppStore.getState().assembly).toBe(f.document);
    useAppStore.setState({ assemblyView: f.view, isComputing: true });
    camHandlers().onSubmit({ preventDefault: vi.fn() });
    expect(useAppStore.getState().assembly).toBe(f.document);
  });

  it('the Enter that confirms a Japanese conversion does not submit; a plain Enter is left to the form', () => {
    for (const [isComposing, keyCode, blocked] of [[true, 229, true], [false, 229, true], [true, 13, true], [false, 13, false]] as const) {
      const preventDefault = vi.fn();
      ignoreComposingEnter({ key: 'Enter', keyCode, nativeEvent: { isComposing }, preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(blocked ? 1 : 0);
    }
    const preventDefault = vi.fn();
    ignoreComposingEnter({ key: 'a', keyCode: 229, nativeEvent: { isComposing: true }, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
