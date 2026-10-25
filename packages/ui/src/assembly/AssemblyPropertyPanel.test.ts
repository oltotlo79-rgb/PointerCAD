import React, { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssemblyDocument, createComponentFor, IDENTITY_PLACEMENT, type AssemblyDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { repairFixture } from '../solid/referenceRepairFixture.js';
import { beginReferenceRepair, cancelReferenceRepair } from '../solid/referenceRepair.js';
import { currentRepairSlots } from '../solid/referenceRepairContext.js';
import { AssemblyPropertyPanel, AssemblyGearCouplingForm } from './AssemblyPropertyPanel.js';
import type { JointFrame, MechanismGearCoupling } from '@pointercad/model';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

beforeEach(() => {
  resetTestStore();
  const { body, reference } = repairFixture(), empty = createAssemblyDocument('repair assembly');
  const a = createComponentFor(empty, { kind: 'part', partRef: 'a' });
  const b = createComponentFor({ ...empty, components: [a] }, { kind: 'part', partRef: 'b' });
  const document: AssemblyDocument = { ...empty, components: [a, b], mates: [{
    id: 'repair-mate', name: 'repair parallel', kind: 'parallel', suppressed: false, flipped: false,
    a: { kind: 'subShape', componentId: a.id, ref: reference },
    b: { kind: 'subShape', componentId: b.id, ref: reference },
  }] };
  useAppStore.getState().openAssembly(document);
  useAppStore.setState({ selection: [], isComputing: false, assemblyView: { sourceDocument: document,
    resolved: { parts: new Map(), errors: [], placements: new Map([[a.id, IDENTITY_PLACEMENT], [b.id, IDENTITY_PLACEMENT]]),
      partKeys: new Map([[a.id, 'a'], [b.id, 'b']]) },
    bodies: new Map([['a', [body]], ['b', [body]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(),
  } });
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  vi.mocked(useState).mockImplementation(actual.useState);
  vi.restoreAllMocks(); resetTestStore();
});
const render = (): string => renderToStaticMarkup(createElement(AssemblyPropertyPanel));

interface GearFormHandlers {
  readonly onSubmit: (event: { readonly preventDefault: () => void }) => void;
  readonly children?: React.ReactNode;
}
function gearHandlers(coupling?: MechanismGearCoupling): GearFormHandlers {
  let handlers: GearFormHandlers | undefined;
  function Probe(): null {
    const form = AssemblyGearCouplingForm({ jointId: 'ja', coupling });
    if (React.isValidElement<GearFormHandlers>(form)) handlers = form.props;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (handlers === undefined) throw new Error('actual gear form missing');
  return handlers;
}
function removeGear(form: GearFormHandlers): void {
  let remove: (() => void) | undefined;
  function visit(children: React.ReactNode): void {
    React.Children.forEach(children, child => {
      if (!React.isValidElement<{ readonly children?: React.ReactNode; readonly onClick?: () => void;
        readonly 'data-testid'?: string }>(child)) return;
      if (child.props['data-testid'] === 'assembly-gear-remove') remove = child.props.onClick;
      visit(child.props.children);
    });
  }
  visit(form.children);
  if (remove === undefined) throw new Error('actual remove button missing');
  remove();
}
function gearFixture() {
  const base = createAssemblyDocument('gear UI');
  const ground = createComponentFor(base, { kind: 'part', partRef: 'ground' });
  const a = createComponentFor({ ...base, components: [ground] }, { kind: 'part', partRef: 'a' });
  const b = createComponentFor({ ...base, components: [ground, a] }, { kind: 'part', partRef: 'b' });
  const document: AssemblyDocument = { ...base, components: [{ ...ground, fixed: true }, a, b],
    joints: [a, b].map((component, index) => ({ id: index === 0 ? 'ja' : 'jb', name: component.name,
      kind: 'revolute', a: { kind: 'origin', componentId: component.id, element: 'origin' },
      b: { kind: 'origin', componentId: ground.id, element: 'origin' }, minValue: null, maxValue: null,
      suppressed: false })) };
  const frame: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const view = { sourceDocument: document, resolved: { parts: new Map(), errors: [], partKeys: new Map(),
    placements: new Map([[ground.id, IDENTITY_PLACEMENT], [a.id, IDENTITY_PLACEMENT], [b.id, IDENTITY_PLACEMENT]]) },
    bodies: new Map(), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(),
    jointFrames: new Map(document.joints.map(j => [j.id, { a: frame, b: frame }])) };
  useAppStore.getState().openAssembly(document);
  useAppStore.setState({ assemblyView: view, selection: ['ja'], isComputing: false });
  return { document, view };
}

describe('EX12 actual property form handlers and immutable operations', () => {
  it('actual submit, update and remove handlers preserve sources and Undo each operation', async () => {
    const f = gearFixture(), html = render();
    for (const key of ['assembly.gear.title', 'assembly.gear.ratio', 'assembly.gear.phase', 'assembly.gear.create'] as const)
      expect(html).toContain(t(key));
    const first = gearHandlers(), preventDefault = vi.fn();
    first.onSubmit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    const created = useAppStore.getState().assembly;
    const coupling = created?.mechanismCouplings?.[0];
    if (created === null || coupling === undefined) throw new Error('actual form commit failed');
    expect(coupling).toMatchObject({ jointAId: 'ja', jointBId: 'jb', ratio: { source: '-2', value: -2 },
      phaseDeg: { source: '0', value: 0 }, referenceAngleA: 0 });
    expect(f.document.mechanismCouplings).toBeUndefined();
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    useAppStore.setState({ assemblyView: { ...f.view, sourceDocument: created } });
    const actual = await vi.importActual<typeof import('react')>('react');
    vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, React.Dispatch<React.SetStateAction<unknown>>] => {
      const state = actual.useState(initial);
      return initial === '-2' ? ['-3', state[1]] : state;
    });
    gearHandlers(coupling).onSubmit({ preventDefault: vi.fn() });
    const edited = useAppStore.getState().assembly;
    const editedCoupling = edited?.mechanismCouplings?.[0];
    if (edited === null || editedCoupling === undefined) throw new Error('actual edit failed');
    expect(editedCoupling.ratio).toMatchObject({ source: '-3', value: -3 });
    expect(editedCoupling.id).toBe(coupling.id);
    useAppStore.setState({ assemblyView: { ...f.view, sourceDocument: edited } });
    removeGear(gearHandlers(editedCoupling));
    expect(useAppStore.getState().assembly?.mechanismCouplings).toEqual([]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.mechanismCouplings?.[0].ratio.source).toBe('-3');
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly?.mechanismCouplings?.[0].ratio.source).toBe('-2');
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(f.document);
  });
  it('actual create measures a nonzero angle branch from the real revolute coordinate', () => {
    const f = gearFixture(), rotor = f.document.joints[0]?.a.componentId;
    if (rotor === undefined) throw new Error('fixture rotor');
    const placements = new Map(f.view.resolved.placements);
    // A physical +30 degree joint coordinate requires a -30 degree rotor placement in this frame convention.
    placements.set(rotor, { position: [0, 0, 0], rotation: [0, 0, -Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)] });
    useAppStore.setState({ assemblyView: { ...f.view, resolved: { ...f.view.resolved, placements } } });
    const before = useAppStore.getState().assemblyUndoStack;
    gearHandlers().onSubmit({ preventDefault: vi.fn() });
    const coupling = useAppStore.getState().assembly?.mechanismCouplings?.[0];
    expect(coupling).toBeDefined();
    expect(coupling?.referenceAngleA).toBeCloseTo(30, 10);
    expect(coupling?.ratio.source).toBe('-2');
    expect(useAppStore.getState().assemblyUndoStack).not.toBe(before);
    expect(f.document.mechanismCouplings).toBeUndefined();
  });
  it.each(['document', 'view', 'computing'] as const)('actual submit refuses newly stale%s state before mutation', change => {
    const f = gearFixture(), form = gearHandlers();
    if (change === 'document') useAppStore.getState().applyAssembly({ ...f.document, name: 'new owner' });
    else if (change === 'view') useAppStore.setState({ assemblyView: { ...f.view } });
    else useAppStore.setState({ isComputing: true });
    const before = useAppStore.getState();
    form.onSubmit({ preventDefault: vi.fn() });
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    expect(useAppStore.getState().assemblyMotionPlacements).toBe(before.assemblyMotionPlacements);
  });
  it.each(['peer', 'reference', 'suppressed'] as const)('actual form identity remounts after%s edit and Undo', field => {
    const f = gearFixture(), extra = createComponentFor(f.document, { kind: 'part', partRef: 'c' });
    const firstJoint = f.document.joints[0], frames = f.view.jointFrames.get('ja');
    if (firstJoint === undefined || frames === undefined) throw new Error('fixture');
    const document: AssemblyDocument = { ...f.document, components: [...f.document.components, extra],
      joints: [...f.document.joints, { ...firstJoint, id: 'jc',
        a: { kind: 'origin', componentId: extra.id, element: 'origin' } }] };
    const view = { ...f.view, sourceDocument: document, resolved: { ...f.view.resolved,
      placements: new Map([...f.view.resolved.placements, [extra.id, IDENTITY_PLACEMENT]]) },
      jointFrames: new Map([...f.view.jointFrames, ['jc', frames]]) };
    useAppStore.getState().openAssembly(document);
    useAppStore.setState({ assemblyView: view, selection: ['ja'], isComputing: false });
    gearHandlers().onSubmit({ preventDefault: vi.fn() });
    const created = useAppStore.getState().assembly, coupling = created?.mechanismCouplings?.[0];
    if (created === null || coupling === undefined) throw new Error('actual create required');
    const couplingId = coupling.id;
    function currentFormIdentity() {
      let result: { readonly key: string | null; readonly peer: string } | undefined;
      function Probe(): null {
        function visit(children: React.ReactNode): void {
          React.Children.forEach(children, child => {
            if (!React.isValidElement<{ readonly children?: React.ReactNode;
              readonly coupling?: MechanismGearCoupling }>(child)) return;
            if (child.type === AssemblyGearCouplingForm && child.props.coupling !== undefined && child.props.coupling.id === couplingId)
              result = { key: child.key, peer: child.props.coupling.jointBId };
            visit(child.props.children);
          });
        }
        visit(AssemblyPropertyPanel());
        return null;
      }
      renderToStaticMarkup(createElement(Probe));
      if (result === undefined) throw new Error('actual keyed form required');
      return result;
    }
    const before = currentFormIdentity();
    useAppStore.setState({ assemblyView: { ...view, sourceDocument: created } });
    const edited = field === 'peer' ? { ...coupling, jointBId: 'jc' }
      : field === 'reference' ? { ...coupling, referenceAngleA: 360 } : { ...coupling, suppressed: true };
    expect(useAppStore.getState().setAssemblyMechanismCouplings([edited])).toBe(true);
    const after = currentFormIdentity();
    expect(after.key).not.toBe(before.key);
    expect(after.peer).toBe(field === 'peer' ? 'jc' : 'jb');
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(created);
    expect(useAppStore.getState().selection).toEqual([]);
    // Undo legitimately clears selection. Publish the restored document's fixture view and reselect the joint.
    useAppStore.setState({ selection: ['ja'], assemblyView: { ...view, sourceDocument: created } });
    expect(currentFormIdentity()).toEqual(before);
  });
  it('actual submit refuses zero source and leaves the valid document and Undo untouched', async () => {
    gearFixture();
    const actual = await vi.importActual<typeof import('react')>('react');
    vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, React.Dispatch<React.SetStateAction<unknown>>] => {
      const state = actual.useState(initial);
      return initial === '-2' ? ['0', state[1]] : state;
    });
    const before = useAppStore.getState();
    gearHandlers().onSubmit({ preventDefault: vi.fn() });
    expect(useAppStore.getState().assembly).toBe(before.assembly);
    expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
  });
});

