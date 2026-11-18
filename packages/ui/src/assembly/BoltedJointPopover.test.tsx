import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addComponent, createAssemblyDocument, createComponentFor, type BoltedJointPlan, type MateTarget } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
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

describe('まとめて締結する時の窓(J-02 P4)', () => {
  const face = (componentId: string, index: number): Extract<MateTarget, { readonly kind: 'subShape' }> => ({ kind: 'subShape',
    componentId, ref: { bodyFeatureId: 'body',
    index, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null } } });
  function readyPlan(): BoltedJointPlan {
    const preview = useAppStore.getState().assemblyBoltedJointPreview;
    if (preview?.kind !== 'plan' || !preview.result.ok) throw new Error('fixture plan');
    return preview.result.plan;
  }
  const commitDisabled = (markup: string): boolean => /<button type="submit"[^>]*disabled=""/u.test(markup);
  /** 4 面と 2 組目の穴を選んだ下書きに、組ごとの計画を並べた予告を置いて描く。 */
  function renderSet(joints: readonly BoltedJointPlan[]): string {
    const draft = useAppStore.getState().assemblyBoltedJointDraft;
    if (draft === null) throw new Error('draft');
    useAppStore.setState({
      assemblyBoltedJointDraft: { ...draft, picks: [face('component-1', 1), face('component-1', 2), face('component-2', 1),
        face('component-2', 2)], extraHoles: { first: [face('component-1', 3)], second: [face('component-2', 3)] } },
      assemblyBoltedJointPreview: { kind: 'set', result: { ok: true, plan: {
        joints: joints.map((joint) => ({ joint, headKind: 'socket' as const })) } }, pairs: [] },
    });
    return renderToStaticMarkup(<BoltedJointPopover />);
  }
  const shownFacts = (markup: string): string[] =>
    Array.from(markup.matchAll(/data-testid="bolted-joint-fact">([^<]*)</gu), (match) => match[1] ?? '');

  it('4 面の後は締結する穴の数と Shift の案内、提案は頭の形と組ごとの長さを出し、確定を押せる', () => {
    const draft = useAppStore.getState().assemblyBoltedJointDraft;
    if (draft === null) throw new Error('draft');
    const plan = readyPlan();
    useAppStore.setState({
      assemblyBoltedJointDraft: { ...draft, picks: [face('component-1', 1), face('component-1', 2), face('component-2', 1),
        face('component-2', 2)], extraHoles: { first: [face('component-1', 3)], second: [face('component-2', 3)] } },
      assemblyBoltedJointPreview: { kind: 'set', result: { ok: true, plan: { joints: [
        { joint: plan, headKind: 'socket' }, { joint: { ...plan, boltLength: 45 }, headKind: 'socket' }] } }, pairs: [] },
    });
    const markup = renderToStaticMarkup(<BoltedJointPopover />);
    expect(markup).toContain(t('assembly.boltedJoint.holeCounts').replace('{first}', '2').replace('{second}', '2'));
    expect(markup).toContain(t('assembly.boltedJoint.addHolesGuide'));
    expect(markup).toContain(`${t('assembly.boltedJoint.head')} ${t('assembly.boltedJoint.head.socket')}`);
    expect(markup.match(/data-testid="bolted-joint-set-row"/gu)).toHaveLength(2);
    expect(markup).toContain(t('assembly.boltedJoint.setRow').replace('{index}', '2').replace('{head}', t('assembly.boltedJoint.head.socket'))
      .replace('{nominal}', 'M8').replace('{length}', '45'));
    expect(commitDisabled(markup)).toBe(false);
  });

  it('未確認の注は全部の組の分を重ねずに出し、1 組目が根拠ありでも 2 組目が根拠なしなら長さの注を出す', () => {
    const verified = readyPlan();
    const unverified: BoltedJointPlan = { ...verified, lengthBasis: 'globalUnverifiedList', lengthVerified: false,
      missingFacts: ['catalogRowUnverified', 'perDiameterLengthAvailability'] };
    expect(shownFacts(renderSet([verified, verified]))).toEqual([]);
    expect(shownFacts(renderSet([verified, unverified, { ...unverified, boltLength: 45 }]))).toEqual([
      t('assembly.boltedJoint.fact.catalogRowUnverified'), t('assembly.boltedJoint.fact.perDiameterLengthAvailability')]);
    expect(shownFacts(renderSet([unverified, verified]))).toEqual([
      t('assembly.boltedJoint.fact.catalogRowUnverified'), t('assembly.boltedJoint.fact.perDiameterLengthAvailability')]);
  });

  it('1 組でも断られたら、組全体の理由と、穴の組の番号・その組の穴を添えた理由を並べ、確定を押せない', () => {
    useAppStore.setState({ assemblyBoltedJointPreview: { kind: 'set', result: { ok: false,
      rejections: [{ code: 'holeCountMismatch', detail: { first: 2, second: 1 } }],
      holes: [{ index: 1, rejections: [], entryRejections: [{ code: 'holeCountMismatch', detail: { first: 2, second: 1 } }] },
        { index: 0, rejections: [{ code: 'unsupportedHole', detail: { reason: 'duplicateHole' } }], entryRejections: [] }] },
    pairs: [{ first: { component: '板A', position: [20, 15, 5] }, second: { component: '板B', position: [0, 15, 5] } },
      { first: { component: '板A', position: [40, 15, 5] }, second: null }] } });
    const markup = renderToStaticMarkup(<BoltedJointPopover />);
    expect(markup).toContain(t('assembly.boltedJoint.reason.holeCountMismatch'));
    const label = (component: string, x: string) => t('assembly.boltedJoint.holeLabel').replace('{component}', component)
      .replace('{x}', x).replace('{y}', '15').replace('{z}', '5');
    expect(markup).toContain(t('assembly.boltedJoint.holeReason').replace('{hole}', '1').replace('{first}', label('板A', '20'))
      .replace('{second}', label('板B', '0')).replace('{reason}', t('assembly.boltedJoint.unsupported.duplicateHole')));
    // 組全体と同じ「組の数」の断りは、穴の組の行として重ねて出さない。
    expect(markup.match(/<li/gu)).toHaveLength(2);
    expect(markup).toContain('data-hole="1"');
    expect(commitDisabled(markup)).toBe(true);
  });
});
