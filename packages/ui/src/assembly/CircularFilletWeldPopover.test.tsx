import { createAssemblyDocument, EMPTY_PART_LIBRARY, resolveAssembly, type JointOccurrenceCommandContext, type SubShapeRef } from '@pointercad/model';
import { expressionValueFromNumber as number } from '@pointercad/expression';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { createCircularFilletWeldDraft, type CircularDraftPick, type CircularDraftPreview, type CircularFilletWeldDraft } from './circularFilletWeldDraft.js';
import { CircularFilletWeldPopover, type CircularFilletWeldPopoverProps } from './CircularFilletWeldPopover.js';

interface KeyInput {
  readonly key: string;
  readonly nativeEvent: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}
interface FormHandlers {
  readonly children: ReactNode;
  readonly onKeyDown: (event: KeyInput) => void;
  readonly onSubmit: (event: { readonly preventDefault: () => void }) => void;
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: () => void;
  readonly onPointerDownCapture: () => void;
}
interface ValueHandlers { readonly onChange: (event: { readonly currentTarget: { readonly value: string } }) => void }
interface ButtonHandlers { readonly onClick: () => void }
function formHandlers(props: CircularFilletWeldPopoverProps): FormHandlers {
  let handlers: FormHandlers | undefined;
  function Probe(): null {
    const tree = CircularFilletWeldPopover(props);
    if (isValidElement<FormHandlers>(tree)) handlers = tree.props;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (handlers === undefined) throw new Error('Circular form missing');
  return handlers;
}
function control<T>(node: ReactNode, id: string): T {
  function find(value: ReactNode): T | undefined {
    for (const child of Children.toArray(value)) {
      if (!isValidElement<{ readonly children?: ReactNode; readonly 'data-testid'?: string }>(child)) continue;
      if (child.props['data-testid'] === id && isValidElement<T>(child)) return child.props;
      const result = find(child.props.children); if (result !== undefined) return result;
    }
    return undefined;
  }
  const result = find(node); if (result === undefined) throw new Error('Control missing: ' + id); return result;
}
function key(form: FormHandlers, value: string, keyCode = 0, isComposing = false) {
  const preventDefault = vi.fn(), stopPropagation = vi.fn();
  form.onKeyDown({ key: value, nativeEvent: { key: value, keyCode, isComposing }, preventDefault, stopPropagation });
  return { preventDefault, stopPropagation };
}
function fixture() {
  const document = createAssemblyDocument('circular-ui');
  const face = (surfaceKind: 'plane' | 'cylinder'): SubShapeRef => ({ bodyFeatureId: surfaceKind, index: 0,
    fingerprint: { kind: 'face', surfaceKind, area: 100, position: [0, 0, 0], axis: [0, 0, 1], radius: surfaceKind === 'cylinder' ? 10 : null } });
  const picks: readonly CircularDraftPick[] = [{ path: ['plane'], reference: face('plane') },
    { path: ['cylinder'], reference: { bodyFeatureId: 'cylinder', index: 0,
      fingerprint: { kind: 'edge', curveKind: 'circle', length: 20 * Math.PI, position: [0, 0, 0], axis: [0, 0, 1], radius: 10 } } },
    { path: ['cylinder'], reference: face('cylinder') }];
  const draft: CircularFilletWeldDraft = { ...createCircularFilletWeldDraft(document, 'circle-weld', 'ui-1'), picks,
    radialLeg: '3', normalLeg: '4', radialDirection: 1, normalDirection: 1, materialId: 'steel' };
  const inputs = { document, library: EMPTY_PART_LIBRARY, subAssemblies: new Map<string, ReturnType<typeof createAssemblyDocument>>() };
  const view = { source: inputs, resolved: resolveAssembly(document, { library: inputs.library, subAssemblies: inputs.subAssemblies }) };
  const context: JointOccurrenceCommandContext = { inputs, view, bodiesOf: () => null, partDocument: () => null,
    resolveFace: () => { throw new Error('No geometry execution in form tests'); },
    resolveWeldGeometry: () => { throw new Error('No straight-weld fallback'); } };
  const plane = { ...picks[0], sourceKey: 'plane-source', bodyKey: 'plane-body', placementKey: 'plane-pose' };
  const cylinder = { ...picks[2], sourceKey: 'cylinder-source', bodyKey: 'cylinder-body', placementKey: 'cylinder-pose' };
  const request = { operation: 'create' as const, weldId: draft.weldId, draftEpoch: draft.draftEpoch, plane, edge: picks[1], cylinder,
    intervals: [{ beadId: 'one', fromParameter: 0, toParameter: Math.PI / 2 }, { beadId: 'two', fromParameter: Math.PI, toParameter: 3 * Math.PI / 2 }],
    section: { radialLegMm: 3, normalLegMm: 4, radialDirection: 1 as const, normalDirection: 1 as const }, materialId: 'steel' };
  // Typed display/handler fixture only, never passed to a planner/apply/native admission.
  const preview: Extract<CircularDraftPreview, { readonly ok: true }> = { ok: true, draft, context, request,
    plan: { request, beads: ['one', 'two'].map((id): Extract<CircularDraftPreview, { readonly ok: true }>['plan']['beads'][number] => ({ source: { kind: 'standardPart', catalog: 'filletWeld', size: id,
      options: {}, catalogRevision: 'ui-fixture', generatorRevision: 'ui-fixture' },
      placement: { position: [number(0), number(0), number(0)], rotation: [0, 0, 0, 1] }, materialId: 'steel' })),
    replacedComponentIds: [], connectionIndex: null,
    contacts: ['one', 'two'].map(beadId => ({ beadId, planeAreaMm2: 1, cylinderAreaMm2: 1, coveredRatio: 1 })),
    identity: 'ui-plan', state: 'ui-state', inputs, view, resolved: view.resolved } };
  const props: CircularFilletWeldPopoverProps = { draft, preview, onChange: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn(), onReselect: vi.fn() };
  return { document, draft, preview, props };
}

describe('CircularFilletWeldPopover real SSR form handlers', () => {
  it.each([['Enter', 13, true], ['Escape', 27, true], ['Enter', 229, false], ['Escape', 229, false], ['Process', 0, false]] as const)(
    'does not commit/cancel or consume IME %s code %i composing %s', (value, code, composing) => {
      const f = fixture(), form = formHandlers(f.props), event = key(form, value, code, composing), preventDefault = vi.fn();
      form.onSubmit({ preventDefault });
      expect(f.props.onCommit).not.toHaveBeenCalled(); expect(f.props.onCancel).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalledOnce();
    });
  it('rejects the composition-ending submit then accepts the next normal Enter exactly once', () => {
    const f = fixture(), form = formHandlers(f.props);
    form.onCompositionStart(); key(form, 'Enter', 13); form.onCompositionEnd(); form.onSubmit({ preventDefault: vi.fn() });
    expect(f.props.onCommit).not.toHaveBeenCalled();
    key(form, 'Enter', 13); form.onSubmit({ preventDefault: vi.fn() }); form.onSubmit({ preventDefault: vi.fn() });
    expect(f.props.onCommit).toHaveBeenCalledExactlyOnceWith(f.draft, f.preview);
  });
  it('rejects an implicit submit after compositionend even without a final keydown event', () => {
    const f = fixture(), form = formHandlers(f.props);
    form.onCompositionStart(); form.onCompositionEnd(); form.onSubmit({ preventDefault: vi.fn() });
    expect(f.props.onCommit).not.toHaveBeenCalled();
  });
  it('accepts one pointer commit after composition but never while composing', () => {
    const f = fixture(), form = formHandlers(f.props);
    form.onCompositionStart(); key(form, 'Enter', 229); form.onPointerDownCapture(); form.onSubmit({ preventDefault: vi.fn() });
    expect(f.props.onCommit).not.toHaveBeenCalled();
    form.onCompositionEnd(); form.onPointerDownCapture(); form.onSubmit({ preventDefault: vi.fn() });
    expect(f.props.onCommit).toHaveBeenCalledExactlyOnceWith(f.draft, f.preview);
  });
  it('normal Escape calls cancel once and never mutates the supplied document or draft', () => {
    const f = fixture(), before = JSON.stringify(f.document), draftBefore = JSON.stringify(f.draft), form = formHandlers(f.props);
    const event = key(form, 'Escape', 27); key(form, 'Escape', 27);
    expect(f.props.onCancel).toHaveBeenCalledOnce(); expect(f.props.onCommit).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.document)).toBe(before); expect(JSON.stringify(f.draft)).toBe(draftBefore);
  });
  it('blocks a preview from an earlier draft object and hides its plan', () => {
    const f = fixture(), props = { ...f.props, draft: { ...f.draft, radialLeg: '5', draftEpoch: 'ui-2' } };
    formHandlers(props).onSubmit({ preventDefault: vi.fn() });
    expect(f.props.onCommit).not.toHaveBeenCalled();
    const markup = renderToStaticMarkup(<CircularFilletWeldPopover {...props} />);
    expect(markup).not.toContain('data-testid="circular-weld-plan"');
    expect(markup).toMatch(/<button[^>]*data-testid="circular-weld-commit"[^>]*disabled=""/u);
  });
  it('invalidates commit immediately after input before a parent update can arrive', () => {
    const f = fixture(), form = formHandlers(f.props);
    control<ValueHandlers>(form.children, 'circular-weld-radialLeg').onChange({ currentTarget: { value: '' } });
    form.onSubmit({ preventDefault: vi.fn() });
    expect(f.props.onChange).toHaveBeenCalledExactlyOnceWith({ radialLeg: '' }); expect(f.props.onCommit).not.toHaveBeenCalled();
  });
  it('invalidates the current plan while reselecting and forwards only the callback', () => {
    const f = fixture(), form = formHandlers(f.props);
    control<ButtonHandlers>(form.children, 'circular-weld-reselect').onClick(); form.onSubmit({ preventDefault: vi.fn() });
    expect(f.props.onReselect).toHaveBeenCalledOnce(); expect(f.props.onCommit).not.toHaveBeenCalled(); expect(f.props.onChange).not.toHaveBeenCalled();
  });
  it('forwards independent intermittent expression lists as distinct unchanged patches', () => {
    const f = fixture(), form = formHandlers({ ...f.props, draft: { ...f.draft, mode: 'intermittent' } });
    for (const [field, value] of [['start', '2+1'], ['lengths', '3, 2*4'], ['gaps', '1/2']] as const)
      control<ValueHandlers>(form.children, `circular-weld-${field}`).onChange({ currentTarget: { value } });
    expect(f.props.onChange).toHaveBeenNthCalledWith(1, { start: '2+1' });
    expect(f.props.onChange).toHaveBeenNthCalledWith(2, { lengths: '3, 2*4' });
    expect(f.props.onChange).toHaveBeenNthCalledWith(3, { gaps: '1/2' });
  });
  it('keeps empty legs, directions and material unselected with labelled, titled native fields', () => {
    const f = fixture(), draft = createCircularFilletWeldDraft(f.document, 'empty', 'empty-1');
    const props = { ...f.props, draft: { ...draft, mode: 'intermittent' as const }, preview: null };
    const markup = renderToStaticMarkup(<CircularFilletWeldPopover {...props} />);
    expect((markup.match(/<option value="" selected="">/gu) ?? [])).toHaveLength(3);
    expect(markup).toContain('data-testid="circular-weld-radialLeg" title=');
    expect(markup).toContain(t('assembly.circularFilletWeld.intervalsHint'));
    const labels = [...markup.matchAll(/<label class="pcad-field">([\s\S]*?)<\/label>/gu)];
    expect(labels).toHaveLength(9);
    for (const match of labels) { expect(match[1]).toContain('pcad-field__label'); expect(match[1]).toMatch(/<(input|select)\b[^>]*title="[^"]+"/u); }
    expect(markup).toMatch(/data-testid="circular-weld-commit"[^>]*disabled=""/u);
    expect(f.props.onChange).not.toHaveBeenCalled(); expect(props.draft.radialLeg).toBe(''); expect(props.draft.radialDirection).toBeNull();
  });
  it('preserves clearing both directions and material instead of inventing defaults', () => {
    const f = fixture(), form = formHandlers(f.props);
    for (const id of ['radialDirection', 'normalDirection', 'material'])control<ValueHandlers>(form.children, 'circular-weld-' + id).onChange({ currentTarget: { value: '' } });
    expect(f.props.onChange).toHaveBeenNthCalledWith(1, { radialDirection: null });
    expect(f.props.onChange).toHaveBeenNthCalledWith(2, { normalDirection: null });
    expect(f.props.onChange).toHaveBeenNthCalledWith(3, { materialId: '' });
  });
  it('guides saved editing through plane, circular edge and cylindrical-face reselection', () => {
    const f = fixture(), props = { ...f.props, draft: { ...f.draft, operation: 'replace' as const, picks: [] }, preview: null };
    const markup = renderToStaticMarkup(<CircularFilletWeldPopover {...props} />);
    expect(markup).toContain(t('assembly.circularFilletWeld.editGuide')); expect(markup).toContain(t('assembly.circularFilletWeld.pickPlane'));
    expect(markup).not.toContain('circular-weld-remove'); expect(markup).not.toContain('aria-modal="true"');
    formHandlers(props).onSubmit({ preventDefault: vi.fn() }); expect(f.props.onCommit).not.toHaveBeenCalled();
  });
  it('shows the authoritative bead count and contact state without claiming strength', () => {
    const f = fixture(), markup = renderToStaticMarkup(<CircularFilletWeldPopover {...f.props} />);
    expect(markup).toContain(`${t('assembly.filletWeld.segmentCount')} 2`);
    expect(markup).toContain(t('assembly.circularFilletWeld.contactConfirmed')); expect(markup).toContain(t('assembly.filletWeld.strengthNote'));
    expect(markup).toContain(t('assembly.circularFilletWeld.fullCircleHint'));
    expect(markup).toContain(t('assembly.circularFilletWeld.outward')); expect(markup).toContain(t('assembly.circularFilletWeld.positive'));
    // Two independent quarter circles: total length 10*pi; area 6 times centroid radius 11 gives volume 66*pi.
    expect(markup).toContain(`${t('assembly.filletWeld.totalLength')} 31.416`);
    expect(markup).toContain(`${t('assembly.circularFilletWeld.nominalVolume')} 207.345`);
  });
  it('displays the inner nominal volume with reversed traversal using the same admitted intervals', () => {
    const f = fixture(), draft: CircularFilletWeldDraft = { ...f.draft, radialDirection: -1 };
    const request = { ...f.preview.request, section: { ...f.preview.request.section, radialDirection: -1 as const },
      intervals: f.preview.request.intervals.map(row => ({ ...row, fromParameter: row.toParameter, toParameter: row.fromParameter })) };
    const preview: Extract<CircularDraftPreview, { readonly ok: true }> = { ...f.preview, draft, request, plan: { ...f.preview.plan, request } };
    const markup = renderToStaticMarkup(<CircularFilletWeldPopover {...f.props} draft={draft} preview={preview} />);
    // Area 6 times centroid radius 9 times total angle pi = 54*pi mm3, independently fixed.
    expect(markup).toContain(`${t('assembly.circularFilletWeld.nominalVolume')} 169.646`);
    expect(markup).toContain(`${t('assembly.filletWeld.totalLength')} 31.416`);
  });
});