describe('Assembly repair entry in the actual property panel', () => {
  it('exposes unresolved repair with no selection and keeps BOM, empty state and document/history unchanged', () => {
    const before = useAppStore.getState(), html = render();
    expect(html).toContain('data-testid="reference-repair"');
    expect(html).toContain(t('propertyPanel.repair.open'));
    expect(html).toContain(t('propertyPanel.empty'));
    expect(html).toContain(t('assembly.bom.title'));
    expect(useAppStore.getState()).toBe(before);
    expect(before.selection).toEqual([]);
  });
  it('renders original, current candidates and both affected mate sides together without committing', async () => {
    const session = beginReferenceRepair(currentRepairSlots(useAppStore.getState())[0].key);
    if (session === null) throw new Error('Current assembly repair session required');
    const actual = await vi.importActual<typeof import('react')>('react');
    let selectorReady = false, injected = 0;
    vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, React.Dispatch<React.SetStateAction<unknown>>] => {
      const state = actual.useState(initial);
      if (typeof initial === 'function' && typeof state[0] === 'function') selectorReady = true;
      else if (selectorReady && initial === null && injected === 0) {
        selectorReady = false; injected += 1;
        return [session, state[1]];
      }
      return state;
    });
    const before = useAppStore.getState(), html = render();
    expect(injected).toBe(1);
    for (const key of ['propertyPanel.repair.original', 'propertyPanel.repair.candidates', 'propertyPanel.repair.impacts',
      'propertyPanel.repair.cancel', 'propertyPanel.repair.confirm'] as const) expect(html).toContain(t(key));
    expect(html).toContain('辺 99');
    expect(html).toContain('長さ 10 mm');
    expect(html).toContain('長さ 40 mm');
    expect(session.impacts).toHaveLength(2);
    expect(html.match(/repair parallel/g)?.length).toBeGreaterThanOrEqual(2);
    expect(useAppStore.getState()).toBe(before);
    cancelReferenceRepair(session);
  });
  it('keeps selected unresolved mate diagnosis and disables repair while recompute is pending', () => {
    const state = useAppStore.getState(), view = state.assemblyView;
    if (view === null) throw new Error('Current assembly view required');
    useAppStore.setState({ selection: ['repair-mate'], isComputing: true,
      assemblyView: { ...view, mateTargetErrors: new Map([['repair-mate', ['unresolved target']]]) } });
    const before = useAppStore.getState(), html = render();
    expect(html).toContain(t('assembly.property.unresolved'));
    expect(html).toContain(t('propertyPanel.repair.pending'));
    expect(html).toMatch(/disabled=""[^>]*title=/);
    expect(html).toContain(t('assembly.bom.title'));
    expect(useAppStore.getState()).toBe(before);
  });
  it('keeps the completed interference result beside repair and BOM without changing its owner', () => {
    useAppStore.setState({ assemblyInterferenceResult: { kind: 'checked', failure: null, requestId: 'current-interference',
      pairs: [], failures: [], skips: [], totalPairCount: 1, checkedPairCount: 1, skippedPairCount: 0,
      pendingPairCount: 0, cancelled: false } });
    const before = useAppStore.getState(), html = render();
    expect(html).toContain('data-testid="reference-repair"');
    expect(html).toContain(t('assembly.property.interferenceSection'));
    expect(html).toContain(t('assembly.interference.none'));
    expect(html).toContain(t('assembly.bom.title'));
    expect(useAppStore.getState()).toBe(before);
  });
});
