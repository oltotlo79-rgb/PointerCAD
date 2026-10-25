import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, appendReference, type AssemblyDocument, type ContextReferenceLink, createAssemblyDocument,
  createComponentFor, createEmptyPartDocument, embedPart, IDENTITY_PLACEMENT, type PartLibrary,
  type ReferencePointFeature, type SolidBody, type SubShapeRef,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { AssemblyContextReferenceForm, contextLinkToCommit } from './AssemblyContextReferenceForm.js';
import { AssemblyPropertyPanel } from './AssemblyPropertyPanel.js';

function point(id: string, name: string): ReferencePointFeature {
  return { id, name, visible: true, kind: 'referencePoint', definition: { kind: 'coordinate', at: { mode: 'absolute',
    x: expressionValueFromNumber(0), y: expressionValueFromNumber(0), z: expressionValueFromNumber(0) } } };
}

/** 元(B)の今のボディ。面0(円筒)の中心が部品の座標で (5,0,0)。 */
const BODY: SolidBody = { featureId: 'extrude-1', mesh: { positions: new Float32Array([0, 0, 0, 10, 10, 10]),
  normals: new Float32Array(), indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
volume: 1, isValid: true, edges: [], vertices: [], threadMarks: [],
faces: [{ index: 0, surfaceKind: 'cylinder', area: 10, centroid: [5, 0, 0], axis: [0, 0, 1], radius: 2,
  triangleOffset: 0, triangleCount: 0 }] };
const FACE: SubShapeRef = { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'face', surfaceKind: 'cylinder',
  area: 10, position: [5, 0, 0], axis: [0, 0, 1], radius: 2 } };

