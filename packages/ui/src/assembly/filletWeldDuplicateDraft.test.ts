import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, createAssemblyDocument, createComponentFor, weldSegmentsOf,
  type AssemblyDocument, type MateSubShapeGeometry, type MateTarget, type Placement, type SubShapeRef, type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { filletWeldStatus } from '../shell/statusText.js';
import { TEE_PLANE_BODIES } from './filletWeldBodies.testSupport.js';
import {
  appendFilletWeldPick, commitFilletWeldDraft, createFilletWeldDraft, createFilletWeldEditDraft, previewFilletWeldDraft,
  type AssemblyFilletWeldDraft, type FilletWeldDraftContext,
} from './filletWeldDraft.js';

const REVISIONS: ReadonlyMap<string, string> = new Map([['standing', 'rev-s'], ['base', 'rev-b']]);

function placement(position: Vec3): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation: [0, 0, 0, 1] };
}

/** The same tee as filletWeldDraft.test.ts: standing plate at (0,26,10) on the base top z=10. */
function tee(): AssemblyDocument {
  let document = createAssemblyDocument('溶接');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'standing' }, { placement: placement([0, 26, 10]) }));
  return addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'base' }, { placement: placement([0, 0, 0]) }));
}

function ref(index: number, kind: 'face' | 'edge'): SubShapeRef {
  return { bodyFeatureId: 'extrude-1', index, fingerprint: kind === 'face'
    ? { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null }
    : { kind: 'edge', curveKind: 'line', length: 1, position: [0, 0, 0], axis: [1, 0, 0], radius: null } };
}

function target(componentId: string, index: number, kind: 'face' | 'edge'): MateTarget {
  return { kind: 'subShape', componentId, ref: ref(index, kind) };
}

const SHAPES = new Map<string, MateSubShapeGeometry>([
  ['component-1:1', { kind: 'face', surfaceKind: 'plane', area: 5000, position: [50, 8, 25], axis: [0, 1, 0], radius: null }],
  ['component-1:2', { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null }],
  ['component-2:3', { kind: 'face', surfaceKind: 'plane', area: 6000, position: [50, 30, 10], axis: [0, 0, 1], radius: null }],
]);

function context(document: AssemblyDocument): FilletWeldDraftContext {
  return { document, partRevisions: REVISIONS, bodiesOf: TEE_PLANE_BODIES,
    resolve: (component, reference) => SHAPES.get(`${component.id}:${String(reference.index)}`) ?? null };
}

function picked(patch: Partial<AssemblyFilletWeldDraft> = {}): AssemblyFilletWeldDraft {
  let draft = createFilletWeldDraft('doc');
  for (const pick of [target('component-1', 1, 'face'), target('component-1', 2, 'edge'), target('component-2', 3, 'face')]) {
    draft = appendFilletWeldPick(draft, pick) ?? draft;
  }
  return { ...draft, legOnSecondSource: '6', legOnFirstSource: '8', materialId: 'steel', ...patch };
}

/** Commit one weld through the public draft, as the user does. */
function weldedThroughDraft(draft: AssemblyFilletWeldDraft): AssemblyDocument {
  const document = tee();
  const preview = previewFilletWeldDraft(context(document), draft);
  if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
  const committed = commitFilletWeldDraft(context(document), draft, preview.result.plan);
  if (!committed.ok) throw new Error(JSON.stringify(committed));
  return committed.document;
}

describe('the public weld draft refuses a second weld over an existing weld on the same contact', () => {
  it('previews the overlap reason with its Japanese text and does not let the same weld be committed twice', () => {
    const document = weldedThroughDraft(picked());
    const preview = previewFilletWeldDraft(context(document), picked());
    expect(preview.kind === 'plan' && !preview.result.ok
      ? preview.result.rejections.map((rejection) => [rejection.code, rejection.detail.weldId]) : preview)
      .toEqual([['overlapsExistingWeld', 'weld-1']]);
    expect(t('assembly.filletWeld.reason.overlapsExistingWeld')).toBe(
      'この当たりには既に別の溶接のビードがあり、区間が重なります。重ならない区間にするか、既にある溶接を直してください。');
    expect(filletWeldStatus(picked(), preview)).toEqual({ failed: true,
      text: t('assembly.status.filletWeldIssue').replace('{reason}', t('assembly.filletWeld.reason.overlapsExistingWeld')) });
    expect([...weldSegmentsOf(document).keys()]).toEqual(['weld-1']);
  });

  it('accepts a second intermittent weld whose beads lie in the gaps of the first', () => {
    const document = weldedThroughDraft(picked({ mode: 'intermittent', startSource: '10', lengthsSource: '20, 15', gapsSource: '20' }));
    const gaps = picked({ mode: 'intermittent', startSource: '30', lengthsSource: '20, 10', gapsSource: '15' });
    const preview = previewFilletWeldDraft(context(document), gaps);
    if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
    const committed = commitFilletWeldDraft(context(document), gaps, preview.result.plan);
    if (!committed.ok) throw new Error(JSON.stringify(committed));
    expect([...weldSegmentsOf(committed.document).keys()]).toEqual(['weld-1', 'weld-2']);
  });

  it('keeps editing the saved weld through its edit draft (the weld is not compared with itself)', () => {
    const document = weldedThroughDraft(picked());
    const edit = createFilletWeldEditDraft('doc', document, 'weld-1');
    if (edit === null) throw new Error('edit draft missing');
    const preview = previewFilletWeldDraft(context(document), { ...edit, legOnFirstSource: '7' });
    expect(preview.kind === 'plan' && preview.result.ok ? preview.result.plan.weldId : preview).toBe('weld-1');
  });
});
