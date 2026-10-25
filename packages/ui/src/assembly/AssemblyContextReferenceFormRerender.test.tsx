import React, { isValidElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, appendReference, type AssemblyDocument, type ContextReferenceLink, createAssemblyDocument,
  createComponentFor, createEmptyPartDocument, createSubShapeReference, embedPart, findReference, IDENTITY_PLACEMENT, type PartLibrary,
  type ReferencePointFeature, type SolidBody, type SubShapeRef,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { AssemblyContextReferenceForm } from './AssemblyContextReferenceForm.js';

// 既存の AssemblyPropertyPanel.test.ts と同じく、本物の useState を包んで描き直しを再現する。
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

function point(id: string): ReferencePointFeature {
  return { id, name: id, visible: true, kind: 'referencePoint', definition: { kind: 'coordinate', at: { mode: 'absolute',
    x: expressionValueFromNumber(0), y: expressionValueFromNumber(0), z: expressionValueFromNumber(0) } } };
}

/** 元(B)の今のボディ。面0(円筒)の中心が部品の座標で (5,0,0)。 */
const BODY: SolidBody = { featureId: 'extrude-1', mesh: { positions: new Float32Array([0, 0, 0, 10, 10, 10]),
  normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
volume: 1, isValid: true, edges: [], vertices: [], threadMarks: [],
origins: { version: 1, state: 'tracked', bindings: [{
  origin: { version: 1, shapeKind: 'face', identity: { kind: 'cylinder-face', featureId: 'extrude-1', role: 'side' } },
  state: 'unique', current: { kind: 'face', index: 0 },
}] },
faces: [{ index: 0, surfaceKind: 'cylinder', area: 10, centroid: [5, 0, 0], axis: [0, 0, 1], radius: 2,
  triangleOffset: 0, triangleCount: 0 }] };
const FACE: SubShapeRef = { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'face', surfaceKind: 'cylinder',
  area: 10, position: [5, 0, 0], axis: [0, 0, 1], radius: 2 } };

async function open() {
  const empty: PartLibrary = { partFiles: [], parts: new Map(), attachments: new Map() };
  const bracket = await embedPart(empty, appendReference(appendReference(createEmptyPartDocument(), point('point-1')),
    point('point-2')), 'a.pcad', 'a.pcad');
  const base = await embedPart(bracket.library, createEmptyPartDocument(), 'b.pcad', 'b.pcad');
  let document: AssemblyDocument = createAssemblyDocument('context rerender');
  const a = createComponentFor(document, { kind: 'part', partRef: bracket.partRef });
  document = addComponent(document, a);
  const b = createComponentFor(document, { kind: 'part', partRef: base.partRef });
  document = addComponent(document, b);
  const links: readonly ContextReferenceLink[] = [
    { id: 'context-1', targetComponentId: a.id, targetReferenceId: 'point-1', sourceComponentId: b.id, source: FACE },
    { id: 'context-2', targetComponentId: a.id, targetReferenceId: 'point-2', sourceComponentId: b.id, source: FACE },
  ];
  document = { ...document, contextReferences: links };
  useAppStore.getState().openAssembly(document, base.library);
  useAppStore.setState({ selection: [a.id], isComputing: false, assemblyView: { sourceDocument: document,
    resolved: { parts: new Map(), errors: [], placements: new Map([[a.id, IDENTITY_PLACEMENT], [b.id, IDENTITY_PLACEMENT]]),
      partKeys: new Map([[a.id, 'a'], [b.id, 'b']]) },
    bodies: new Map([['b', [BODY]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
  return { a, links, bracketRef: bracket.partRef };
}

interface ChangeInput { readonly currentTarget: { readonly value: string } }
interface ProbeProps {
  readonly children?: React.ReactNode;
  readonly onChange?: (event: ChangeInput) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
  readonly onClick?: () => void;
  readonly 'data-testid'?: string;
}

/**
 * 描き直しを再現する useState: 1回の描画の中の呼出し順で状態を覚え、本物の setter から渡された値を次の描画で返す。
 * form は setter に値だけを渡す(関数の更新は使わない)。
 */
async function rerenderingState(): Promise<{ readonly beginRender: () => void }> {
  const actual = await vi.importActual<typeof import('react')>('react');
  const values: unknown[] = [];
  let slot = 0;
  vi.mocked(useState).mockImplementation((initial?: unknown): [unknown, React.Dispatch<React.SetStateAction<unknown>>] => {
    const index = slot;
    slot += 1;
    const [own] = actual.useState(initial);
    if (index >= values.length) values[index] = own;
    return [values[index], (next) => { values[index] = next; }];
  });
  return { beginRender: () => { slot = 0; } };
}

function render(state: { readonly beginRender: () => void }, componentId: string): readonly React.ReactElement<ProbeProps>[] {
  const found: React.ReactElement<ProbeProps>[] = [];
  const walk = (node: React.ReactNode): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isValidElement<ProbeProps>(node)) return;
    found.push(node);
    walk(node.props.children);
  };
  function Probe(): null {
    walk(AssemblyContextReferenceForm({ componentId }));
    return null;
  }
  state.beginRender();
  renderToStaticMarkup(<Probe />);
  return found;
}

function byTestId(elements: readonly React.ReactElement<ProbeProps>[], id: string): React.ReactElement<ProbeProps> {
  const element = elements.find((candidate) => candidate.props['data-testid'] === id);
  if (element === undefined) throw new Error(id);
  return element;
}

function coordinateOf(library: PartLibrary, partRef: string, pointId: string): readonly number[] {
  const part = library.parts.get(partRef);
  const feature = part === undefined ? undefined : findReference(part, pointId);
  if (feature?.kind !== 'referencePoint' || feature.definition.kind !== 'coordinate' || feature.definition.at.mode !== 'absolute') {
    throw new Error(pointId);
  }
  return [feature.definition.at.x.value, feature.definition.at.y.value, feature.definition.at.z.value];
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  vi.mocked(useState).mockImplementation(actual.useState);
  vi.restoreAllMocks();
  resetTestStore();
});

describe('assembly context reference form: select change and re-render through the real handlers', () => {
  it('after changing the point to point-2 and re-rendering, update recomputes only the point-2 link', async () => {
    const s = await open();
    const state = await rerenderingState();
    const first = render(state, s.a.id);
    byTestId(first, 'assembly-context-point').props.onChange?.({ currentTarget: { value: 'point-2' } });
    const second = render(state, s.a.id);
    expect(byTestId(second, 'assembly-context-point').props).toMatchObject({ value: 'point-2' });
    const before = useAppStore.getState().assembly;
    byTestId(second, 'assembly-context-update').props.onClick?.();
    await vi.waitFor(() => { expect(useAppStore.getState().assembly).not.toBe(before); });
    const library = useAppStore.getState().assemblyLibrary;
    coordinateOf(library, s.bracketRef, 'point-2').forEach((coordinate, axis) =>
      expect(Math.abs(coordinate - [5, 0, 0][axis])).toBeLessThanOrEqual(1e-9));
    expect(coordinateOf(library, s.bracketRef, 'point-1')).toEqual([0, 0, 0]);
    expect(useAppStore.getState().assembly?.contextReferences?.map((link) => link.id)).toEqual(['context-1', 'context-2']);
  });

  it('after re-selecting point and face, submit replaces the selected point link under the same id and keeps the other', async () => {
    expect(createSubShapeReference(BODY, 'face', 0)).not.toBeNull();
    const { origins, ...missingProof } = BODY;
    expect(origins?.state).toBe('tracked');
    expect(createSubShapeReference(missingProof, 'face', 0)).toBeNull();
    const s = await open();
    const state = await rerenderingState();
    const first = render(state, s.a.id);
    byTestId(first, 'assembly-context-point').props.onChange?.({ currentTarget: { value: 'point-2' } });
    byTestId(render(state, s.a.id), 'assembly-context-face').props.onChange?.({ currentTarget: { value: 'extrude-1:0' } });
    const ready = render(state, s.a.id);
    expect(byTestId(ready, 'assembly-context-face').props).toMatchObject({ value: 'extrude-1:0' });
    const before = useAppStore.getState().assembly;
    byTestId(ready, 'assembly-context-form').props.onSubmit?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => { expect(useAppStore.getState().assembly).not.toBe(before); });
    const after = useAppStore.getState().assembly?.contextReferences ?? [];
    expect(after.map((link) => link.id)).toEqual(['context-1', 'context-2']);
    expect(after[0]).toBe(s.links[0]);
    expect(after[1]?.targetReferenceId).toBe('point-2');
    const library = useAppStore.getState().assemblyLibrary;
    expect(coordinateOf(library, s.bracketRef, 'point-1')).toEqual([0, 0, 0]);
    coordinateOf(library, s.bracketRef, 'point-2').forEach((coordinate, axis) =>
      expect(Math.abs(coordinate - [5, 0, 0][axis])).toBeLessThanOrEqual(1e-9));
  });
});

interface ProbeProps { readonly role?: string }

describe('EX18 context refusal through form handlers and the real store', () => {
  it.each(['sourceComponentMissing', 'sourceUnresolved', 'cyclicReference', 'targetPartShared'] as const)(
    '%s shows the specific reason and preserves document, placements and Undo/Redo stacks', async code => {
      const { CONTEXT_REFERENCE_REJECTION_MESSAGES } = await import('./AssemblyContextReferenceForm.js');
      const { runContextReferenceCommit } = await import('./contextReferenceCommand.js');
      const { t } = await import('../i18n/t.js');
      const s = await open(), store = useAppStore.getState();
      if (store.assembly === null || store.assemblyView === null) throw new Error('EX18 assembly view missing');
      let document = store.assembly;
      const sourceId = s.links[0].sourceComponentId;
      if (code === 'sourceComponentMissing') document = { ...document,
        components: document.components.filter(component => component.id !== sourceId) };
      if (code === 'cyclicReference') document = { ...document, contextReferences: [{
        ...s.links[0], id: 'reverse-link', targetComponentId: sourceId, sourceComponentId: s.a.id,
      }] };
      if (code === 'targetPartShared') document = addComponent({ ...document, contextReferences: [] },
        createComponentFor(document, { kind: 'part', partRef: s.bracketRef }));
      // Keep non-empty undo and redo history so refusal cannot silently clear either stack.
      document = { ...document, name: 'refusal candidate' };
      store.applyAssembly(document, store.assemblyLibrary);
      useAppStore.getState().applyAssembly({ ...document, name: 'future document' }, store.assemblyLibrary);
      useAppStore.getState().undoAssembly();
      useAppStore.setState({ isComputing: false, assemblyView: { ...store.assemblyView, sourceDocument: document,
        bodies: code === 'sourceUnresolved' ? new Map() : store.assemblyView.bodies } });
      const before = useAppStore.getState();
      if (before.assemblyUndoStack === null) throw new Error('EX18 assembly Undo history missing');
      expect(before.assemblyUndoStack.past.length).toBeGreaterThan(0);
      expect(before.assemblyUndoStack.future.length).toBeGreaterThan(0);
      const snapshot = JSON.stringify([before.assembly, before.assemblyLibrary.partFiles,
        [...before.assemblyLibrary.parts], [...before.assemblyLibrary.attachments], before.assemblyUndoStack]);
      const state = await rerenderingState();
      let elements = render(state, s.a.id);
      if (code === 'cyclicReference' || code === 'targetPartShared') {
        // Create a new link through the actual submit handler; the cycle must be refused on addition.
        byTestId(elements, 'assembly-context-face').props.onChange?.({ currentTarget: { value: 'extrude-1:0' } });
        elements = render(state, s.a.id);
        byTestId(elements, 'assembly-context-form').props.onSubmit?.({ preventDefault: vi.fn() });
      } else byTestId(elements, 'assembly-context-update').props.onClick?.();
      await vi.waitFor(() => {
        const alert = render(state, s.a.id).find(element => element.props.role === 'alert');
        expect(alert?.props.children).toBe(t(CONTEXT_REFERENCE_REJECTION_MESSAGES[code]));
      });
      // The command exposes the same model code; the form does not guess a reason from its selections.
      expect(await runContextReferenceCommit(useAppStore.getState, s.links[0]))
        .toEqual({ status: 'rejected', rejection: { code, linkId: s.links[0].id } });
      const after = useAppStore.getState();
      expect(after.assembly).toBe(before.assembly); expect(after.assembly?.components).toBe(before.assembly?.components);
      expect(after.assemblyLibrary).toBe(before.assemblyLibrary); expect(after.assemblyView).toBe(before.assemblyView);
      expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(JSON.stringify([after.assembly, after.assemblyLibrary.partFiles, [...after.assemblyLibrary.parts],
        [...after.assemblyLibrary.attachments], after.assemblyUndoStack])).toBe(snapshot);
    },
  );
});