async function open(options: { readonly withView?: boolean; readonly links?: boolean } = {}) {
  const empty: PartLibrary = { partFiles: [], parts: new Map(), attachments: new Map() };
  const bracket = await embedPart(empty, appendReference(appendReference(createEmptyPartDocument(), point('point-1', 'hole centre')),
    point('point-2', 'end point')), 'a.pcad', 'a.pcad');
  const base = await embedPart(bracket.library, createEmptyPartDocument(), 'b.pcad', 'b.pcad');
  let document: AssemblyDocument = createAssemblyDocument('screen');
  const a = createComponentFor(document, { kind: 'part', partRef: bracket.partRef });
  document = addComponent(document, a);
  const b = createComponentFor(document, { kind: 'part', partRef: base.partRef });
  document = addComponent(document, b);
  const links: readonly ContextReferenceLink[] = [
    { id: 'context-1', targetComponentId: a.id, targetReferenceId: 'point-1', sourceComponentId: b.id, source: FACE },
    { id: 'context-2', targetComponentId: a.id, targetReferenceId: 'point-2', sourceComponentId: b.id, source: FACE },
  ];
  if (options.links === true) document = { ...document, contextReferences: links };
  useAppStore.getState().openAssembly(document, base.library);
  useAppStore.setState({ selection: [a.id], isComputing: false, assemblyView: options.withView === false ? null : {
    sourceDocument: document,
    resolved: { parts: new Map(), errors: [], placements: new Map([[a.id, IDENTITY_PLACEMENT], [b.id, IDENTITY_PLACEMENT]]),
      partKeys: new Map([[a.id, 'a'], [b.id, 'b']]) },
    bodies: new Map([['b', [BODY]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
  return { a, b, document, links };
}

interface KeyInput {
  readonly key: string;
  readonly nativeEvent: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>;
  readonly preventDefault: () => void;
}
interface ProbeProps {
  readonly children?: React.ReactNode;
  readonly onKeyDown?: (event: KeyInput) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
  readonly onClick?: () => void;
  readonly 'data-testid'?: string;
}

/** 既存の popover の試験と同じ探り方: 本物の form を描き、要素の props(本物の handler)を取り出す。 */
function formTree(componentId: string): readonly React.ReactElement<ProbeProps>[] {
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
  renderToStaticMarkup(<Probe />);
  return found;
}

function keyDown(form: React.ReactElement<ProbeProps>, keyCode: number, isComposing: boolean): boolean {
  const preventDefault = vi.fn();
  form.props.onKeyDown?.({ key: 'Enter', nativeEvent: { key: 'Enter', keyCode, isComposing }, preventDefault });
  return preventDefault.mock.calls.length > 0;
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('assembly context reference form', () => {
  it('shows the selected component form with point, source component and current face', async () => {
    const { b } = await open();
    const html = renderToStaticMarkup(<AssemblyPropertyPanel />);
    expect(html).toContain('data-testid="assembly-context-form"');
    expect(html).toContain('hole centre');
    expect(html).toContain(b.name);
    expect(html).toContain(`extrude-1 ${t('assembly.context.face')} 1`);
    expect(html).toMatch(/<button type="submit"[^>]*disabled/);
  });

  it('hides without a current view and disables selection during computing', async () => {
    const { a } = await open({ withView: false });
    expect(renderToStaticMarkup(<AssemblyContextReferenceForm componentId={a.id} />)).toBe('');
    const second = await open();
    useAppStore.setState({ isComputing: true });
    expect(renderToStaticMarkup(<AssemblyContextReferenceForm componentId={second.a.id} />)).toMatch(/<select[^>]*disabled/);
  });

  it('chooses links per point without replacing another point link', async () => {
    const { a, b, document } = await open({ links: true });
    expect(contextLinkToCommit(document, a.id, 'point-2', b.id, FACE).id).toBe('context-2');
    expect(contextLinkToCommit(document, a.id, 'point-1', b.id, FACE).id).toBe('context-1');
    expect(contextLinkToCommit(document, a.id, 'point-3', b.id, FACE).id).toBe('context-3');
  });

  it('updates only the shown point link while retaining the other link object', async () => {
    const { a, links } = await open({ links: true });
    const update = formTree(a.id).find(element => element.props['data-testid'] === 'assembly-context-update');
    if (update === undefined) throw new Error('update button');
    const before = useAppStore.getState().assembly;
    update.props.onClick?.();
    // 確定は部品の一式のハッシュを待ってから1回だけ書く。
    await vi.waitFor(() => { expect(useAppStore.getState().assembly).not.toBe(before); });
    const after = useAppStore.getState().assembly?.contextReferences ?? [];
    expect(after.map(link => link.id)).toEqual(['context-1', 'context-2']);
    expect(after[1]).toBe(links[1]);
  });

  it('ignores composing Enter and leaves the document unchanged when no face is selected', async () => {
    const { a } = await open();
    const form = formTree(a.id).find(element => element.props['data-testid'] === 'assembly-context-form');
    if (form === undefined) throw new Error('form');
    expect(keyDown(form, 13, true)).toBe(true);
    expect(keyDown(form, 229, false)).toBe(true);
    expect(keyDown(form, 13, false)).toBe(false);
    const before = useAppStore.getState().assembly;
    form.props.onSubmit?.({ preventDefault: vi.fn() });
    await Promise.resolve();
    expect(useAppStore.getState().assembly).toBe(before);
  });
});

describe('EX18 context refusal translations', () => {
  it('maps every specific model code one-to-one to a distinct Japanese reason', async () => {
    const { CONTEXT_REFERENCE_REJECTION_MESSAGES } = await import('./AssemblyContextReferenceForm.js');
    const messages = (await import('../i18n/ja/assembly.json')).default;
    const expected = {
      targetComponentMissing: messages['assembly.context.reason.targetComponentMissing'],
      sourceComponentMissing: messages['assembly.context.reason.sourceComponentMissing'],
      targetNotEmbeddedPart: messages['assembly.context.reason.targetNotEmbeddedPart'],
      samePart: messages['assembly.context.reason.samePart'],
      targetReferenceMissing: messages['assembly.context.reason.targetReferenceMissing'],
      targetReferenceNotPoint: messages['assembly.context.reason.targetReferenceNotPoint'],
      sourceUnresolved: messages['assembly.context.reason.sourceUnresolved'],
      invalidPlacement: messages['assembly.context.reason.invalidPlacement'],
      cyclicReference: messages['assembly.context.reason.cyclicReference'],
      unsupportedSource: messages['assembly.context.reason.unsupportedSource'],
      targetPartShared: messages['assembly.context.reason.targetPartShared'],
      duplicateTarget: messages['assembly.context.reason.duplicateTarget'],
    } satisfies Record<import('@pointercad/model').ContextReferenceRejectionCode, string>;
    const keys = Object.values(CONTEXT_REFERENCE_REJECTION_MESSAGES);
    expect(Object.keys(CONTEXT_REFERENCE_REJECTION_MESSAGES).sort()).toEqual(Object.keys(expected).sort());
    expect(Object.keys(messages).filter(key => key.startsWith('assembly.context.reason.')).sort()).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(12); expect(new Set(keys.map(key => t(key))).size).toBe(12);
    for (const [code, text] of Object.entries(expected)) {
      const entry = Object.entries(CONTEXT_REFERENCE_REJECTION_MESSAGES).find(([key]) => key === code);
      if (entry === undefined) throw new Error(`Missing refusal translation: ${code}`);
      expect(t(entry[1])).toBe(text); expect(t(entry[1])).not.toBe(t('assembly.context.rejected'));
    }
  });
});
